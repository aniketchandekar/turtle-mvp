import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  CARD_TYPES,
  turnContractSchema,
  type Card,
  type CardType,
  type TurnContract,
} from '@turtle/shared';
import { SCHEMA_SQL } from '../../store/schema.js';
import { createRepositories, type Repositories } from '../../store/repositories.js';
import { createCipher } from '../../store/crypto.js';
import { createCardService, type CardService } from './index.js';

/**
 * Card taxonomy unit test (Task 25, R10.1/R15.5).
 *
 * The contract is the single source of truth for a turn (spine invariant). Cards flow
 * ONLY from that contract and only when they meet the taxonomy — `actionable`,
 * `retained`, or `safety`. This test pins two rules:
 *
 *   1. Cards emit ONLY for the three taxonomy types (R10.1). The contract schema
 *      rejects any other `type`, and the card service persists exactly the emitted
 *      card — one active card per emitted contract card.
 *   2. Purely conversational content — a valid turn whose contract carries NO card —
 *      emits no cards (R15.5). Emitting the contract's (empty) card list produces
 *      nothing, and the active view stays empty.
 *
 * Runs against an in-memory SQLite store (matching the sibling cards test) — no
 * network, no mocks. The card service `emit` path is exercised only for contract
 * cards, mirroring "never inferred client-side".
 */

/** A contract card meeting the taxonomy. */
function card(type: CardType, title: string): Card {
  return { type, title, body: `body for ${title}` };
}

/** Build a valid turn contract, optionally carrying a single card. */
function contract(over: Partial<TurnContract> = {}): TurnContract {
  return turnContractSchema.parse({
    session_id: 's1',
    turn_id: 't1',
    state: 'SPEAKING',
    say: 'Here for you.',
    ...over,
  });
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

describe('Card taxonomy — cards emit only for actionable/retained/safety (R10.1)', () => {
  it('the contract taxonomy is exactly the three card types', () => {
    expect([...CARD_TYPES]).toEqual(['actionable', 'retained', 'safety']);
  });

  it('the contract schema accepts every taxonomy type', () => {
    for (const type of CARD_TYPES) {
      expect(() => contract({ cards: [card(type, `A ${type} card`)] })).not.toThrow();
    }
  });

  it('the contract schema rejects a card whose type is off-taxonomy', () => {
    const offTaxonomy = {
      session_id: 's1',
      turn_id: 't1',
      state: 'SPEAKING' as const,
      say: 'Here for you.',
      // `chat` / `conversational` are not part of the taxonomy — purely conversational
      // content is expressed by the ABSENCE of a card, never a new card type.
      cards: [{ type: 'conversational', title: 'Chit-chat', body: 'just talking' }],
    };
    expect(() => turnContractSchema.parse(offTaxonomy)).toThrow();
  });

  describe('the card service persists exactly the emitted taxonomy card', () => {
    let repos: Repositories;
    let cards: CardService;
    let sessionId: string;
    beforeEach(() => {
      repos = makeRepos();
      cards = createCardService({ repos });
      sessionId = seedSession(repos);
    });

    for (const type of CARD_TYPES) {
      it(`emits one active ${type} card from a contract carrying it`, async () => {
        const c = contract({ cards: [card(type, `A ${type} card`)] });
        expect(c.cards).toHaveLength(1);

        const rec = await cards.emit(sessionId, c.cards[0]!);
        expect(rec.type).toBe(type);
        expect(rec.status).toBe('active');

        const active = await cards.list('active');
        expect(active).toHaveLength(1);
        expect(active[0]!.type).toBe(type);
      });
    }
  });
});

describe('Card taxonomy — purely conversational content emits no cards (R15.5)', () => {
  let repos: Repositories;
  let cards: CardService;
  let sessionId: string;
  beforeEach(() => {
    repos = makeRepos();
    cards = createCardService({ repos });
    sessionId = seedSession(repos);
  });

  it('a valid conversational turn carries an empty card list', () => {
    // A turn that only speaks (no actionable / retained / safety content) defaults to
    // no cards — the contract expresses "conversational" as the absence of a card.
    const c = contract({ say: "That sounds like a hard day. I'm glad you told me." });
    expect(c.cards).toEqual([]);
  });

  it('emitting a conversational turn produces no cards and leaves the active view empty', async () => {
    const c = contract({ say: 'Take your time — there is no rush.' });

    // Emit exactly what the contract carries: nothing.
    for (const cardFromContract of c.cards) {
      await cards.emit(sessionId, cardFromContract);
    }

    expect(await cards.list('active')).toEqual([]);
    expect(await cards.list('archived')).toEqual([]);
  });

  it('a conversational turn following a carded turn does not emit a new card', async () => {
    // Prior turn emitted a retained card…
    const carded = contract({ cards: [card('retained', 'Questions for Tuesday')] });
    await cards.emit(sessionId, carded.cards[0]!);
    expect(await cards.list('active')).toHaveLength(1);

    // …a following purely conversational turn emits nothing new.
    const conversational = contract({ say: 'How are you holding up tonight?' });
    for (const cardFromContract of conversational.cards) {
      await cards.emit(sessionId, cardFromContract);
    }

    // The active view is unchanged — no card was inferred from conversation.
    const active = await cards.list('active');
    expect(active).toHaveLength(1);
    expect(active[0]!.title).toBe('Questions for Tuesday');
  });
});
