import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Card } from '@turtle/shared';
import { SCHEMA_SQL } from '../../store/schema.js';
import { createRepositories, type Repositories } from '../../store/repositories.js';
import { createCipher } from '../../store/crypto.js';
import {
  createCardService,
  isArchivedStatus,
  ARCHIVE_STATUSES,
  SUPERSEDED_STATUS,
  type CardService,
} from './index.js';

/**
 * Card service and lifecycle (Task 23, R10.1/R10.4/R10.6).
 *
 * Covers:
 *   - emit persists a card from a contract as `active` (R10.1) and enforces
 *     max-one-active across turns by superseding the prior active card (R10.6).
 *   - setStatus performs the lifecycle transitions active → dismissed | done (R10.4)
 *     and returns null for an unknown card.
 *   - list('archived') reads the union of the terminal statuses (R10.4); the stored
 *     statuses read through directly.
 *
 * Runs against an in-memory SQLite store (matching store/contract-validator tests) —
 * no network, no mocks.
 */

/** A minimal contract card the orchestrator would emit. */
function card(title: string, over: Partial<Card> = {}): Card {
  return { type: 'actionable', title, body: `body for ${title}`, ...over };
}

function makeRepos(): Repositories {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return createRepositories(db, createCipher('test-key'));
}

/** Seed a caregiver + session so cards have a valid session_id FK. */
function seedSession(repos: Repositories): string {
  const cg = repos.caregiver.create({ display_name: 'Alex' });
  return repos.session.create(cg.id).id;
}

describe('CardService.emit — persist from contract + max-one-active (R10.1/R10.6)', () => {
  let repos: Repositories;
  let cards: CardService;
  let sessionId: string;
  beforeEach(() => {
    repos = makeRepos();
    cards = createCardService({ repos });
    sessionId = seedSession(repos);
  });

  it('persists a contract card as active with its type/title/body/action', async () => {
    const rec = await cards.emit(
      sessionId,
      card('Call the nurse line', {
        type: 'actionable',
        body: 'Reach the nurse line about the new symptom.',
        action: { kind: 'call', target: 'tel:+15551234' },
      }),
    );

    expect(rec.status).toBe('active');
    expect(rec.session_id).toBe(sessionId);
    expect(rec.type).toBe('actionable');
    expect(rec.title).toBe('Call the nurse line');
    expect(rec.action).toEqual({ kind: 'call', target: 'tel:+15551234' });

    // Round-trips through the store.
    expect(repos.card.get(rec.id)?.title).toBe('Call the nurse line');
  });

  it('keeps at most one active card: emitting a second supersedes the first', async () => {
    const first = await cards.emit(sessionId, card('First'));
    const second = await cards.emit(sessionId, card('Second'));

    const active = await cards.list('active');
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(second.id);

    // The superseded card is archived (→ dismissed), not deleted (R10.4).
    expect(repos.card.get(first.id)?.status).toBe(SUPERSEDED_STATUS);
  });

  it('holds max-one-active across many emits', async () => {
    for (let i = 0; i < 5; i++) await cards.emit(sessionId, card(`card-${i}`));
    expect(await cards.list('active')).toHaveLength(1);
    // The other four all moved to the archive.
    expect(await cards.list('archived')).toHaveLength(4);
  });

  it('preserves a null action for actionless cards', async () => {
    const rec = await cards.emit(sessionId, card('Just retained', { type: 'retained' }));
    expect(rec.action).toBeNull();
  });
});

describe('CardService.setStatus — lifecycle transitions (R10.4)', () => {
  let repos: Repositories;
  let cards: CardService;
  let sessionId: string;
  beforeEach(() => {
    repos = makeRepos();
    cards = createCardService({ repos });
    sessionId = seedSession(repos);
  });

  it('transitions active → dismissed', async () => {
    const rec = await cards.emit(sessionId, card('Dismiss me'));
    const updated = await cards.setStatus(rec.id, 'dismissed');
    expect(updated?.status).toBe('dismissed');
    expect(repos.card.get(rec.id)?.status).toBe('dismissed');
    expect(await cards.list('active')).toEqual([]);
  });

  it('transitions active → done', async () => {
    const rec = await cards.emit(sessionId, card('Complete me'));
    const updated = await cards.setStatus(rec.id, 'done');
    expect(updated?.status).toBe('done');
    expect(repos.card.get(rec.id)?.status).toBe('done');
  });

  it('returns null for an unknown card id', async () => {
    expect(await cards.setStatus('does-not-exist', 'done')).toBeNull();
  });

  it('frees the active slot so a later card can become active', async () => {
    const first = await cards.emit(sessionId, card('First'));
    await cards.setStatus(first.id, 'done');
    const second = await cards.emit(sessionId, card('Second'));

    const active = await cards.list('active');
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(second.id);
    // Completing then re-emitting should not re-touch the already-done first card.
    expect(repos.card.get(first.id)?.status).toBe('done');
  });
});

describe('CardService.list — archived view = dismissed ∪ done (R10.4)', () => {
  let repos: Repositories;
  let cards: CardService;
  let sessionId: string;
  beforeEach(() => {
    repos = makeRepos();
    cards = createCardService({ repos });
    sessionId = seedSession(repos);
  });

  it('archived returns both dismissed and done, but not active', async () => {
    const a = await cards.emit(sessionId, card('to-dismiss'));
    await cards.setStatus(a.id, 'dismissed');
    const b = await cards.emit(sessionId, card('to-complete'));
    await cards.setStatus(b.id, 'done');
    const c = await cards.emit(sessionId, card('still-active'));

    const archived = await cards.list('archived');
    const archivedIds = archived.map((r) => r.id).sort();
    expect(archivedIds).toEqual([a.id, b.id].sort());
    // Every archived row is in a terminal status.
    for (const r of archived) expect(ARCHIVE_STATUSES).toContain(r.status);

    // The active view is disjoint from the archive.
    const active = await cards.list('active');
    expect(active.map((r) => r.id)).toEqual([c.id]);
  });

  it('stored statuses read through directly', async () => {
    const a = await cards.emit(sessionId, card('done-only'));
    await cards.setStatus(a.id, 'done');
    expect((await cards.list('done')).map((r) => r.id)).toEqual([a.id]);
    expect(await cards.list('dismissed')).toEqual([]);
  });

  it('isArchivedStatus flags only the archived view', () => {
    expect(isArchivedStatus('archived')).toBe(true);
    expect(isArchivedStatus('active')).toBe(false);
    expect(isArchivedStatus('dismissed')).toBe(false);
    expect(isArchivedStatus('done')).toBe(false);
  });
});
