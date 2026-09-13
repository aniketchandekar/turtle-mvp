import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { modeOutputSchema, type ModeOutput } from '@turtle/shared';
import { SCHEMA_SQL } from '../store/schema.js';
import { createCipher } from '../store/crypto.js';
import { createRepositories, type Repositories } from '../store/repositories.js';
import type { LlmMessage, LlmProvider, LlmStreamChunk } from '../services/llm/index.js';
import { finalizeTurn, type RepairFn } from './contract-validator.js';
import {
  createAppointmentRunner,
  runAppointment,
  extractAppointment,
  parseAppointmentJson,
  fallbackAppointment,
  buildConfirmation,
  buildAppointmentCard,
  APPOINTMENT_SYSTEM,
  APPOINTMENT_CARD_TITLE,
  type AppointmentDeps,
  type AppointmentExtraction,
} from './appointment.js';

/**
 * Appointment-creation mode — the ADD-by-voice path (Task 28, R12.1).
 *
 * Coverage (mirrors log.test.ts — the closest analog):
 *   1. Live-LLM extraction — a dictated appointment becomes a single add_appointment
 *      memory op carrying title / at / with_whom / purpose.
 *   2. Zero-key fallback — a non-live provider records the verbatim utterance as the
 *      title so the appointment is never dropped.
 *   3. Passive confirmation phrasing — the spoken `say` is a neutral "Added — …"
 *      confirmation composed in code.
 *   4. Retained card shape — a single RETAINED "Appointment added" card, no action.
 *   5. Contract validity — every output parses against modeOutputSchema.
 *   6. End-to-end persistence — the add_appointment op lands as an `appointment` row
 *      via the shared validate → persist path (repos.appointment.create).
 *
 * Everything runs with a FAKE LLM and (for persistence) an in-memory SQLite store —
 * no network — mirroring log.test.ts / qa.test.ts / mode-router.test.ts.
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A fake LLM whose `complete` returns a fixed ModeOutput (the extractor reads the
 * requested JSON object out of `say`) and captures the messages it saw so tests can
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

/** A ModeOutput whose `say` carries a JSON object appointment extraction. */
function extractorReply(appt: AppointmentExtraction): ModeOutput {
  return { say: JSON.stringify(appt), cards: [], memory_ops: [], flags: ['none'] };
}

function makeRepos(): Repositories {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return createRepositories(db, createCipher('test-key'));
}

// ---------------------------------------------------------------------------
// Live-LLM extraction (R12.1)
// ---------------------------------------------------------------------------

describe('runAppointment — live-LLM extraction (R12.1)', () => {
  it('extracts a full appointment into one add_appointment op', async () => {
    const { llm } = fakeLlm(
      extractorReply({
        title: 'Follow-up',
        at: 'Tuesday at 2pm',
        with_whom: 'Dr. Lee',
        purpose: 'follow-up',
      }),
    );
    const out = await runAppointment(
      'Add an appointment with Dr. Lee on Tuesday at 2pm for a follow-up',
      { llm },
    );

    expect(out.memory_ops).toEqual([
      {
        op: 'add_appointment',
        title: 'Follow-up',
        at: 'Tuesday at 2pm',
        with_whom: 'Dr. Lee',
        purpose: 'follow-up',
      },
    ]);
    expect(() => modeOutputSchema.parse(out)).not.toThrow();
  });

  it('omits with_whom / purpose when the caregiver did not name them', async () => {
    const { llm } = fakeLlm(extractorReply({ title: 'Oncology', at: 'next Friday' }));
    const out = await runAppointment('Schedule oncology next Friday', { llm });
    expect(out.memory_ops).toEqual([
      { op: 'add_appointment', title: 'Oncology', at: 'next Friday' },
    ]);
  });

  it('assembles the extraction-only prompt with the utterance', async () => {
    const { llm, messages } = fakeLlm(extractorReply({ title: 'Labs', at: 'Monday' }));
    await runAppointment('Book labs on Monday', { llm });

    const last = messages[messages.length - 1]!;
    const system = last.find((m) => m.role === 'system')!.content;
    const user = last.find((m) => m.role === 'user')!.content;
    expect(system).toBe(APPOINTMENT_SYSTEM);
    expect(user).toBe('Book labs on Monday');
  });

  it('reads an appointment straight out of a model add_appointment op', async () => {
    const { llm } = fakeLlm({
      say: 'done',
      cards: [],
      memory_ops: [
        { op: 'add_appointment', title: 'Scan review', at: 'Thursday', with_whom: 'Dr. Chen' },
      ],
      flags: ['none'],
    });
    const out = await runAppointment('Set up a scan review with Dr. Chen on Thursday', { llm });
    expect(out.memory_ops).toEqual([
      { op: 'add_appointment', title: 'Scan review', at: 'Thursday', with_whom: 'Dr. Chen' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Zero-key fallback (R16.4 spirit)
// ---------------------------------------------------------------------------

describe('extractAppointment / runAppointment — zero-key fallback', () => {
  it('records the verbatim utterance as the title with a non-live provider', async () => {
    const { llm, messages } = fakeLlm(extractorReply({ title: 'unused', at: 'unused' }), {
      live: false,
    });
    const appt = await extractAppointment('Add an appointment with Dr. Lee on Tuesday', llm);
    expect(appt).toEqual({
      title: 'Add an appointment with Dr. Lee on Tuesday',
      at: 'unspecified time',
    });
    // A non-live provider must not be consulted for extraction.
    expect(messages).toHaveLength(0);
  });

  it('runAppointment still emits a valid add_appointment op with no keys', async () => {
    const { llm } = fakeLlm(extractorReply({ title: 'unused', at: 'unused' }), { live: false });
    const out = await runAppointment('Schedule oncology next Friday', { llm });
    expect(out.memory_ops).toEqual([
      { op: 'add_appointment', title: 'Schedule oncology next Friday', at: 'unspecified time' },
    ]);
    expect(() => modeOutputSchema.parse(out)).not.toThrow();
  });

  it('falls back to the verbatim title when the model returns nothing structured', async () => {
    const { llm } = fakeLlm({ say: 'ok done', cards: [], memory_ops: [], flags: ['none'] });
    const out = await runAppointment('Book a follow-up', { llm });
    expect(out.memory_ops).toEqual([
      { op: 'add_appointment', title: 'Book a follow-up', at: 'unspecified time' },
    ]);
  });

  it('fallbackAppointment never yields empty fields (contract requires non-empty)', () => {
    expect(fallbackAppointment('   ')).toEqual({ title: 'Appointment', at: 'unspecified time' });
    expect(fallbackAppointment('a real appt')).toEqual({
      title: 'a real appt',
      at: 'unspecified time',
    });
  });
});

// ---------------------------------------------------------------------------
// parseAppointmentJson robustness
// ---------------------------------------------------------------------------

describe('parseAppointmentJson — robustness', () => {
  it('parses a bare JSON object', () => {
    expect(parseAppointmentJson('{"title":"Oncology","at":"Friday"}')).toEqual({
      title: 'Oncology',
      at: 'Friday',
    });
  });

  it('tolerates prose/fences around the JSON object', () => {
    const raw = 'Sure:\n```json\n{"title":"Labs","at":"Monday","with_whom":"Dr. Lee"}\n```';
    expect(parseAppointmentJson(raw)).toEqual({
      title: 'Labs',
      at: 'Monday',
      with_whom: 'Dr. Lee',
    });
  });

  it('drops empty optional fields', () => {
    expect(parseAppointmentJson('{"title":"X","at":"Y","with_whom":"  ","purpose":""}')).toEqual({
      title: 'X',
      at: 'Y',
    });
  });

  it('returns null when title or at is missing/empty', () => {
    expect(parseAppointmentJson('{"title":"X"}')).toBeNull();
    expect(parseAppointmentJson('{"at":"Y"}')).toBeNull();
    expect(parseAppointmentJson('{"title":"","at":"Y"}')).toBeNull();
  });

  it('returns null for arrays / unparseable input', () => {
    expect(parseAppointmentJson('not json')).toBeNull();
    expect(parseAppointmentJson('[{"title":"X","at":"Y"}]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Passive confirmation (R12.1)
// ---------------------------------------------------------------------------

describe('buildConfirmation / runAppointment say — passive confirmation (R12.1)', () => {
  it('confirms with a neutral "Added — …" frame naming what and when', () => {
    expect(
      buildConfirmation({ title: 'Follow-up', at: 'Tuesday at 2pm', with_whom: 'Dr. Lee' }),
    ).toBe('Added — Follow-up with Dr. Lee, Tuesday at 2pm.');
  });

  it('omits the "with" clause when no clinician was named', () => {
    expect(buildConfirmation({ title: 'Oncology', at: 'next Friday' })).toBe(
      'Added — Oncology, next Friday.',
    );
  });

  it('starts the spoken turn with the passive "Added —" frame', async () => {
    const { llm } = fakeLlm(extractorReply({ title: 'Labs', at: 'Monday' }));
    const out = await runAppointment('Book labs on Monday', { llm });
    expect(out.say.startsWith('Added —')).toBe(true);
  });

  it('never lets advice/triage phrasing reach the say or card', async () => {
    const { llm } = fakeLlm(extractorReply({ title: 'Oncology', at: 'Friday' }));
    const out = await runAppointment('Schedule oncology on Friday', { llm });
    const advice = ['you should', 'i recommend', 'go to the er', 'urgent', 'call the doctor now'];
    const combined = `${out.say} ${out.cards
      .map((c) => `${c.title} ${c.body}`)
      .join(' ')}`.toLowerCase();
    for (const phrase of advice) expect(combined).not.toContain(phrase);
    expect(out.flags).toEqual(['none']);
  });
});

// ---------------------------------------------------------------------------
// Retained card (R12.1)
// ---------------------------------------------------------------------------

describe('buildAppointmentCard / runAppointment cards — retained card (R12.1)', () => {
  it('creates one retained card titled "Appointment added" with no action', () => {
    const card = buildAppointmentCard({
      title: 'Follow-up',
      at: 'Tuesday at 2pm',
      with_whom: 'Dr. Lee',
      purpose: 'scan review',
    });
    expect(card.type).toBe('retained');
    expect(card.title).toBe(APPOINTMENT_CARD_TITLE);
    expect(card.action).toBeUndefined();
    expect(card.body).toContain('Follow-up — Tuesday at 2pm');
    expect(card.body).toContain('With: Dr. Lee');
    expect(card.body).toContain('Purpose: scan review');
  });

  it('runAppointment emits exactly one retained card', async () => {
    const { llm } = fakeLlm(extractorReply({ title: 'Oncology', at: 'Friday' }));
    const out = await runAppointment('Schedule oncology on Friday', { llm });
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]!.type).toBe('retained');
    expect(out.cards[0]!.title).toBe(APPOINTMENT_CARD_TITLE);
  });

  it('keeps the card body within the contract length cap for long fields', () => {
    const card = buildAppointmentCard({ title: 'x'.repeat(400), at: 'Friday' });
    expect(card.body.length).toBeLessThanOrEqual(280);
    expect(() =>
      modeOutputSchema.parse({ say: 'Added — x.', cards: [card], memory_ops: [], flags: ['none'] }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

describe('createAppointmentRunner', () => {
  it('is a ModeRunner tagged `prep`', () => {
    const { llm } = fakeLlm(extractorReply({ title: 'X', at: 'Y' }));
    const runner = createAppointmentRunner({ llm });
    expect(runner.mode).toBe('prep');
  });

  it('adds an appointment and confirms passively with a non-live provider', async () => {
    const { llm } = fakeLlm(extractorReply({ title: 'unused', at: 'unused' }), { live: false });
    const runner = createAppointmentRunner({ llm });
    const out = await runner.run('Add an appointment with Dr. Lee on Tuesday');
    expect(out.memory_ops[0]!.op).toBe('add_appointment');
    expect(out.say.startsWith('Added —')).toBe(true);
    expect(out.cards[0]!.type).toBe('retained');
    expect(() => modeOutputSchema.parse(out)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// End-to-end persistence (R12.1)
// ---------------------------------------------------------------------------

describe('appointment turn persistence — add_appointment row + card (R12.1)', () => {
  it('persists the appointment via the shared validate → persist path', async () => {
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
      extractorReply({
        title: 'Follow-up',
        at: 'Tuesday at 2pm',
        with_whom: 'Dr. Lee',
        purpose: 'follow-up',
      }),
    );
    const out = await runAppointment(
      'Add an appointment with Dr. Lee on Tuesday at 2pm for a follow-up',
      { llm },
    );

    const noRepair: RepairFn = async () => {
      throw new Error('should not repair a valid output');
    };
    const { cardIds } = await finalizeTurn(
      out,
      { sessionId: session.id, turnId: 'turn-appt-1' },
      noRepair,
      { repos, patientId: patient.id },
    );

    // (R12.1) The appointment is stored in the patient profile, defaulting to upcoming.
    const upcoming = repos.appointment.listUpcoming(patient.id);
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]!.title).toBe('Follow-up');
    expect(upcoming[0]!.with_whom).toBe('Dr. Lee');
    expect(upcoming[0]!.at).toBe('Tuesday at 2pm');
    expect(upcoming[0]!.purpose).toBe('follow-up');
    expect(upcoming[0]!.status).toBe('upcoming');

    // A single retained appointment card persisted from the contract.
    expect(cardIds).toHaveLength(1);
    const card = repos.card.get(cardIds[0]!)!;
    expect(card.type).toBe('retained');
    expect(card.title).toBe(APPOINTMENT_CARD_TITLE);
    expect(card.action).toBeNull();
  });
});

/** Convenience so AppointmentDeps is exercised as a typed shape in this suite. */
const _typecheck: AppointmentDeps = { llm: fakeLlm(extractorReply({ title: 'x', at: 'y' })).llm };
void _typecheck;
