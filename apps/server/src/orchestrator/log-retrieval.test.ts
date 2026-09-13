import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { modeOutputSchema, type LogCategory } from '@turtle/shared';
import { SCHEMA_SQL } from '../store/schema.js';
import { createCipher } from '../store/crypto.js';
import { createRepositories, type Repositories } from '../store/repositories.js';
import { isLogRetrievalQuery, routeByRules } from './mode-router.js';
import {
  createLogRetrievalRunner,
  runLogRetrieval,
  parseQuery,
  parseDateWindow,
  extractKeywords,
  isOnsetQuery,
  isListRequest,
  queryEntries,
  RETRIEVAL_CARD_TITLE,
  type LogRetrievalDeps,
} from './log-retrieval.js';

/**
 * Care-log voice retrieval — READ counterpart to log.prompt (Task 27, R11.4).
 *
 * Coverage:
 *   1. Time-based retrieval — "what happened yesterday?" recalls only that day's
 *      entries, framed plainly.
 *   2. Onset retrieval — "when did the cough start?" returns the EARLIEST matching
 *      entry, not the most recent.
 *   3. No-match — a window/keyword with nothing logged says so plainly, no card.
 *   4. Card emission on a list request — "list what I logged yesterday" emits one
 *      retained card; a plain question does not.
 *   5. Zero interpretation — the say/card echo the caregiver's words with a neutral
 *      when-frame and never advise/compare/triage.
 *   6. Query parsing + routing — date windows, keywords, onset/list intent, and that
 *      the mode router sends retrieval questions to `log`.
 *
 * Everything runs against an in-memory SQLite store with a fixed clock — no network,
 * no LLM (retrieval is deterministic over the store) — mirroring log.test.ts.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Fixed "now": a Wednesday, so weekday math is deterministic. 2024-03-06 is a Wed. */
const NOW = new Date('2024-03-06T15:00:00.000Z');
const fixedClock = () => NOW;

/** Day offsets relative to NOW, as ISO timestamps at midday. */
function daysAgo(n: number, hour = 12): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

function makeStore(): { repos: Repositories; patientId: string } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  const repos = createRepositories(db, createCipher('test-key'));
  const caregiver = repos.caregiver.create({ display_name: 'Sam' });
  const patient = repos.patient.create({
    caregiver_id: caregiver.id,
    name: 'Alex',
    diagnosis: 'metastatic_cancer',
    diagnosis_notes: null,
    care_team: { other: [] },
  });
  return { repos, patientId: patient.id };
}

/** Seed a log entry at a given time. */
function seed(
  repos: Repositories,
  patientId: string,
  category: LogCategory,
  text: string,
  at: string,
): void {
  repos.logEntry.create({ patient_id: patientId, at, category, text, structured: null });
}

function deps(repos: Repositories, patientId: string): LogRetrievalDeps {
  return { repos, patientId, now: fixedClock };
}

// ---------------------------------------------------------------------------
// 1. Time-based retrieval (R11.4)
// ---------------------------------------------------------------------------

describe('runLogRetrieval — time-based retrieval (R11.4)', () => {
  it('"what happened yesterday?" recalls only yesterday\'s entries', () => {
    const { repos, patientId } = makeStore();
    seed(repos, patientId, 'symptom', 'a new cough', daysAgo(1));
    seed(repos, patientId, 'sleep', 'slept badly', daysAgo(1, 22));
    seed(repos, patientId, 'food', 'ate well', daysAgo(0)); // today — excluded
    seed(repos, patientId, 'event', 'a visitor came', daysAgo(2)); // older — excluded

    const out = runLogRetrieval('What happened yesterday?', deps(repos, patientId));

    expect(out.say.toLowerCase()).toContain('yesterday');
    expect(out.say).toContain('a new cough');
    expect(out.say).toContain('slept badly');
    // Entries outside the window are not recalled.
    expect(out.say).not.toContain('ate well');
    expect(out.say).not.toContain('a visitor came');
    // Plain question (no "list") → no card.
    expect(out.cards).toHaveLength(0);
    expect(() => modeOutputSchema.parse(out)).not.toThrow();
  });

  it('"what did I log on Monday?" recalls that weekday\'s entries', () => {
    const { repos, patientId } = makeStore();
    // NOW is Wed 2024-03-06 → Monday is 2024-03-04 (2 days ago).
    seed(repos, patientId, 'note', 'a good morning', daysAgo(2));
    seed(repos, patientId, 'symptom', 'some nausea', daysAgo(1)); // Tuesday — excluded

    const out = runLogRetrieval('What did I log on Monday?', deps(repos, patientId));
    expect(out.say).toContain('a good morning');
    expect(out.say).not.toContain('some nausea');
    expect(out.say.toLowerCase()).toContain('monday');
  });

  it('recalls entries within an explicit ISO date', () => {
    const { repos, patientId } = makeStore();
    seed(repos, patientId, 'event', 'the ISO-day event', '2024-03-02T09:00:00.000Z');
    seed(repos, patientId, 'event', 'a different day', '2024-03-01T09:00:00.000Z');

    const out = runLogRetrieval('what happened on 2024-03-02', deps(repos, patientId));
    expect(out.say).toContain('the ISO-day event');
    expect(out.say).not.toContain('a different day');
  });

  it('summarizes the remainder when more than three entries match', () => {
    const { repos, patientId } = makeStore();
    for (let i = 0; i < 5; i++) {
      seed(repos, patientId, 'note', `note number ${i}`, daysAgo(1, 8 + i));
    }
    const out = runLogRetrieval('what happened yesterday', deps(repos, patientId));
    // Names up to three, then counts the rest.
    expect(out.say).toContain('2 more');
  });
});

// ---------------------------------------------------------------------------
// 2. Onset retrieval (R11.4)
// ---------------------------------------------------------------------------

describe('runLogRetrieval — onset retrieval (R11.4)', () => {
  it('"when did the cough start?" returns the EARLIEST matching entry', () => {
    const { repos, patientId } = makeStore();
    seed(repos, patientId, 'symptom', 'the cough is back', daysAgo(1));
    seed(repos, patientId, 'symptom', 'a new cough today', daysAgo(4)); // earliest cough
    seed(repos, patientId, 'symptom', 'more coughing', daysAgo(2));
    seed(repos, patientId, 'food', 'ate a little', daysAgo(5)); // not a cough — ignored

    const out = runLogRetrieval('When did the cough start?', deps(repos, patientId));

    // Answers with the earliest cough entry (4 days ago), not the most recent.
    expect(out.say).toContain('a new cough today');
    expect(out.say).not.toContain('the cough is back');
    // Mentions the subject and frames it as recall ("the first time you noted…").
    expect(out.say.toLowerCase()).toContain('first');
    expect(out.say.toLowerCase()).toContain('cough');
    expect(out.cards).toHaveLength(0);
    expect(() => modeOutputSchema.parse(out)).not.toThrow();
  });

  it('onset over the whole log ignores any date window', () => {
    const { repos, patientId } = makeStore();
    // Earliest is well over a week ago → falls back to an ISO date frame.
    seed(repos, patientId, 'symptom', 'first cough', '2024-02-20T10:00:00.000Z');
    seed(repos, patientId, 'symptom', 'cough again', daysAgo(1));

    const out = runLogRetrieval('when did the cough begin', deps(repos, patientId));
    expect(out.say).toContain('first cough');
    expect(out.say).toContain('2024-02-20');
  });
});

// ---------------------------------------------------------------------------
// 3. No-match (R11.4)
// ---------------------------------------------------------------------------

describe('runLogRetrieval — no match (R11.4)', () => {
  it('says so plainly and emits no card when nothing matches the window', () => {
    const { repos, patientId } = makeStore();
    seed(repos, patientId, 'note', 'something today', daysAgo(0));

    const out = runLogRetrieval('what happened yesterday?', deps(repos, patientId));
    expect(out.say.toLowerCase()).toContain("don't have anything logged");
    expect(out.say.toLowerCase()).toContain('yesterday');
    expect(out.cards).toHaveLength(0);
  });

  it('says so plainly when a keyword matches nothing', () => {
    const { repos, patientId } = makeStore();
    seed(repos, patientId, 'sleep', 'slept well', daysAgo(1));

    const out = runLogRetrieval('when did the rash start?', deps(repos, patientId));
    expect(out.say.toLowerCase()).toContain("don't have anything logged");
    expect(out.say.toLowerCase()).toContain('rash');
    expect(out.cards).toHaveLength(0);
  });

  it('says so plainly when the log is entirely empty', () => {
    const { repos, patientId } = makeStore();
    const out = runLogRetrieval('what happened yesterday?', deps(repos, patientId));
    expect(out.cards).toHaveLength(0);
    expect(() => modeOutputSchema.parse(out)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Card emission on a list request (R11.4)
// ---------------------------------------------------------------------------

describe('runLogRetrieval — card on list request (R11.4)', () => {
  it('emits one retained card when asked to LIST the matches', () => {
    const { repos, patientId } = makeStore();
    seed(repos, patientId, 'symptom', 'a new cough', daysAgo(1));
    seed(repos, patientId, 'sleep', 'slept badly', daysAgo(1, 22));

    const out = runLogRetrieval('List what I logged yesterday', deps(repos, patientId));
    expect(out.cards).toHaveLength(1);
    const card = out.cards[0]!;
    expect(card.type).toBe('retained');
    expect(card.title).toBe(RETRIEVAL_CARD_TITLE);
    // A recalled log is kept, not acted on → no action.
    expect(card.action).toBeUndefined();
    expect(card.body).toContain('a new cough');
    expect(card.body).toContain('slept badly');
    expect(() => modeOutputSchema.parse(out)).not.toThrow();
  });

  it('"show me the care log" for a symptom lists the matching entries', () => {
    const { repos, patientId } = makeStore();
    seed(repos, patientId, 'symptom', 'a new cough', daysAgo(2));
    const out = runLogRetrieval('show me the care log for the cough', deps(repos, patientId));
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]!.body).toContain('a new cough');
  });

  it('keeps the card body within the 280-char contract cap', () => {
    const { repos, patientId } = makeStore();
    for (let i = 0; i < 6; i++) {
      seed(repos, patientId, 'note', `${'x'.repeat(80)} entry ${i}`, daysAgo(1, 6 + i));
    }
    const out = runLogRetrieval('list everything from yesterday', deps(repos, patientId));
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]!.body.length).toBeLessThanOrEqual(280);
    expect(() => modeOutputSchema.parse(out)).not.toThrow();
  });

  it('a plain (non-list) retrieval question emits no card', () => {
    const { repos, patientId } = makeStore();
    seed(repos, patientId, 'symptom', 'a new cough', daysAgo(1));
    const out = runLogRetrieval('what happened yesterday?', deps(repos, patientId));
    expect(out.cards).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Zero interpretation (product.md / safety.md — recall, never interpret)
// ---------------------------------------------------------------------------

describe('runLogRetrieval — zero interpretation', () => {
  it('never advises, compares, triages, or flags in the say or card', () => {
    const { repos, patientId } = makeStore();
    seed(repos, patientId, 'symptom', 'a new cough', daysAgo(3));
    seed(repos, patientId, 'symptom', 'the cough is worse', daysAgo(1));

    const listed = runLogRetrieval('list what I logged about the cough', deps(repos, patientId));
    const onset = runLogRetrieval('when did the cough start?', deps(repos, patientId));

    const advice = [
      'you should',
      'i recommend',
      'call the doctor',
      'go to the er',
      'getting worse',
      'better than',
      'seems serious',
      'i think',
      'this means',
    ];
    for (const out of [listed, onset]) {
      const combined = `${out.say} ${out.cards
        .map((c) => `${c.title} ${c.body}`)
        .join(' ')}`.toLowerCase();
      for (const phrase of advice) {
        expect(combined).not.toContain(phrase);
      }
      // Retrieval is always a plain turn — never a safety/medical flag.
      expect(out.flags).toEqual(['none']);
      // No actionable "call/triage" affordance on a retrieval card.
      for (const card of out.cards) expect(card.action).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Query parsing + routing
// ---------------------------------------------------------------------------

describe('parseQuery / parseDateWindow / extractKeywords', () => {
  it('parses "yesterday" into a single-day window', () => {
    const w = parseDateWindow('what happened yesterday', NOW);
    expect(w.windowLabel).toBe('yesterday');
    expect(w.sinceIso).toBe(daysAgo(1, 0));
    expect(w.untilIso).toBe(daysAgo(0, 0));
  });

  it('parses "today" into a single-day window', () => {
    const w = parseDateWindow('what happened today', NOW);
    expect(w.windowLabel).toBe('today');
    expect(w.sinceIso).toBe(daysAgo(0, 0));
  });

  it('parses a weekday into the most recent past occurrence', () => {
    // NOW is Wed → "Monday" is 2 days ago.
    const w = parseDateWindow('what did I log on monday', NOW);
    expect(w.windowLabel).toBe('on Monday');
    expect(w.sinceIso).toBe(daysAgo(2, 0));
  });

  it('parses "last 3 days" into a multi-day window', () => {
    const w = parseDateWindow('anything in the last 3 days', NOW);
    expect(w.windowLabel).toBe('in the last 3 days');
    expect(w.sinceIso).toBe(daysAgo(2, 0)); // inclusive of today → 3 calendar days
  });

  it('returns an unbounded window when no date phrase is present', () => {
    const w = parseDateWindow('when did the cough start', NOW);
    expect(w.sinceIso).toBeNull();
    expect(w.untilIso).toBeNull();
    expect(w.windowLabel).toBeNull();
  });

  it('extracts real subjects and drops interrogative/temporal glue', () => {
    expect(extractKeywords('when did the cough start')).toEqual(['cough']);
    expect(extractKeywords('what happened yesterday')).toEqual([]);
    expect(extractKeywords('what did i log about the nausea on monday')).toEqual(['nausea']);
  });

  it('detects onset and list intent', () => {
    expect(isOnsetQuery('when did the cough start')).toBe(true);
    expect(isOnsetQuery('what happened yesterday')).toBe(false);
    expect(isListRequest('list what I logged')).toBe(true);
    expect(isListRequest('show me the cough entries')).toBe(true);
    expect(isListRequest('what happened yesterday')).toBe(false);
  });

  it('parseQuery composes window + keywords + intent together', () => {
    const q = parseQuery('when did the cough start', NOW);
    expect(q.onset).toBe(true);
    expect(q.keywords).toEqual(['cough']);
    expect(q.sinceIso).toBeNull();
    expect(q.wantsList).toBe(false);
  });
});

describe('queryEntries — deterministic store filtering', () => {
  it('filters by window, keyword, and category cue', () => {
    const { repos, patientId } = makeStore();
    seed(repos, patientId, 'symptom', 'a new cough', daysAgo(1));
    seed(repos, patientId, 'medication_given', 'the 2pm meds', daysAgo(1));
    seed(repos, patientId, 'symptom', 'a cough last week', daysAgo(9));

    // Keyword "cough" within "yesterday" → only the recent cough symptom.
    const q = parseQuery('what cough happened yesterday', NOW);
    const matches = queryEntries(repos, patientId, q, NOW);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe('a new cough');
  });

  it('returns matches newest-first (so the last element is the earliest)', () => {
    const { repos, patientId } = makeStore();
    seed(repos, patientId, 'symptom', 'cough day one', daysAgo(3));
    seed(repos, patientId, 'symptom', 'cough day three', daysAgo(1));

    const q = parseQuery('when did the cough start', NOW);
    const matches = queryEntries(repos, patientId, q, NOW);
    expect(matches[0]!.text).toBe('cough day three'); // newest first
    expect(matches[matches.length - 1]!.text).toBe('cough day one'); // earliest last
  });
});

describe('mode router integration — retrieval questions route to log', () => {
  it('routes care-log questions to `log` (not qa)', () => {
    expect(routeByRules('what happened yesterday?')).toBe('log');
    expect(routeByRules('when did the cough start?')).toBe('log');
    expect(routeByRules('what did I log on Monday?')).toBe('log');
    expect(routeByRules('show me the care log')).toBe('log');
  });

  it('isLogRetrievalQuery distinguishes retrieval from dictation', () => {
    expect(isLogRetrievalQuery('what happened yesterday?')).toBe(true);
    expect(isLogRetrievalQuery('when did the cough start?')).toBe(true);
    // Dictation statements are NOT retrieval.
    expect(isLogRetrievalQuery('gave the 2pm meds')).toBe(false);
    expect(isLogRetrievalQuery('slept badly')).toBe(false);
    expect(isLogRetrievalQuery('new cough today')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Runner wrapper
// ---------------------------------------------------------------------------

describe('createLogRetrievalRunner', () => {
  it('is a ModeRunner tagged `log`', () => {
    const { repos, patientId } = makeStore();
    const runner = createLogRetrievalRunner(deps(repos, patientId));
    expect(runner.mode).toBe('log');
  });

  it('runs end-to-end and returns a contract-valid recall output', async () => {
    const { repos, patientId } = makeStore();
    seed(repos, patientId, 'symptom', 'a new cough', daysAgo(1));
    const runner = createLogRetrievalRunner(deps(repos, patientId));
    const out = await runner.run('what happened yesterday?');
    expect(out.say).toContain('a new cough');
    expect(() => modeOutputSchema.parse(out)).not.toThrow();
  });
});
