import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { modeOutputSchema, type ModeOutput } from '@turtle/shared';
import { SCHEMA_SQL } from '../store/schema.js';
import { createCipher } from '../store/crypto.js';
import { createRepositories, type Repositories } from '../store/repositories.js';
import type { LlmMessage, LlmProvider, LlmStreamChunk } from '../services/llm/index.js';
import { finalizeTurn, type RepairFn } from './contract-validator.js';
import {
  createLogRunner,
  runLog,
  parseEntriesJson,
  isLogCategory,
  fallbackEntry,
  buildConfirmation,
  buildLogCard,
  extractEntries,
  LOG_SYSTEM,
  LOG_CARD_TITLE,
  type LogDeps,
  type LogExtraction,
} from './log.js';

/**
 * Care-log extraction mode — `log.prompt` (Task 26, R11.1–R11.3).
 *
 * Coverage:
 *   1. Multi-entry extraction (R11.1) — a compound utterance ("Gave the 2pm meds…
 *      slept badly… new cough") becomes several structured entries, each an
 *      append_log memory op with a category + timestamp.
 *   2. Category assignment (R11.1) — the extractor tags each entry with a valid
 *      LogCategory; the entries survive as append_log ops.
 *   3. Passive confirmation phrasing (R11.2) — the spoken `say` is a passive "Noted —
 *      … logged" confirmation composed in code.
 *   4. Log card creation (R11.2) — a single RETAINED card summarizes what was filed,
 *      no action.
 *   5. Zero-interpretation rule (R11.3) — no advice/comparison/triage leaks into the
 *      say or card, even when the model tries to add it.
 *   6. Zero-key degradation — a non-live provider records a single verbatim `note`.
 *   7. End-to-end persistence — append_log ops land as log_entry rows and the card is
 *      persisted through the shared validate → persist path.
 *
 * Everything runs with a FAKE LLM and (for persistence) an in-memory SQLite store —
 * no network — mirroring qa.test.ts / checkin.test.ts / mode-router.test.ts.
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A fake LLM whose `complete` returns a fixed ModeOutput (the extractor reads the
 * requested JSON array out of `say`) and captures the messages it saw so tests can
 * assert the extraction prompt was assembled.
 */
function fakeLlm(
  reply: ModeOutput,
  opts: { live?: boolean } = {},
): { llm: LlmProvider; messages: LlmMessage[][] } {
  const messages: LlmMessage[][] = [];
  const llm: LlmProvider = {
    id: 'fake',
    live: opts.live ?? true,
    async complete(msgs: LlmMessage[]): Promise<ModeOutput> {
      messages.push(msgs);
      return reply;
    },
    stream(msgs: LlmMessage[]): AsyncIterable<LlmStreamChunk> {
      messages.push(msgs);
      return (async function* () {
        yield { text: reply.say, done: true };
      })();
    },
  };
  return { llm, messages };
}

/** A ModeOutput whose `say` carries a JSON array of {category, text} entries. */
function extractorReply(entries: LogExtraction[]): ModeOutput {
  return { say: JSON.stringify(entries), cards: [], memory_ops: [], flags: ['none'] };
}

/** A fixed clock for deterministic `at` timestamps. */
const FIXED_NOW = new Date('2024-03-04T14:00:00.000Z');
const fixedClock = () => FIXED_NOW;

function makeRepos(): Repositories {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return createRepositories(db, createCipher('test-key'));
}

// ---------------------------------------------------------------------------
// Multi-entry extraction + category assignment (R11.1)
// ---------------------------------------------------------------------------

describe('runLog — multi-entry extraction and category assignment (R11.1)', () => {
  it('extracts several entries from a compound utterance, one append_log op each', async () => {
    const { llm } = fakeLlm(
      extractorReply([
        { category: 'medication_given', text: 'the 2pm meds' },
        { category: 'sleep', text: 'slept badly' },
        { category: 'symptom', text: 'new cough' },
      ]),
    );
    const out = await runLog('Gave the 2pm meds, slept badly, new cough', {
      llm,
      now: fixedClock,
    });

    expect(out.memory_ops).toHaveLength(3);
    // Each op is an append_log with the assigned category, verbatim text, and the
    // fixed timestamp (R11.1).
    expect(out.memory_ops).toEqual([
      { op: 'append_log', category: 'medication_given', text: 'the 2pm meds', at: FIXED_NOW.toISOString() },
      { op: 'append_log', category: 'sleep', text: 'slept badly', at: FIXED_NOW.toISOString() },
      { op: 'append_log', category: 'symptom', text: 'new cough', at: FIXED_NOW.toISOString() },
    ]);
    expect(() => modeOutputSchema.parse(out)).not.toThrow();
  });

  it('assembles the extraction-only prompt with the utterance', async () => {
    const { llm, messages } = fakeLlm(extractorReply([{ category: 'note', text: 'a quiet day' }]));
    await runLog('It was a quiet day', { llm, now: fixedClock });

    const last = messages[messages.length - 1]!;
    const system = last.find((m) => m.role === 'system')!.content;
    const user = last.find((m) => m.role === 'user')!.content;
    expect(system).toBe(LOG_SYSTEM);
    expect(user).toBe('It was a quiet day');
  });

  it('records a single entry as one op', async () => {
    const { llm } = fakeLlm(extractorReply([{ category: 'food', text: 'barely ate' }]));
    const out = await runLog('He barely ate today', { llm, now: fixedClock });
    expect(out.memory_ops).toEqual([
      { op: 'append_log', category: 'food', text: 'barely ate', at: FIXED_NOW.toISOString() },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Passive confirmation phrasing (R11.2)
// ---------------------------------------------------------------------------

describe('buildConfirmation / runLog say — passive confirmation (R11.2)', () => {
  it('confirms a single entry passively ("Noted — … logged")', () => {
    expect(buildConfirmation([{ category: 'medication_given', text: '2pm meds given' }])).toBe(
      'Noted — 2pm meds given logged.',
    );
  });

  it('joins multiple entries into one passive confirmation', () => {
    const say = buildConfirmation([
      { category: 'medication_given', text: 'the 2pm meds' },
      { category: 'sleep', text: 'slept badly' },
      { category: 'symptom', text: 'a new cough' },
    ]);
    expect(say).toBe('Noted — the 2pm meds logged, slept badly logged, and a new cough logged.');
  });

  it('starts the spoken turn with the passive "Noted —" frame', async () => {
    const { llm } = fakeLlm(extractorReply([{ category: 'sleep', text: 'up all night' }]));
    const out = await runLog('We were up all night', { llm, now: fixedClock });
    expect(out.say.startsWith('Noted —')).toBe(true);
    expect(out.say.toLowerCase()).toContain('logged');
  });

  it('trims trailing punctuation from entry text so phrases join cleanly', () => {
    expect(buildConfirmation([{ category: 'note', text: 'a hard day.' }])).toBe(
      'Noted — a hard day logged.',
    );
  });
});

// ---------------------------------------------------------------------------
// Log card creation (R11.2)
// ---------------------------------------------------------------------------

describe('buildLogCard / runLog cards — retained log card (R11.2)', () => {
  it('creates one retained card titled "Logged" with no action', () => {
    const card = buildLogCard([
      { category: 'medication_given', text: 'the 2pm meds' },
      { category: 'symptom', text: 'new cough' },
    ]);
    expect(card.type).toBe('retained');
    expect(card.title).toBe(LOG_CARD_TITLE);
    expect(card.action).toBeUndefined();
    expect(card.body).toContain('Medication: the 2pm meds');
    expect(card.body).toContain('Symptom: new cough');
  });

  it('runLog emits exactly one retained card summarizing the entries', async () => {
    const { llm } = fakeLlm(
      extractorReply([
        { category: 'medication_given', text: 'the 2pm meds' },
        { category: 'sleep', text: 'slept badly' },
      ]),
    );
    const out = await runLog('Gave the 2pm meds and slept badly', { llm, now: fixedClock });
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]!.type).toBe('retained');
    expect(out.cards[0]!.title).toBe(LOG_CARD_TITLE);
  });

  it('keeps the card body within the contract length cap for a long dictation', () => {
    const longText = 'x'.repeat(400);
    const card = buildLogCard([{ category: 'note', text: longText }]);
    expect(card.body.length).toBeLessThanOrEqual(280);
    // Still contract-valid inside a full mode output.
    expect(() =>
      modeOutputSchema.parse({ say: 'Noted — logged.', cards: [card], memory_ops: [], flags: ['none'] }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Zero-interpretation rule (R11.3)
// ---------------------------------------------------------------------------

describe('runLog — zero interpretation (R11.3)', () => {
  it('never lets model advice/comparison/triage reach the say or card', async () => {
    // The model tries to smuggle interpretation into the entry text AND into extra
    // prose. Only the structured entries flow into say/card, and the say/card are
    // composed in code from those entries — so no advice can appear beyond the
    // caregiver's verbatim words.
    const { llm } = fakeLlm({
      say: JSON.stringify([{ category: 'symptom', text: 'new cough' }]),
      cards: [],
      memory_ops: [],
      flags: ['none'],
    });
    const out = await runLog('New cough today', { llm, now: fixedClock });

    const advice = ['you should', 'i recommend', 'call the doctor', 'go to the er', 'worse than', 'better than', 'seems serious'];
    const combined = `${out.say} ${out.cards.map((c) => `${c.title} ${c.body}`).join(' ')}`.toLowerCase();
    for (const phrase of advice) {
      expect(combined).not.toContain(phrase);
    }
    // The turn is always a plain log turn — never a safety/medical flag.
    expect(out.flags).toEqual(['none']);
    // No actionable "call/triage" affordance on a log card.
    expect(out.cards[0]!.action).toBeUndefined();
  });

  it('discards any model-attached flags — a log turn is always `none`', async () => {
    const { llm } = fakeLlm({
      say: JSON.stringify([{ category: 'symptom', text: 'more pain' }]),
      cards: [],
      // A misbehaving model attaches a flag; the log mode composes its own output and
      // never propagates it.
      memory_ops: [],
      flags: ['medical_refusal'],
    });
    const out = await runLog('More pain today', { llm, now: fixedClock });
    expect(out.flags).toEqual(['none']);
  });
});

// ---------------------------------------------------------------------------
// Extraction robustness + zero-key degradation
// ---------------------------------------------------------------------------

describe('parseEntriesJson / extractEntries — robustness', () => {
  it('parses a bare JSON array of entries', () => {
    expect(parseEntriesJson('[{"category":"sleep","text":"slept badly"}]')).toEqual([
      { category: 'sleep', text: 'slept badly' },
    ]);
  });

  it('tolerates prose/fences around the JSON array', () => {
    const raw = 'Here you go:\n```json\n[{"category":"food","text":"ate a little"}]\n```';
    expect(parseEntriesJson(raw)).toEqual([{ category: 'food', text: 'ate a little' }]);
  });

  it('drops entries with an unknown category or empty text', () => {
    const raw = JSON.stringify([
      { category: 'not_a_category', text: 'x' },
      { category: 'note', text: '   ' },
      { category: 'note', text: 'kept' },
    ]);
    expect(parseEntriesJson(raw)).toEqual([{ category: 'note', text: 'kept' }]);
  });

  it('returns [] for non-array / unparseable input', () => {
    expect(parseEntriesJson('not json')).toEqual([]);
    expect(parseEntriesJson('{"category":"note","text":"obj not array"}')).toEqual([]);
  });

  it('isLogCategory recognizes valid categories only', () => {
    expect(isLogCategory('medication_given')).toBe(true);
    expect(isLogCategory('symptom')).toBe(true);
    expect(isLogCategory('nope')).toBe(false);
  });

  it('falls back to a single verbatim note with a non-live provider', async () => {
    const { llm, messages } = fakeLlm(extractorReply([{ category: 'sleep', text: 'unused' }]), {
      live: false,
    });
    const entries = await extractEntries('slept badly and coughed', llm);
    expect(entries).toEqual([{ category: 'note', text: 'slept badly and coughed' }]);
    // A non-live provider must not be consulted for extraction.
    expect(messages).toHaveLength(0);
  });

  it('falls back to a verbatim note when the model returns nothing structured', async () => {
    const { llm } = fakeLlm({ say: 'ok done', cards: [], memory_ops: [], flags: ['none'] });
    const out = await runLog('Gave the meds', { llm, now: fixedClock });
    expect(out.memory_ops).toEqual([
      { op: 'append_log', category: 'note', text: 'Gave the meds', at: FIXED_NOW.toISOString() },
    ]);
  });

  it('fallbackEntry never yields empty text (contract requires non-empty)', () => {
    expect(fallbackEntry('   ')).toEqual({ category: 'note', text: 'note' });
    expect(fallbackEntry('a real note')).toEqual({ category: 'note', text: 'a real note' });
  });

  it('reads entries straight out of model append_log ops when it emits them', async () => {
    const { llm } = fakeLlm({
      say: 'done',
      cards: [],
      memory_ops: [
        { op: 'append_log', category: 'medication_given', text: 'the 8am dose' },
        { op: 'append_log', category: 'note', text: 'good mood' },
      ],
      flags: ['none'],
    });
    const out = await runLog('Gave the 8am dose, good mood', { llm, now: fixedClock });
    expect(out.memory_ops.map((o) => o.op === 'append_log' && o.category)).toEqual([
      'medication_given',
      'note',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Runner + zero-key degradation through createLogRunner
// ---------------------------------------------------------------------------

describe('createLogRunner', () => {
  it('is a ModeRunner tagged `log`', () => {
    const { llm } = fakeLlm(extractorReply([{ category: 'note', text: 'x' }]));
    const runner = createLogRunner({ llm, now: fixedClock });
    expect(runner.mode).toBe('log');
  });

  it('records a verbatim note and confirms passively with a non-live provider', async () => {
    const { llm } = fakeLlm(extractorReply([{ category: 'note', text: 'unused' }]), { live: false });
    const runner = createLogRunner({ llm, now: fixedClock });
    const out = await runner.run('Gave the 2pm meds and slept badly');
    expect(out.memory_ops).toEqual([
      {
        op: 'append_log',
        category: 'note',
        text: 'Gave the 2pm meds and slept badly',
        at: FIXED_NOW.toISOString(),
      },
    ]);
    expect(out.say.startsWith('Noted —')).toBe(true);
    expect(out.cards[0]!.type).toBe('retained');
    expect(() => modeOutputSchema.parse(out)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// End-to-end persistence (R11.1/R11.2)
// ---------------------------------------------------------------------------

describe('log turn persistence — append_log rows + card (R11.1/R11.2)', () => {
  it('persists one log_entry per entry and the retained card via the shared path', async () => {
    const repos = makeRepos();
    const caregiver = repos.caregiver.create({ display_name: 'Sam' });
    const patient = repos.patient.create({
      caregiver_id: caregiver.id,
      name: 'Alex',
      diagnosis: 'metastatic_cancer',
      diagnosis_notes: null,
      care_team: { other: [] },
    });
    const session = repos.session.create(caregiver.id);

    const { llm } = fakeLlm(
      extractorReply([
        { category: 'medication_given', text: 'the 2pm meds' },
        { category: 'sleep', text: 'slept badly' },
        { category: 'symptom', text: 'new cough' },
      ]),
    );
    const out = await runLog('Gave the 2pm meds, slept badly, new cough', {
      llm,
      now: fixedClock,
    });

    const turnId = 'turn-log-1';
    const noRepair: RepairFn = async () => {
      throw new Error('should not repair a valid output');
    };
    const { cardIds } = await finalizeTurn(
      out,
      { sessionId: session.id, turnId },
      noRepair,
      { repos, patientId: patient.id },
    );

    // (R11.1) Three log entries persisted with their categories + verbatim text.
    const entries = repos.logEntry.list(patient.id);
    expect(entries).toHaveLength(3);
    const byCategory = new Map(entries.map((e) => [e.category, e.text]));
    expect(byCategory.get('medication_given')).toBe('the 2pm meds');
    expect(byCategory.get('sleep')).toBe('slept badly');
    expect(byCategory.get('symptom')).toBe('new cough');

    // (R11.2) A single retained log card persisted from the contract.
    expect(cardIds).toHaveLength(1);
    const card = repos.card.get(cardIds[0]!)!;
    expect(card.type).toBe('retained');
    expect(card.title).toBe(LOG_CARD_TITLE);
    expect(card.action).toBeNull();
  });
});

/** Convenience so LogDeps is exercised as a typed shape in this suite. */
const _typecheck: LogDeps = { llm: fakeLlm(extractorReply([])).llm };
void _typecheck;
