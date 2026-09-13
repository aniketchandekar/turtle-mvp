import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { CRISIS_RESOURCES, modeOutputSchema, type CareTeam, type ModeOutput } from '@turtle/shared';
import { SCHEMA_SQL } from '../store/schema.js';
import { createCipher } from '../store/crypto.js';
import { createRepositories, type Repositories } from '../store/repositories.js';
import { finalizeTurn, type RepairFn } from './contract-validator.js';
import {
  composeCrisisResponse,
  assertCrisisSpokenAndShown,
  enforceCrisisSpokenAndShown,
} from './crisis.js';

/**
 * Crisis protocol composer (Task 31, R13.1–R13.5 / R5.5).
 *
 * Covers the binding safety behavior:
 *   1. Gentle validating response that speaks the 988 resources and encourages
 *      contacting the care team / a trusted person (R13.1 / R13.2).
 *   2. Safety card carrying the same resources, dialable via tel:988 (R13.3).
 *   3. crisis flag — marks the turn for owner review (R13.4 / R5.5).
 *   4. Spoken-AND-shown invariant — never card-only or spoken-only (R13.5); the guard
 *      rejects malformed outputs and the enforcer repairs them to the full protocol.
 *   5. Bypasses normal conversation — no memory ops, no routing (R13.1).
 *   6. End-to-end persistence: the flagged turn is recorded for owner review.
 *
 * The composer is deterministic (no LLM), so these run with no network. The
 * persistence test uses an in-memory SQLite store (matching guardrail.test.ts).
 */

const NURSE_TEAM: CareTeam = { nurse_line: '+1 (555) 123-4567', other: [] };
const NAME_ONLY_TEAM: CareTeam = { oncologist: 'Dr. Lee', other: [] };
const EMPTY_TEAM: CareTeam = { other: [] };

describe('composeCrisisResponse — gentle, validating, speaks 988 (R13.1 / R13.2)', () => {
  it('produces a schema-valid output', () => {
    expect(() => modeOutputSchema.parse(composeCrisisResponse(NURSE_TEAM))).not.toThrow();
    expect(() => modeOutputSchema.parse(composeCrisisResponse(null))).not.toThrow();
  });

  it('speaks the 988 lifeline and encourages contacting the care team / a trusted person', () => {
    const say = composeCrisisResponse(NURSE_TEAM).say;
    expect(say).toBe(CRISIS_RESOURCES.spoken);
    expect(say).toContain('988');
    expect(say.toLowerCase()).toContain('care team');
    expect(say.toLowerCase()).toContain('trust');
  });

  it('does not continue normal conversation: no memory ops, no advice (R13.1)', () => {
    const output = composeCrisisResponse(NURSE_TEAM);
    expect(output.memory_ops).toEqual([]);
  });
});

describe('composeCrisisResponse — safety card, spoken AND shown (R13.3)', () => {
  it('emits exactly one safety card with the 988 resources and a tel:988 call action', () => {
    const output = composeCrisisResponse(EMPTY_TEAM);
    expect(output.cards).toHaveLength(1);
    const card = output.cards[0]!;
    expect(card.type).toBe('safety');
    expect(card.title).toBe(CRISIS_RESOURCES.card_title);
    expect(card.body).toContain('988');
    expect(card.action).toEqual({ kind: 'call', target: 'tel:988' });
  });

  it('names a known care-team contact in the card body as an additional human to reach', () => {
    const output = composeCrisisResponse(NURSE_TEAM);
    const card = output.cards[0]!;
    expect(card.body).toContain('988');
    // The contact label is capitalized when it opens the "also reach …" clause.
    expect(card.body).toContain('Nurse line');
    expect(card.body).toContain('+1 (555) 123-4567');
    // The primary action is always the always-available lifeline (one tap to 988).
    expect(card.action).toEqual({ kind: 'call', target: 'tel:988' });
  });

  it('falls back to the plain 988 card body when no contact is known', () => {
    const output = composeCrisisResponse(null);
    expect(output.cards[0]!.body).toBe(CRISIS_RESOURCES.card_body);
  });

  it('names a non-phone contact in the body without changing the 988 call action', () => {
    const output = composeCrisisResponse(NAME_ONLY_TEAM);
    expect(output.cards[0]!.body).toContain('Dr. Lee');
    expect(output.cards[0]!.action).toEqual({ kind: 'call', target: 'tel:988' });
  });
});

describe('composeCrisisResponse — crisis flag for owner review (R13.4 / R5.5)', () => {
  it('sets the crisis flag across contact shapes', () => {
    for (const team of [NURSE_TEAM, NAME_ONLY_TEAM, EMPTY_TEAM, null]) {
      expect(composeCrisisResponse(team).flags).toEqual(['crisis']);
    }
  });
});

describe('assertCrisisSpokenAndShown — spoken AND shown invariant (R13.5)', () => {
  it('passes for a well-formed crisis response (both spoken and shown)', () => {
    expect(() => assertCrisisSpokenAndShown(composeCrisisResponse(NURSE_TEAM))).not.toThrow();
    expect(() => assertCrisisSpokenAndShown(composeCrisisResponse(null))).not.toThrow();
  });

  it('throws when the response would be card-only (no spoken line)', () => {
    const cardOnly = { ...composeCrisisResponse(NURSE_TEAM), say: '   ' } as ModeOutput;
    expect(() => assertCrisisSpokenAndShown(cardOnly)).toThrow(/spoken/);
  });

  it('throws when the response would be spoken-only (no safety card)', () => {
    const spokenOnly = { ...composeCrisisResponse(NURSE_TEAM), cards: [] } as ModeOutput;
    expect(() => assertCrisisSpokenAndShown(spokenOnly)).toThrow(/shown/);
  });

  it('throws when the safety card carries no resources (empty body)', () => {
    const emptyBody: ModeOutput = {
      ...composeCrisisResponse(NURSE_TEAM),
      cards: [{ type: 'safety', title: CRISIS_RESOURCES.card_title, body: '   ' }],
    };
    expect(() => assertCrisisSpokenAndShown(emptyBody)).toThrow(/resources/);
  });

  it('throws when the crisis flag is missing', () => {
    const unflagged = { ...composeCrisisResponse(NURSE_TEAM), flags: ['none'] } as ModeOutput;
    expect(() => assertCrisisSpokenAndShown(unflagged)).toThrow(/owner review/);
  });

  it('composeCrisisResponse output always satisfies the invariant across contact shapes', () => {
    for (const team of [NURSE_TEAM, NAME_ONLY_TEAM, EMPTY_TEAM, null]) {
      expect(() => assertCrisisSpokenAndShown(composeCrisisResponse(team))).not.toThrow();
    }
  });
});

describe('enforceCrisisSpokenAndShown — repairs to the full protocol, never one channel', () => {
  it('returns a well-formed crisis response unchanged', () => {
    const good = composeCrisisResponse(NURSE_TEAM);
    expect(enforceCrisisSpokenAndShown(good, NURSE_TEAM)).toBe(good);
  });

  it('repairs a card-only crisis response back to the canonical spoken-AND-shown protocol', () => {
    const cardOnly = { ...composeCrisisResponse(NURSE_TEAM), say: '   ' } as ModeOutput;
    const repaired = enforceCrisisSpokenAndShown(cardOnly, NURSE_TEAM);
    expect(() => assertCrisisSpokenAndShown(repaired)).not.toThrow();
    expect(repaired.say).toBe(CRISIS_RESOURCES.spoken);
    expect(repaired.cards[0]!.type).toBe('safety');
  });

  it('repairs a spoken-only crisis response back to the full protocol (adds the safety card)', () => {
    const spokenOnly = { ...composeCrisisResponse(NURSE_TEAM), cards: [] } as ModeOutput;
    const repaired = enforceCrisisSpokenAndShown(spokenOnly, NURSE_TEAM);
    expect(() => assertCrisisSpokenAndShown(repaired)).not.toThrow();
    expect(repaired.cards).toHaveLength(1);
    expect(repaired.cards[0]!.type).toBe('safety');
  });
});

describe('crisis protocol — end-to-end persistence marks the turn for owner review (R13.4 / R5.5)', () => {
  let repos: Repositories;
  const neverRepair: RepairFn = () => {
    throw new Error('repair should not be called for a valid crisis response');
  };

  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    repos = createRepositories(db, createCipher('test-key'));
  });

  it('persists the spoken crisis line, the safety card, and the crisis flag', async () => {
    const cg = repos.caregiver.create({ display_name: 'Alex' });
    const patient = repos.patient.create({
      caregiver_id: cg.id,
      name: 'Sam',
      diagnosis: 'metastatic_cancer',
      diagnosis_notes: null,
      care_team: NURSE_TEAM,
    });
    const session = repos.session.create(cg.id);

    // Crisis-flagged turns bypass routing; the composer's output flows through the same
    // validate-before-speaking + persistence path as any other turn (Task 15).
    const crisis = composeCrisisResponse(patient.care_team);
    const res = await finalizeTurn(
      crisis,
      { sessionId: session.id, turnId: 'turn-crisis' },
      neverRepair,
      { repos, patientId: patient.id },
    );

    expect(res.outcome).toBe('valid');
    expect(res.cardIds).toHaveLength(1);

    // The turn is marked crisis for owner review.
    const turns = repos.turn.listBySession(session.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.flag).toBe('crisis');
    expect(turns[0]!.text).toBe(crisis.say);

    // The safety card is persisted (spoken AND shown, verifiably).
    const card = repos.card.get(res.cardIds[0]!);
    expect(card?.type).toBe('safety');
    expect(card?.action).toEqual({ kind: 'call', target: 'tel:988' });
    expect(card?.status).toBe('active');
    expect(card?.body).toContain('988');
  });
});
