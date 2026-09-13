import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { modeOutputSchema, type CardRecord } from '@turtle/shared';
import { SCHEMA_SQL } from '../store/schema.js';
import { createCipher } from '../store/crypto.js';
import { createRepositories, type Repositories } from '../store/repositories.js';
import { isSummaryRetrievalQuery, isVisitSummaryDictation, routeByRules } from './mode-router.js';
import {
  createSummaryRetrievalRunner,
  runSummaryRetrieval,
  parseSummaryQuery,
  extractKeywords,
  matchCard,
  buildRecallSay,
  reSurfaceCard,
  type SummaryRetrievalDeps,
} from './summary-retrieval.js';

/**
 * Prep/visit-summary voice retrieval — the "read it back" path (Task 30, R12.5).
 *
 * Coverage:
 *   1. Prep-question retrieval — "What were the questions for Tuesday?" returns the
 *      matching prep card's content.
 *   2. Visit-summary retrieval — "What did the doctor say?" returns the latest visit
 *      summary card's content.
 *   3. Archive-aware matching — a card that has left `active` (dismissed/done) is still
 *      found.
 *   4. Re-surface — a hit re-emits the matched card (preserving its share action).
 *   5. No-match — a query with no matching card says so plainly, no card.
 *   6. Query parsing + routing — kind inference, keyword extraction, and that the mode
 *      router sends retrieval questions to `prep` while dictation is not a retrieval.
 *
 * Everything runs against an in-memory SQLite store — no network, no LLM (retrieval is
 * deterministic over the store) — mirroring log-retrieval.test.ts.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStore(): { repos: Repositories; sessionId: string } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  const repos = createRepositories(db, createCipher('test-key'));
  const caregiver = repos.caregiver.create({ display_name: 'Sam' });
  const session = repos.session.create(caregiver.id);
  return { repos, sessionId: session.id };
}

/** Seed a card row directly (cards normally come from the contract; this is a fixture). */
function seedCard(
  repos: Repositories,
  sessionId: string,
  card: { type: CardRecord['type']; title: string; body: string; action?: CardRecord['action'] },
): CardRecord {
  return repos.card.create({
    session_id: sessionId,
    type: card.type,
    title: card.title,
    body: card.body,
    action: card.action ?? null,
  });
}

function deps(repos: Repositories): SummaryRetrievalDeps {
  return { repos };
}

// ---------------------------------------------------------------------------
// Prep-question retrieval (R12.5)
// ---------------------------------------------------------------------------

describe('runSummaryRetrieval — prep questions (R12.5)', () => {
  it('returns the prep card content for "what were the questions for Tuesday"', () => {
    const { repos, sessionId } = makeStore();
    seedCard(repos, sessionId, {
      type: 'retained',
      title: 'Prep: Oncology',
      body: 'When: Tuesday at 2pm\nWhat to ask:\n• What are the next steps?\n• Any side effects?',
    });

    const out = runSummaryRetrieval('What were the questions for Tuesday?', deps(repos));
    expect(out.say).toContain('What are the next steps?');
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]!.title).toBe('Prep: Oncology');
    expect(() => modeOutputSchema.parse(out)).not.toThrow();
  });

  it('does not return a visit summary when only prep questions were asked', () => {
    const { repos, sessionId } = makeStore();
    seedCard(repos, sessionId, {
      type: 'retained',
      title: 'Visit summary: Oncology',
      body: 'Tuesday visit\nScan stable',
    });
    // No prep card exists → prep-only query finds nothing.
    const out = runSummaryRetrieval('What were the questions for Tuesday?', deps(repos));
    expect(out.cards).toHaveLength(0);
    expect(out.say.toLowerCase()).toContain("don't have");
  });
});

// ---------------------------------------------------------------------------
// Visit-summary retrieval (R12.5)
// ---------------------------------------------------------------------------

describe('runSummaryRetrieval — visit summary (R12.5)', () => {
  it('returns the visit summary for "what did the doctor say"', () => {
    const { repos, sessionId } = makeStore();
    seedCard(repos, sessionId, {
      type: 'retained',
      title: 'Visit summary: Oncology',
      body: 'Scan was stable\n• No growth\nNext: Back in two weeks',
      action: { kind: 'share', target: '/cards' },
    });

    const out = runSummaryRetrieval('What did the doctor say?', deps(repos));
    expect(out.say).toContain('Scan was stable');
    expect(out.say).toContain('No growth');
    expect(out.cards).toHaveLength(1);
    // Re-surfaced card preserves its share action.
    expect(out.cards[0]!.action).toEqual({ kind: 'share', target: '/cards' });
  });

  it('finds a visit-summary card that has been archived (dismissed/done)', () => {
    const { repos, sessionId } = makeStore();
    const card = seedCard(repos, sessionId, {
      type: 'retained',
      title: 'Visit summary',
      body: 'Everything looked good',
    });
    repos.card.setStatus(card.id, 'done'); // left active → archived

    const out = runSummaryRetrieval('Read me the visit summary', deps(repos));
    expect(out.cards).toHaveLength(1);
    expect(out.say).toContain('Everything looked good');
  });
});

// ---------------------------------------------------------------------------
// No-match
// ---------------------------------------------------------------------------

describe('runSummaryRetrieval — no match', () => {
  it('says so plainly with no card when nothing matches', () => {
    const { repos } = makeStore();
    const out = runSummaryRetrieval('What were the questions for Friday?', deps(repos));
    expect(out.cards).toHaveLength(0);
    expect(out.say.toLowerCase()).toContain("don't have");
    expect(() => modeOutputSchema.parse(out)).not.toThrow();
  });

  it('does not match a prep card for a different day', () => {
    const { repos, sessionId } = makeStore();
    seedCard(repos, sessionId, {
      type: 'retained',
      title: 'Prep: Oncology',
      body: 'When: Tuesday\nWhat to ask:\n• Next steps?',
    });
    const out = runSummaryRetrieval('What were the questions for Friday?', deps(repos));
    expect(out.cards).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

describe('parseSummaryQuery / extractKeywords', () => {
  it('infers prep kind and pulls the weekday keyword', () => {
    const q = parseSummaryQuery('What were the questions for Tuesday?');
    expect(q.kind).toBe('prep');
    expect(q.keywords).toContain('tuesday');
  });

  it('infers visit_summary kind for "what did the doctor say"', () => {
    expect(parseSummaryQuery('What did the doctor say?').kind).toBe('visit_summary');
    expect(parseSummaryQuery('Read me the visit summary').kind).toBe('visit_summary');
  });

  it('drops interrogative/cue glue from keywords', () => {
    const kws = extractKeywords('what were the questions for tuesday');
    expect(kws).toEqual(['tuesday']);
  });
});

// ---------------------------------------------------------------------------
// matchCard / recall / re-surface
// ---------------------------------------------------------------------------

describe('matchCard / buildRecallSay / reSurfaceCard', () => {
  it('matchCard selects the card matching the keyword filter', () => {
    const { repos, sessionId } = makeStore();
    seedCard(repos, sessionId, {
      type: 'retained',
      title: 'Visit summary: Oncology',
      body: 'Scan stable',
    });
    const labs = seedCard(repos, sessionId, {
      type: 'retained',
      title: 'Visit summary: Bloodwork',
      body: 'Levels fine',
    });
    // Keyword narrows to the bloodwork summary regardless of insertion order.
    const match = matchCard(repos, { kind: 'visit_summary', keywords: ['bloodwork'] });
    expect(match?.id).toBe(labs.id);
  });

  it('matchCard returns a candidate when several match (kind only)', () => {
    const { repos, sessionId } = makeStore();
    const a = seedCard(repos, sessionId, { type: 'retained', title: 'Visit summary', body: 'one' });
    const b = seedCard(repos, sessionId, { type: 'retained', title: 'Visit summary', body: 'two' });
    const match = matchCard(repos, { kind: 'visit_summary', keywords: [] });
    expect([a.id, b.id]).toContain(match?.id);
  });

  it('buildRecallSay reads the card title + body back neutrally', () => {
    const say = buildRecallSay({
      id: 'c1',
      session_id: 's',
      type: 'retained',
      title: 'Visit summary: Oncology',
      body: 'Scan stable\n• No growth',
      action: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    expect(say).toContain("Here's Visit summary: Oncology");
    expect(say).toContain('Scan stable');
    expect(say).toContain('No growth');
  });

  it('reSurfaceCard preserves type/title/body/action', () => {
    const record: CardRecord = {
      id: 'c1',
      session_id: 's',
      type: 'retained',
      title: 'Visit summary',
      body: 'body',
      action: { kind: 'share', target: '/cards' },
      status: 'done',
      created_at: '2024-01-01T00:00:00.000Z',
    };
    expect(reSurfaceCard(record)).toEqual({
      type: 'retained',
      title: 'Visit summary',
      body: 'body',
      action: { kind: 'share', target: '/cards' },
    });
  });
});

// ---------------------------------------------------------------------------
// ModeRunner + routing
// ---------------------------------------------------------------------------

describe('createSummaryRetrievalRunner + routing', () => {
  it('is a ModeRunner tagged `prep`', () => {
    const { repos } = makeStore();
    expect(createSummaryRetrievalRunner(deps(repos)).mode).toBe('prep');
  });

  it('router sends retrieval questions to `prep`, dictation is not a retrieval', () => {
    expect(routeByRules('What were the questions for Tuesday?')).toBe('prep');
    expect(routeByRules('What did the doctor say?')).toBe('prep');

    expect(isSummaryRetrievalQuery('What were the questions for Tuesday?')).toBe(true);
    expect(isSummaryRetrievalQuery('What did the doctor say?')).toBe(true);

    // A dictation is not a retrieval — the two prep sub-intents are mutually exclusive.
    const dictation = 'The doctor said the scan was stable and to come back in two weeks';
    expect(isVisitSummaryDictation(dictation)).toBe(true);
    expect(isSummaryRetrievalQuery(dictation)).toBe(false);
  });
});
