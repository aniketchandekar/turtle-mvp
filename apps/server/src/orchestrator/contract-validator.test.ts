import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SAFE_FALLBACK_SAY, type ModeOutput } from '@turtle/shared';
import { SCHEMA_SQL } from '../store/schema.js';
import { createCipher } from '../store/crypto.js';
import { createRepositories, type Repositories } from '../store/repositories.js';
import {
  validateOrRepair,
  applyMemoryOps,
  persistTurn,
  finalizeTurn,
  type ContractValidatorDeps,
  type RepairFn,
} from './contract-validator.js';

/**
 * Contract validation and repair (Task 15, R6.1–R6.3/R6.5).
 *
 * Covers the four paths the design requires:
 *   1. valid contract              — parses first time, becomes a full TurnContract.
 *   2. invalid → repair succeeds   — one regeneration with a repair instruction fixes it.
 *   3. invalid → repair fails      — safe fallback line, NO cards (R6.3).
 *   4. memory_ops application      — append_log → log_entry; set_fact → fact sink (R6.5).
 *
 * Plus turn/card persistence off the validated spine. Everything runs against an
 * in-memory SQLite store (matching store.test.ts) and injected repair functions —
 * no network, no real LLM.
 */

const META = { sessionId: 'sess-1', turnId: 'turn-1' } as const;

/** A minimal valid mode output the runner would emit. */
const VALID: ModeOutput = { say: 'I hear you.', cards: [], memory_ops: [], flags: ['none'] };

/** A valid mode output carrying one actionable card. */
const WITH_CARD: ModeOutput = {
  say: 'Here is a reminder.',
  cards: [
    {
      type: 'actionable',
      title: 'Call the nurse line',
      body: 'Ask about the nausea medication timing.',
      action: { kind: 'call', target: 'tel:+15551234' },
    },
  ],
  memory_ops: [],
  flags: ['none'],
};

/** A repair fn that should never be called (asserts the valid path skips repair). */
const neverRepair: RepairFn = () => {
  throw new Error('repair should not have been called');
};

function makeReposWithDb(): { repos: Repositories; db: Database.Database } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return { repos: createRepositories(db, createCipher('test-key')), db };
}

/** Seed a caregiver + patient + session and return ids + deps for persistence tests. */
function seed(repos: Repositories): { sessionId: string; patientId: string; deps: ContractValidatorDeps } {
  const cg = repos.caregiver.create({ display_name: 'Alex' });
  const patient = repos.patient.create({
    caregiver_id: cg.id,
    name: 'Sam',
    diagnosis: 'metastatic_cancer',
    diagnosis_notes: null,
    care_team: { other: [] },
  });
  const session = repos.session.create(cg.id);
  return {
    sessionId: session.id,
    patientId: patient.id,
    deps: { repos, patientId: patient.id },
  };
}

describe('validateOrRepair — valid contract (R6.1)', () => {
  it('parses a valid mode output into a full TurnContract without repairing', async () => {
    const { contract, outcome } = await validateOrRepair(VALID, META, neverRepair);
    expect(outcome).toBe('valid');
    expect(contract.session_id).toBe('sess-1');
    expect(contract.turn_id).toBe('turn-1');
    expect(contract.state).toBe('WAITING');
    expect(contract.say).toBe('I hear you.');
    expect(contract.cards).toEqual([]);
    expect(contract.flags).toEqual(['none']);
  });

  it('stamps the requested assistant state and preserves cards', async () => {
    const { contract } = await validateOrRepair(WITH_CARD, { ...META, state: 'SPEAKING' }, neverRepair);
    expect(contract.state).toBe('SPEAKING');
    expect(contract.cards).toHaveLength(1);
    expect(contract.cards[0]!.title).toBe('Call the nurse line');
  });

  it('fills defaults for a bare mode output (only say provided)', async () => {
    const { contract, outcome } = await validateOrRepair({ say: 'Just talking.' }, META, neverRepair);
    expect(outcome).toBe('valid');
    expect(contract.cards).toEqual([]);
    expect(contract.memory_ops).toEqual([]);
    expect(contract.flags).toEqual(['none']);
  });
});

describe('validateOrRepair — invalid then repair succeeds (R6.2)', () => {
  it('regenerates once with the validation error and uses the repaired output', async () => {
    const repair = vi.fn<RepairFn>(async () => VALID);
    // Invalid: empty say violates the schema (min length 1).
    const { contract, outcome } = await validateOrRepair({ say: '' }, META, repair);
    expect(outcome).toBe('repaired');
    expect(contract.say).toBe('I hear you.');
    expect(repair).toHaveBeenCalledTimes(1);
    // The repair instruction receives a non-empty validation error string.
    expect(typeof repair.mock.calls[0]![0]).toBe('string');
    expect(repair.mock.calls[0]![0].length).toBeGreaterThan(0);
  });

  it('repairs from a completely non-contract shape', async () => {
    const repair = vi.fn<RepairFn>(async () => WITH_CARD);
    const { contract, outcome } = await validateOrRepair({ nonsense: true }, META, repair);
    expect(outcome).toBe('repaired');
    expect(contract.cards).toHaveLength(1);
    expect(repair).toHaveBeenCalledTimes(1);
  });
});

describe('validateOrRepair — repair fails → safe fallback, no cards (R6.3)', () => {
  it('falls back when the regenerated output is still invalid', async () => {
    const repair = vi.fn<RepairFn>(async () => ({ say: '' })); // still invalid
    const { contract, outcome } = await validateOrRepair({ bad: 1 }, META, repair);
    expect(outcome).toBe('fallback');
    expect(contract.say).toBe(SAFE_FALLBACK_SAY);
    expect(contract.cards).toEqual([]);
    expect(contract.flags).toEqual(['none']);
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it('falls back when the repair regeneration itself throws', async () => {
    const repair = vi.fn<RepairFn>(async () => {
      throw new Error('LLM boom');
    });
    const { contract, outcome } = await validateOrRepair({ bad: 1 }, META, repair);
    expect(outcome).toBe('fallback');
    expect(contract.say).toBe(SAFE_FALLBACK_SAY);
    expect(contract.cards).toEqual([]);
  });

  it('never regenerates more than once (fallback after a single failed repair)', async () => {
    const repair = vi.fn<RepairFn>(async () => ({ still: 'invalid' }));
    await validateOrRepair({ bad: 1 }, META, repair);
    expect(repair).toHaveBeenCalledTimes(1);
  });
});

describe('applyMemoryOps — apply to the memory store (R6.5)', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = makeReposWithDb().repos;
  });

  it('applies append_log ops as log entries for the patient', () => {
    const { patientId, deps } = seed(repos);
    const applied = applyMemoryOps(
      [
        { op: 'append_log', category: 'medication_given', text: '2pm meds given', at: '2025-01-01T14:00:00.000Z' },
        { op: 'append_log', category: 'symptom', text: 'more tired today' },
      ],
      { ...deps, now: () => '2025-06-01T00:00:00.000Z' },
    );
    expect(applied).toBe(2);
    const entries = repos.logEntry.list(patientId);
    expect(entries).toHaveLength(2);
    // Most recent first (list orders by at DESC); the defaulted `at` wins.
    const texts = entries.map((e) => e.text);
    expect(texts).toContain('2pm meds given');
    expect(texts).toContain('more tired today');
  });

  it('applies add_appointment ops as appointments for the patient (Task 28, R12.1)', () => {
    const { patientId, deps } = seed(repos);
    const applied = applyMemoryOps(
      [
        {
          op: 'add_appointment',
          title: 'Follow-up',
          at: 'Tuesday at 2pm',
          with_whom: 'Dr. Lee',
          purpose: 'follow-up',
        },
        { op: 'add_appointment', title: 'Oncology', at: 'next Friday' },
      ],
      deps,
    );
    expect(applied).toBe(2);
    const upcoming = repos.appointment.listUpcoming(patientId);
    expect(upcoming).toHaveLength(2);
    const byTitle = new Map(upcoming.map((a) => [a.title, a]));
    expect(byTitle.get('Follow-up')?.with_whom).toBe('Dr. Lee');
    expect(byTitle.get('Follow-up')?.purpose).toBe('follow-up');
    expect(byTitle.get('Follow-up')?.status).toBe('upcoming');
    // Omitted optionals persist as null.
    expect(byTitle.get('Oncology')?.with_whom).toBeNull();
    expect(byTitle.get('Oncology')?.purpose).toBeNull();
  });

  it('skips add_appointment when no patient is configured (graceful, no throw)', () => {
    const applied = applyMemoryOps(
      [{ op: 'add_appointment', title: 'Orphan', at: 'someday' }],
      { repos },
    );
    expect(applied).toBe(0);
  });

  it('routes set_fact ops through the injected fact sink', () => {
    const { deps } = seed(repos);
    const factSink = vi.fn();
    const applied = applyMemoryOps(
      [{ op: 'set_fact', key: 'recurring_theme', value: 'sleep is hard' }],
      { ...deps, factSink },
    );
    expect(applied).toBe(1);
    expect(factSink).toHaveBeenCalledWith('recurring_theme', 'sleep is hard');
  });

  it('skips append_log when no patient is configured (graceful, no throw)', () => {
    const applied = applyMemoryOps(
      [{ op: 'append_log', category: 'note', text: 'orphan log' }],
      { repos },
    );
    expect(applied).toBe(0);
  });

  it('skips set_fact when no fact sink is configured', () => {
    const { deps } = seed(repos);
    const applied = applyMemoryOps([{ op: 'set_fact', key: 'k', value: 'v' }], deps);
    expect(applied).toBe(0);
  });
});

describe('persistTurn — persist the turn and cards off the validated spine', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = makeReposWithDb().repos;
  });

  it('persists the assistant turn text and any cards from the contract', async () => {
    const { sessionId, deps } = seed(repos);
    const { contract } = await validateOrRepair(WITH_CARD, { sessionId, turnId: 'turn-1' }, neverRepair);
    const { cardIds } = persistTurn(contract, deps);

    const turns = repos.turn.listBySession(sessionId);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.speaker).toBe('assistant');
    expect(turns[0]!.text).toBe('Here is a reminder.');
    expect(turns[0]!.flag).toBeNull();

    expect(cardIds).toHaveLength(1);
    const card = repos.card.get(cardIds[0]!);
    expect(card?.title).toBe('Call the nurse line');
    expect(card?.status).toBe('active');
    expect(card?.action).toEqual({ kind: 'call', target: 'tel:+15551234' });
  });

  it('records a non-none contract flag on the turn for owner review', async () => {
    const { sessionId, deps } = seed(repos);
    const flagged: ModeOutput = { say: 'I can’t advise on that.', cards: [], memory_ops: [], flags: ['medical_refusal'] };
    const { contract } = await validateOrRepair(flagged, { sessionId, turnId: 't-flag' }, neverRepair);
    persistTurn(contract, deps);
    const turns = repos.turn.listBySession(sessionId);
    expect(turns[0]!.flag).toBe('medical_refusal');
  });

  it('applies memory_ops as part of persisting the turn', async () => {
    const { sessionId, patientId, deps } = seed(repos);
    const withLog: ModeOutput = {
      say: 'Noted — 2pm meds given.',
      cards: [],
      memory_ops: [{ op: 'append_log', category: 'medication_given', text: '2pm meds given' }],
      flags: ['none'],
    };
    const { contract } = await validateOrRepair(withLog, { sessionId, turnId: 't-log' }, neverRepair);
    persistTurn(contract, deps);
    expect(repos.logEntry.list(patientId)).toHaveLength(1);
  });

  it('persists no cards for a card-free contract', async () => {
    const { sessionId, deps } = seed(repos);
    const { contract } = await validateOrRepair(VALID, { sessionId, turnId: 't-plain' }, neverRepair);
    const { cardIds } = persistTurn(contract, deps);
    expect(cardIds).toEqual([]);
    expect(repos.card.listByStatus('active')).toEqual([]);
  });
});

describe('finalizeTurn — validate/repair + persist end to end', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = makeReposWithDb().repos;
  });

  it('validates, persists, and reports the outcome + card ids (valid path)', async () => {
    const { sessionId, deps } = seed(repos);
    const res = await finalizeTurn(WITH_CARD, { sessionId, turnId: 'turn-1' }, neverRepair, deps);
    expect(res.outcome).toBe('valid');
    expect(res.contract.say).toBe('Here is a reminder.');
    expect(res.cardIds).toHaveLength(1);
    expect(repos.turn.listBySession(sessionId)).toHaveLength(1);
  });

  it('falls back and persists a card-free turn when validation + repair fail', async () => {
    const { sessionId, deps } = seed(repos);
    const repair = vi.fn<RepairFn>(async () => ({ say: '' }));
    const res = await finalizeTurn({ bad: 1 }, { sessionId, turnId: 'turn-fb' }, repair, deps);
    expect(res.outcome).toBe('fallback');
    expect(res.contract.say).toBe(SAFE_FALLBACK_SAY);
    expect(res.cardIds).toEqual([]);
    const turns = repos.turn.listBySession(sessionId);
    expect(turns[0]!.text).toBe(SAFE_FALLBACK_SAY);
  });
});
