import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { modeOutputSchema, type ModeOutput } from '@turtle/shared';
import { SCHEMA_SQL } from '../store/schema.js';
import { createCipher } from '../store/crypto.js';
import { createRepositories, type Repositories } from '../store/repositories.js';
import type { LlmMessage, LlmProvider, LlmStreamChunk } from '../services/llm/index.js';
import { finalizeTurn, type RepairFn } from './contract-validator.js';
import {
  createVisitSummaryRunner,
  runVisitSummary,
  structureSummary,
  parseSummaryJson,
  fallbackSummary,
  pickAnchorAppointment,
  buildConfirmation,
  buildVisitSummaryCard,
  VISIT_SUMMARY_SYSTEM,
  VISIT_SUMMARY_CARD_TITLE,
  SHARE_ROUTE_BASE,
  type VisitSummary,
} from './visit-summary.js';

/**
 * Visit-summary dictation mode — the "what the doctor said" write path (Task 30, R12.4).
 *
 * Coverage (mirrors appointment.test.ts / prep.test.ts — the closest analogs):
 *   1. Live-LLM structuring — a dictation becomes a structured headline + points +
 *      optional follow-up.
 *   2. Zero-key fallback — a non-live provider records the verbatim dictation as a
 *      single point so the summary is never dropped.
 *   3. Passive confirmation — the spoken `say` is a neutral "Saved a visit summary…"
 *      line, mentioning it can be shared.
 *   4. Shareable retained card — one RETAINED card with a `share` action targeting the
 *      shareable-link route; anchored to an appointment when one obviously matches.
 *   5. Contract validity — every output parses against modeOutputSchema.
 *   6. End-to-end persistence — the card lands as a `card` row with a stable id via the
 *      shared validate → persist path.
 *
 * Everything runs with a FAKE LLM and (for persistence/anchoring) an in-memory SQLite
 * store — no network — mirroring the sibling mode tests.
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

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

/** A ModeOutput whose `say` carries a JSON object visit summary. */
function structurerReply(summary: VisitSummary): ModeOutput {
  return { say: JSON.stringify(summary), cards: [], memory_ops: [], flags: ['none'] };
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

const noRepair: RepairFn = async () => {
  throw new Error('repair should not be called');
};

// ---------------------------------------------------------------------------
// Live-LLM structuring (R12.4)
// ---------------------------------------------------------------------------

describe('structureSummary / runVisitSummary — live-LLM structuring (R12.4)', () => {
  it('structures a dictation into headline + points + follow_up', async () => {
    const { llm } = fakeLlm(
      structurerReply({
        headline: 'Scan was stable',
        points: ['Scan showed no growth', 'Keep the same dose'],
        follow_up: 'Come back in two weeks',
      }),
    );
    const summary = await structureSummary('The doctor said the scan was stable', llm);
    expect(summary).toEqual({
      headline: 'Scan was stable',
      points: ['Scan showed no growth', 'Keep the same dose'],
      follow_up: 'Come back in two weeks',
    });
  });

  it('assembles the structuring-only prompt with the dictation', async () => {
    const { llm, messages } = fakeLlm(structurerReply({ headline: 'ok', points: ['a'] }));
    await structureSummary('The nurse said labs look good', llm);
    const last = messages[messages.length - 1]!;
    expect(last.find((m) => m.role === 'system')!.content).toBe(VISIT_SUMMARY_SYSTEM);
    expect(last.find((m) => m.role === 'user')!.content).toBe('The nurse said labs look good');
  });

  it('emits one shareable retained card and no memory ops', async () => {
    const { llm } = fakeLlm(structurerReply({ headline: 'Stable', points: ['no growth'] }));
    const out = await runVisitSummary('The doctor said it is stable', { llm });
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]!.type).toBe('retained');
    expect(out.cards[0]!.action).toEqual({ kind: 'share', target: SHARE_ROUTE_BASE });
    expect(out.memory_ops).toEqual([]);
    expect(() => modeOutputSchema.parse(out)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Zero-key fallback (R16.4 spirit)
// ---------------------------------------------------------------------------

describe('structureSummary / runVisitSummary — zero-key fallback', () => {
  it('records the verbatim dictation as a single point with a non-live provider', async () => {
    const { llm, messages } = fakeLlm(structurerReply({ headline: 'x', points: ['y'] }), {
      live: false,
    });
    const summary = await structureSummary('The doctor said the scan was stable', llm);
    expect(summary).toEqual({
      headline: 'Visit summary',
      points: ['The doctor said the scan was stable'],
    });
    // A non-live provider must not be consulted for structuring.
    expect(messages).toHaveLength(0);
  });

  it('runVisitSummary still emits a valid shareable card with no keys', async () => {
    const { llm } = fakeLlm(structurerReply({ headline: 'x', points: ['y'] }), { live: false });
    const out = await runVisitSummary('The doctor said the scan was stable', { llm });
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]!.body).toContain('The doctor said the scan was stable');
    expect(out.cards[0]!.action!.kind).toBe('share');
    expect(() => modeOutputSchema.parse(out)).not.toThrow();
  });

  it('fallbackSummary never yields empty fields (contract requires non-empty)', () => {
    expect(fallbackSummary('   ')).toEqual({
      headline: 'Visit summary',
      points: ['(no details captured)'],
    });
    expect(fallbackSummary('real dictation')).toEqual({
      headline: 'Visit summary',
      points: ['real dictation'],
    });
  });

  it('falls back when the model returns nothing structured', async () => {
    const { llm } = fakeLlm({ say: 'ok done', cards: [], memory_ops: [], flags: ['none'] });
    const summary = await structureSummary('The doctor said hello', llm);
    expect(summary).toEqual({ headline: 'Visit summary', points: ['The doctor said hello'] });
  });
});

// ---------------------------------------------------------------------------
// parseSummaryJson robustness
// ---------------------------------------------------------------------------

describe('parseSummaryJson — robustness', () => {
  it('parses a bare JSON object', () => {
    expect(parseSummaryJson('{"headline":"H","points":["p1","p2"]}')).toEqual({
      headline: 'H',
      points: ['p1', 'p2'],
    });
  });

  it('tolerates surrounding prose/fences', () => {
    const raw = 'Sure:\n```json\n{"headline":"H","points":["p1"],"follow_up":"soon"}\n```';
    expect(parseSummaryJson(raw)).toEqual({ headline: 'H', points: ['p1'], follow_up: 'soon' });
  });

  it('rejects a missing headline or empty points', () => {
    expect(parseSummaryJson('{"points":["p1"]}')).toBeNull();
    expect(parseSummaryJson('{"headline":"H","points":[]}')).toBeNull();
    expect(parseSummaryJson('{"headline":"H"}')).toBeNull();
  });

  it('rejects an array-first shape', () => {
    expect(parseSummaryJson('["not","an","object"]')).toBeNull();
  });

  it('bounds points to the max', () => {
    const parsed = parseSummaryJson('{"headline":"H","points":["a","b","c","d","e","f"]}');
    expect(parsed!.points).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Appointment anchoring (deterministic; no LLM)
// ---------------------------------------------------------------------------

describe('pickAnchorAppointment — best-effort store anchor', () => {
  it('anchors to the single upcoming appointment', () => {
    const { repos, patientId } = makeStore();
    const appt = repos.appointment.create({
      patient_id: patientId,
      title: 'Oncology',
      at: '2024-03-10T14:00:00.000Z',
      with_whom: 'Dr. Lee',
      purpose: null,
    });
    expect(pickAnchorAppointment(repos, patientId, 'the doctor said all is well')?.id).toBe(appt.id);
  });

  it('prefers an appointment named in the dictation', () => {
    const { repos, patientId } = makeStore();
    repos.appointment.create({
      patient_id: patientId,
      title: 'Oncology',
      at: '2024-03-10T14:00:00.000Z',
      with_whom: 'Dr. Lee',
      purpose: null,
    });
    const labs = repos.appointment.create({
      patient_id: patientId,
      title: 'Bloodwork',
      at: '2024-03-12T09:00:00.000Z',
      with_whom: null,
      purpose: null,
    });
    const chosen = pickAnchorAppointment(repos, patientId, 'At bloodwork they said levels were fine');
    expect(chosen?.id).toBe(labs.id);
  });

  it('returns undefined when there are multiple and none is named', () => {
    const { repos, patientId } = makeStore();
    repos.appointment.create({ patient_id: patientId, title: 'Oncology', at: 'x', with_whom: null, purpose: null });
    repos.appointment.create({ patient_id: patientId, title: 'Bloodwork', at: 'y', with_whom: null, purpose: null });
    expect(pickAnchorAppointment(repos, patientId, 'the doctor said all is well')).toBeUndefined();
  });

  it('returns undefined when there are no upcoming appointments', () => {
    const { repos, patientId } = makeStore();
    expect(pickAnchorAppointment(repos, patientId, 'anything')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Confirmation + card composition
// ---------------------------------------------------------------------------

describe('buildConfirmation / buildVisitSummaryCard', () => {
  const summary: VisitSummary = {
    headline: 'Scan was stable',
    points: ['No growth', 'Same dose'],
    follow_up: 'Back in two weeks',
  };

  it('confirmation is passive and mentions sharing', () => {
    const say = buildConfirmation(summary);
    expect(say.toLowerCase()).toContain('saved a visit summary');
    expect(say.toLowerCase()).toContain('share it by link');
  });

  it('confirmation names the anchoring appointment', () => {
    const say = buildConfirmation(summary, {
      id: 'a1',
      patient_id: 'p',
      title: 'Oncology',
      with_whom: 'Dr. Lee',
      at: 'Tuesday',
      purpose: null,
      status: 'upcoming',
    });
    expect(say).toContain('from Oncology');
  });

  it('card is retained, shareable, and carries the summary content', () => {
    const card = buildVisitSummaryCard(summary);
    expect(card.type).toBe('retained');
    expect(card.title).toBe(VISIT_SUMMARY_CARD_TITLE);
    expect(card.action).toEqual({ kind: 'share', target: SHARE_ROUTE_BASE });
    expect(card.body).toContain('Scan was stable');
    expect(card.body).toContain('No growth');
    expect(card.body).toContain('Next: Back in two weeks');
    expect(card.body.length).toBeLessThanOrEqual(280);
  });

  it('card title carries the appointment name when anchored', () => {
    const card = buildVisitSummaryCard(summary, {
      id: 'a1',
      patient_id: 'p',
      title: 'Oncology',
      with_whom: null,
      at: 'Tuesday at 2pm',
      purpose: null,
      status: 'upcoming',
    });
    expect(card.title).toBe('Visit summary: Oncology');
    expect(card.body).toContain('When: Tuesday at 2pm');
  });
});

// ---------------------------------------------------------------------------
// ModeRunner + end-to-end persistence
// ---------------------------------------------------------------------------

describe('createVisitSummaryRunner + persistence', () => {
  it('is a ModeRunner tagged `prep`', () => {
    const { llm } = fakeLlm(structurerReply({ headline: 'H', points: ['p'] }));
    expect(createVisitSummaryRunner({ llm }).mode).toBe('prep');
  });

  it('persists the summary card with a stable id via the shared write path', async () => {
    const { repos, patientId } = makeStore();
    const { llm } = fakeLlm(structurerReply({ headline: 'Stable', points: ['no growth'] }));

    // A session is required for a card row (session_id FK).
    const cg = repos.caregiver.create({ display_name: 'S' });
    const session = repos.session.create(cg.id);

    const runner = createVisitSummaryRunner({ llm, repos, patientId });
    const out = await runner.run('The doctor said it is stable');

    const { contract, cardIds } = await finalizeTurn(
      out,
      { sessionId: session.id, turnId: 't1' },
      noRepair,
      { repos, patientId },
    );
    expect(cardIds).toHaveLength(1);
    const stored = repos.card.get(cardIds[0]!);
    expect(stored).not.toBeNull();
    expect(stored!.type).toBe('retained');
    expect(stored!.action).toEqual({ kind: 'share', target: SHARE_ROUTE_BASE });
    // The stored id is the stable shareable-link id.
    expect(contract.cards[0]!.title).toContain('Visit summary');
  });
});
