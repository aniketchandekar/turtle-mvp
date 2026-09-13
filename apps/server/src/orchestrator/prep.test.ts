import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { modeOutputSchema, type Appointment, type ModeOutput } from '@turtle/shared';
import { SCHEMA_SQL } from '../store/schema.js';
import { createCipher } from '../store/crypto.js';
import { createRepositories, type Repositories } from '../store/repositories.js';
import type { LlmMessage, LlmProvider, LlmStreamChunk } from '../services/llm/index.js';
import { finalizeTurn, type RepairFn } from './contract-validator.js';
import {
  createPrepRunner,
  runPrep,
  selectInWindow,
  parseAppointmentAt,
  suggestQuestions,
  parseQuestionList,
  fallbackQuestions,
  buildNoUpcomingSay,
  buildBriefingSay,
  buildBriefingCard,
  PREP_SYSTEM,
  DEFAULT_PREP_WINDOW_HOURS,
  MAX_BRIEFING_QUESTIONS,
  type AppointmentBriefing,
  type PrepDeps,
} from './prep.js';

/**
 * Appointment prep-briefing mode — `prep.prompt` (Task 29, R12.2/R12.3).
 *
 * Coverage:
 *   1. In-window detection (R12.2) — an appointment inside the window is offered a
 *      briefing; one outside (or in the past, or with an unparseable time) is not.
 *   2. Suggested questions — generated with a live LLM, deterministic fallback with a
 *      non-live provider or on unusable output (every provider degrades).
 *   3. Briefing card (R12.3) — ONE retained card per appointment: name, date, and a
 *      "what to ask" list.
 *   4. No appointment in window → plain say, no card.
 *   5. Contract validity — every output parses against modeOutputSchema.
 *   6. Configurable window — the window comes from deps (config.prepWindowHours).
 *   7. End-to-end persistence — the briefing card lands via the shared persist path.
 *
 * Everything runs against an in-memory SQLite store with a fixed clock and a FAKE LLM —
 * no network — mirroring appointment.test.ts / log-retrieval.test.ts.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Fixed "now" for deterministic window math. */
const NOW = new Date('2024-03-06T12:00:00.000Z');
const fixedClock = () => NOW;

/** An ISO timestamp `hours` from NOW (negative = in the past). */
function hoursFromNow(hours: number): string {
  return new Date(NOW.getTime() + hours * 3_600_000).toISOString();
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

/** Create an upcoming appointment, supplying the fields the repo requires. */
function addAppt(
  repos: Repositories,
  patientId: string,
  fields: { title: string; at: string; with_whom?: string | null; purpose?: string | null },
): Appointment {
  return repos.appointment.create({
    patient_id: patientId,
    title: fields.title,
    at: fields.at,
    with_whom: fields.with_whom ?? null,
    purpose: fields.purpose ?? null,
  });
}

/**
 * A fake LLM whose `complete` returns a fixed ModeOutput (the generator reads a JSON
 * array of questions out of `say`) and captures the messages it saw.
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

/** A ModeOutput whose `say` carries a JSON array of suggested questions. */
function questionsReply(questions: string[]): ModeOutput {
  return { say: JSON.stringify(questions), cards: [], memory_ops: [], flags: ['none'] };
}

/** A bare Appointment for the pure builders/selectors (no store needed). */
function appt(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: 'a1',
    patient_id: 'p1',
    title: 'Oncology follow-up',
    with_whom: 'Dr. Lee',
    at: hoursFromNow(24),
    purpose: 'scan review',
    status: 'upcoming',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-window selection (R12.2)
// ---------------------------------------------------------------------------

describe('selectInWindow — in-window detection (R12.2)', () => {
  it('includes an upcoming appointment inside the window, nearest first', () => {
    const near = appt({ id: 'near', at: hoursFromNow(6) });
    const far = appt({ id: 'far', at: hoursFromNow(30) });
    const selected = selectInWindow([far, near], NOW, 48);
    expect(selected.map((w) => w.appointment.id)).toEqual(['near', 'far']);
  });

  it('excludes an appointment beyond the window', () => {
    const outside = appt({ id: 'outside', at: hoursFromNow(72) });
    expect(selectInWindow([outside], NOW, 48)).toEqual([]);
  });

  it('excludes a past-due appointment (must be strictly after now)', () => {
    const past = appt({ id: 'past', at: hoursFromNow(-2) });
    expect(selectInWindow([past], NOW, 48)).toEqual([]);
  });

  it('includes an appointment exactly at the window edge', () => {
    const edge = appt({ id: 'edge', at: hoursFromNow(48) });
    expect(selectInWindow([edge], NOW, 48).map((w) => w.appointment.id)).toEqual(['edge']);
  });

  it('skips appointments whose time cannot be placed on a clock', () => {
    const vague = appt({ id: 'vague', at: 'sometime next week' });
    const concrete = appt({ id: 'concrete', at: hoursFromNow(12) });
    expect(selectInWindow([vague, concrete], NOW, 48).map((w) => w.appointment.id)).toEqual([
      'concrete',
    ]);
  });

  it('honors a custom (smaller) window', () => {
    const at30 = appt({ id: 'at30', at: hoursFromNow(30) });
    expect(selectInWindow([at30], NOW, 24)).toEqual([]);
    expect(selectInWindow([at30], NOW, 48).map((w) => w.appointment.id)).toEqual(['at30']);
  });
});

describe('parseAppointmentAt', () => {
  it('parses ISO / date-like strings to epoch ms', () => {
    expect(parseAppointmentAt('2024-03-06T12:00:00.000Z')).toBe(NOW.getTime());
    expect(parseAppointmentAt('2024-03-07')).toBe(Date.parse('2024-03-07'));
  });

  it('returns null for free text that is not a resolvable time', () => {
    expect(parseAppointmentAt('Tuesday at 2pm')).toBeNull();
    expect(parseAppointmentAt('   ')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suggested questions — generation + fallback
// ---------------------------------------------------------------------------

describe('suggestQuestions — live generation + fallback', () => {
  it('parses a generated JSON array of questions (bounded)', async () => {
    const { llm, messages } = fakeLlm(
      questionsReply([
        'What are the next steps after the scan?',
        'Are there side effects to watch for?',
        'When is the follow-up?',
        'A fourth question over the cap',
      ]),
    );
    const questions = await suggestQuestions(appt(), llm);
    expect(questions).toHaveLength(MAX_BRIEFING_QUESTIONS);
    expect(questions[0]).toBe('What are the next steps after the scan?');

    // The generator prompt is the routed PREP_SYSTEM with the appointment described.
    const last = messages[messages.length - 1]!;
    expect(last.find((m) => m.role === 'system')!.content).toBe(PREP_SYSTEM);
    expect(last.find((m) => m.role === 'user')!.content).toContain('Oncology follow-up');
  });

  it('falls back to deterministic questions with a non-live provider', async () => {
    const { llm, messages } = fakeLlm(questionsReply(['unused']), { live: false });
    const questions = await suggestQuestions(appt(), llm);
    expect(questions).toEqual(fallbackQuestions(appt()));
    // A non-live provider is never consulted.
    expect(messages).toHaveLength(0);
  });

  it('falls back when the model returns nothing usable', async () => {
    const { llm } = fakeLlm({ say: 'no array here', cards: [], memory_ops: [], flags: ['none'] });
    const questions = await suggestQuestions(appt(), llm);
    expect(questions).toEqual(fallbackQuestions(appt()));
  });

  it('fallback questions are neutral, bounded, and purpose-aware', () => {
    const withPurpose = fallbackQuestions(appt({ purpose: 'scan review' }));
    expect(withPurpose).toHaveLength(MAX_BRIEFING_QUESTIONS);
    expect(withPurpose[0]).toContain('scan review');

    const noPurpose = fallbackQuestions(appt({ purpose: null }));
    expect(noPurpose[0]).toBe('What is the goal of this visit?');

    // Never clinical advice / dosing / triage.
    const banned = ['dose', 'mg', 'you should take', 'go to the er', 'prognosis'];
    for (const q of [...withPurpose, ...noPurpose]) {
      for (const b of banned) expect(q.toLowerCase()).not.toContain(b);
    }
  });
});

describe('parseQuestionList — robustness', () => {
  it('parses a bare JSON array of strings', () => {
    expect(parseQuestionList('["a","b"]')).toEqual(['a', 'b']);
  });

  it('tolerates prose / fences around the array', () => {
    expect(parseQuestionList('Sure:\n```json\n["one","two"]\n```')).toEqual(['one', 'two']);
  });

  it('drops empty / non-string entries', () => {
    expect(parseQuestionList('["ok","", "  ", 3, null]')).toEqual(['ok']);
  });

  it('returns null when no usable array is present', () => {
    expect(parseQuestionList('not json')).toBeNull();
    expect(parseQuestionList('[]')).toBeNull();
    expect(parseQuestionList('["  "]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Say + card composition (R12.2/R12.3)
// ---------------------------------------------------------------------------

describe('buildBriefingSay — spoken briefing (R12.2)', () => {
  const briefing: AppointmentBriefing = {
    appointment: appt({ at: hoursFromNow(24) }),
    atMs: NOW.getTime() + 24 * 3_600_000,
    questions: ['What are the next steps?', 'What should I watch for?'],
  };

  it('names the appointment, purpose, what-to-report, and the questions', () => {
    const say = buildBriefingSay(briefing);
    expect(say).toContain('Oncology follow-up');
    expect(say).toContain('with Dr. Lee');
    expect(say).toContain('scan review'); // purpose
    expect(say.toLowerCase()).toContain('noticed since the last visit'); // what to report
    expect(say).toContain('What are the next steps');
  });

  it('omits the purpose clause when none was recorded', () => {
    const say = buildBriefingSay({ ...briefing, appointment: appt({ purpose: null }) });
    expect(say.toLowerCase()).not.toContain('the purpose is');
  });

  it('never lets advice/triage phrasing into the briefing', () => {
    const say = buildBriefingSay(briefing).toLowerCase();
    for (const phrase of ['you should', 'go to the er', 'i recommend', 'urgent', 'dose']) {
      expect(say).not.toContain(phrase);
    }
  });
});

describe('buildBriefingCard — one card per appointment (R12.3)', () => {
  it('builds one retained card with name, date, and a what-to-ask list', () => {
    const card = buildBriefingCard({
      appointment: appt({ title: 'Oncology follow-up', at: hoursFromNow(24) }),
      atMs: NOW.getTime() + 24 * 3_600_000,
      questions: ['What are the next steps?', 'What should I watch for?'],
    });
    expect(card.type).toBe('retained');
    expect(card.title).toBe('Prep: Oncology follow-up'); // appointment NAME
    expect(card.action).toBeUndefined();
    expect(card.body).toContain('When:'); // DATE
    expect(card.body).toContain('What to ask:');
    expect(card.body).toContain('• What are the next steps');
  });

  it('keeps the card body within the contract length cap for long fields', () => {
    const card = buildBriefingCard({
      appointment: appt({ title: 'x'.repeat(400), at: hoursFromNow(24) }),
      atMs: NOW.getTime() + 24 * 3_600_000,
      questions: ['q'.repeat(400)],
    });
    expect(card.body.length).toBeLessThanOrEqual(280);
    expect(() =>
      modeOutputSchema.parse({ say: 'ok', cards: [card], memory_ops: [], flags: ['none'] }),
    ).not.toThrow();
  });
});

describe('buildNoUpcomingSay', () => {
  it('names the window in days when it is a whole number of days', () => {
    expect(buildNoUpcomingSay(48)).toContain('2 days');
  });

  it('names the window in hours otherwise', () => {
    expect(buildNoUpcomingSay(6)).toContain('6 hours');
  });
});

// ---------------------------------------------------------------------------
// runPrep — end-to-end over the store
// ---------------------------------------------------------------------------

describe('runPrep — offers a briefing for an in-window appointment (R12.2/R12.3)', () => {
  it('emits a spoken briefing + one card for the nearest in-window appointment', async () => {
    const { repos, patientId } = makeStore();
    addAppt(repos, patientId, {
      title: 'Oncology follow-up',
      with_whom: 'Dr. Lee',
      at: hoursFromNow(24),
      purpose: 'scan review',
    });
    const { llm } = fakeLlm(questionsReply(['What are the next steps?', 'What should I watch for?']));

    const out = await runPrep({ repos, patientId, llm, windowHours: 48, now: fixedClock });

    expect(out.say).toContain('Oncology follow-up');
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]!.type).toBe('retained');
    expect(out.cards[0]!.title).toBe('Prep: Oncology follow-up');
    expect(out.cards[0]!.body).toContain('What to ask:');
    expect(out.flags).toEqual(['none']);
    expect(() => modeOutputSchema.parse(out)).not.toThrow();
  });

  it('picks the NEAREST in-window appointment when several qualify', async () => {
    const { repos, patientId } = makeStore();
    addAppt(repos, patientId, { title: 'Far visit', at: hoursFromNow(40) });
    addAppt(repos, patientId, { title: 'Near visit', at: hoursFromNow(5) });
    const { llm } = fakeLlm(questionsReply(['What are the next steps?']));

    const out = await runPrep({ repos, patientId, llm, windowHours: 48, now: fixedClock });
    expect(out.cards[0]!.title).toBe('Prep: Near visit');
  });

  it('says nothing is coming up (no card) when no appointment is in window', async () => {
    const { repos, patientId } = makeStore();
    addAppt(repos, patientId, { title: 'Way out', at: hoursFromNow(200) });
    const { llm } = fakeLlm(questionsReply(['unused']));

    const out = await runPrep({ repos, patientId, llm, windowHours: 48, now: fixedClock });
    expect(out.cards).toHaveLength(0);
    expect(out.say.toLowerCase()).toContain("don't have any appointments");
    expect(() => modeOutputSchema.parse(out)).not.toThrow();
  });

  it('respects a configurable window smaller than the appointment lead time', async () => {
    const { repos, patientId } = makeStore();
    addAppt(repos, patientId, { title: 'Tomorrow', at: hoursFromNow(30) });
    const { llm } = fakeLlm(questionsReply(['q']));

    const tight = await runPrep({ repos, patientId, llm, windowHours: 24, now: fixedClock });
    expect(tight.cards).toHaveLength(0);

    const wide = await runPrep({ repos, patientId, llm, windowHours: 48, now: fixedClock });
    expect(wide.cards).toHaveLength(1);
  });

  it('produces a briefing with zero keys (deterministic fallback questions)', async () => {
    const { repos, patientId } = makeStore();
    addAppt(repos, patientId, { title: 'Oncology', at: hoursFromNow(12), purpose: 'check-up' });
    const { llm, messages } = fakeLlm(questionsReply(['unused']), { live: false });

    const out = await runPrep({ repos, patientId, llm, windowHours: 48, now: fixedClock });
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]!.body).toContain('What to ask:');
    expect(messages).toHaveLength(0); // non-live provider never consulted
    expect(() => modeOutputSchema.parse(out)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

describe('createPrepRunner', () => {
  it('is a ModeRunner tagged `prep`', () => {
    const { repos, patientId } = makeStore();
    const { llm } = fakeLlm(questionsReply(['q']));
    const runner = createPrepRunner({ repos, patientId, llm });
    expect(runner.mode).toBe('prep');
  });

  it('defaults the window to 48h when none is supplied', async () => {
    const { repos, patientId } = makeStore();
    addAppt(repos, patientId, { title: 'In default window', at: hoursFromNow(40) });
    const { llm } = fakeLlm(questionsReply(['q']));

    const runner = createPrepRunner({ repos, patientId, llm, now: fixedClock });
    const out = await runner.run('anything');
    expect(DEFAULT_PREP_WINDOW_HOURS).toBe(48);
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]!.title).toBe('Prep: In default window');
  });
});

// ---------------------------------------------------------------------------
// End-to-end persistence (R12.3)
// ---------------------------------------------------------------------------

describe('prep turn persistence — retained briefing card (R12.3)', () => {
  it('persists the briefing card via the shared validate → persist path', async () => {
    const { repos, patientId } = makeStore();
    const session = repos.session.create(repos.patient.get(patientId)!.caregiver_id);
    addAppt(repos, patientId, {
      title: 'Oncology follow-up',
      with_whom: 'Dr. Lee',
      at: hoursFromNow(24),
      purpose: 'scan review',
    });
    const { llm } = fakeLlm(questionsReply(['What are the next steps?']));

    const out = await runPrep({ repos, patientId, llm, windowHours: 48, now: fixedClock });

    const noRepair: RepairFn = async () => {
      throw new Error('should not repair a valid output');
    };
    const { cardIds } = await finalizeTurn(
      out,
      { sessionId: session.id, turnId: 'turn-prep-1' },
      noRepair,
      { repos, patientId },
    );

    // A briefing produces no memory ops (read-only) and exactly one retained card.
    expect(out.memory_ops).toEqual([]);
    expect(cardIds).toHaveLength(1);
    const card = repos.card.get(cardIds[0]!)!;
    expect(card.type).toBe('retained');
    expect(card.title).toBe('Prep: Oncology follow-up');
    expect(card.action).toBeNull();
    expect(card.body).toContain('What to ask:');
  });
});

/** Convenience so PrepDeps is exercised as a typed shape in this suite. */
const _typecheck: PrepDeps = {
  repos: makeStore().repos,
  patientId: 'p',
  llm: fakeLlm(questionsReply(['q'])).llm,
};
void _typecheck;
