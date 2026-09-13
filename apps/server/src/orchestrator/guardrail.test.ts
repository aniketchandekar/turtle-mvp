import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { MEDICAL_REFUSAL, modeOutputSchema, type CareTeam } from '@turtle/shared';
import { SCHEMA_SQL } from '../store/schema.js';
import { createCipher } from '../store/crypto.js';
import { createRepositories, type Repositories } from '../store/repositories.js';
import { finalizeTurn, type RepairFn } from './contract-validator.js';
import {
  composeMedicalRefusal,
  assertSpokenAndShown,
  pickCareTeamContact,
  contactToAction,
  composeRefusalSay,
  toTelTarget,
} from './guardrail.js';

/**
 * Medical guardrail refusal composer (Task 17, R5.3–R5.5).
 *
 * Covers the binding safety behavior:
 *   1. Refusal structure — acknowledge → state the limit → redirect (R5.3).
 *   2. Actionable card — carries the care-team contact from the profile (R5.4).
 *   3. medical_refusal flag — marks the turn for owner review (R5.5).
 *   4. Spoken-AND-shown invariant — never card-only or spoken-only (safety guardrail).
 *   5. Contact selection + tel: target parsing.
 *   6. End-to-end persistence: the flagged turn is recorded for owner review.
 *
 * The composer is deterministic (no LLM), so these run with no network. The
 * persistence test uses an in-memory SQLite store (matching store.test.ts and
 * contract-validator.test.ts).
 */

const NURSE_TEAM: CareTeam = { nurse_line: '+1 (555) 123-4567', other: [] };
const NAME_ONLY_TEAM: CareTeam = { oncologist: 'Dr. Lee', other: [] };
const EMPTY_TEAM: CareTeam = { other: [] };

describe('composeRefusalSay — acknowledge → limit → redirect (R5.3)', () => {
  it('includes the acknowledge, limit, and redirect segments in order', () => {
    const contact = pickCareTeamContact(NURSE_TEAM);
    const say = composeRefusalSay(contact);
    const ackAt = say.indexOf(MEDICAL_REFUSAL.acknowledge);
    const limitAt = say.indexOf(MEDICAL_REFUSAL.limit);
    const redirectAt = say.indexOf('care team');
    expect(ackAt).toBe(0);
    expect(limitAt).toBeGreaterThan(ackAt);
    expect(redirectAt).toBeGreaterThan(limitAt);
  });

  it('names the concrete phone contact in the redirect', () => {
    const say = composeRefusalSay(pickCareTeamContact(NURSE_TEAM));
    expect(say).toContain('nurse line');
    expect(say).toContain('+1 (555) 123-4567');
  });

  it('names a non-phone contact without pretending it is dialable', () => {
    const say = composeRefusalSay(pickCareTeamContact(NAME_ONLY_TEAM));
    expect(say).toContain('Dr. Lee');
    // A name is redirected to ("reach out to"), not offered as a number to call.
    expect(say).toContain('reach out to Dr. Lee');
  });

  it('falls back to a general care-team redirect when no contact is known', () => {
    const say = composeRefusalSay(null);
    expect(say).toContain(MEDICAL_REFUSAL.acknowledge);
    expect(say).toContain(MEDICAL_REFUSAL.limit);
    expect(say).toContain('care team');
  });
});

describe('pickCareTeamContact — contact selection priority', () => {
  it('prefers the nurse line first', () => {
    const contact = pickCareTeamContact({
      nurse_line: '555-1111',
      oncologist: 'Dr. Lee',
      social_worker: '555-2222',
      other: [],
    });
    expect(contact).toEqual({ label: 'nurse line', contact: '555-1111' });
  });

  it('falls back to oncologist, then social worker', () => {
    expect(pickCareTeamContact({ oncologist: 'Dr. Lee', social_worker: '555-2222', other: [] }))
      .toEqual({ label: 'oncologist', contact: 'Dr. Lee' });
    expect(pickCareTeamContact({ social_worker: '555-2222', other: [] }))
      .toEqual({ label: 'social worker', contact: '555-2222' });
  });

  it('falls back to the first usable other[] contact', () => {
    const contact = pickCareTeamContact({
      other: [{ label: 'Hospice', contact: '555-9999' }],
    });
    expect(contact).toEqual({ label: 'Hospice', contact: '555-9999' });
  });

  it('returns null for an empty or missing care team', () => {
    expect(pickCareTeamContact(EMPTY_TEAM)).toBeNull();
    expect(pickCareTeamContact(null)).toBeNull();
    expect(pickCareTeamContact(undefined)).toBeNull();
  });

  it('ignores blank contact strings', () => {
    expect(pickCareTeamContact({ nurse_line: '   ', oncologist: 'Dr. Lee', other: [] }))
      .toEqual({ label: 'oncologist', contact: 'Dr. Lee' });
  });
});

describe('toTelTarget / contactToAction — dialable contacts', () => {
  it('normalizes phone-like strings to tel: URIs', () => {
    expect(toTelTarget('+1 (555) 123-4567')).toBe('tel:+15551234567');
    expect(toTelTarget('555-1234')).toBe('tel:5551234');
  });

  it('returns null for non-phone contacts', () => {
    expect(toTelTarget('Dr. Lee')).toBeNull();
    expect(toTelTarget('')).toBeNull();
  });

  it('builds a call action for a phone contact and acknowledge for a name', () => {
    expect(contactToAction({ label: 'nurse line', contact: '555-1234' })).toEqual({
      kind: 'call',
      target: 'tel:5551234',
    });
    expect(contactToAction({ label: 'oncologist', contact: 'Dr. Lee' })).toEqual({
      kind: 'acknowledge',
    });
    expect(contactToAction(null)).toEqual({ kind: 'acknowledge' });
  });
});

describe('composeMedicalRefusal — full ModeOutput (R5.3–R5.5)', () => {
  it('produces a schema-valid output', () => {
    const output = composeMedicalRefusal(NURSE_TEAM);
    expect(() => modeOutputSchema.parse(output)).not.toThrow();
  });

  it('emits exactly one actionable card carrying the care-team contact (R5.4)', () => {
    const output = composeMedicalRefusal(NURSE_TEAM);
    expect(output.cards).toHaveLength(1);
    const card = output.cards[0]!;
    expect(card.type).toBe('actionable');
    expect(card.title).toBe(MEDICAL_REFUSAL.card_title);
    expect(card.action).toEqual({ kind: 'call', target: 'tel:+15551234567' });
    expect(card.body).toContain('+1 (555) 123-4567');
  });

  it('sets the medical_refusal flag for owner review (R5.5)', () => {
    expect(composeMedicalRefusal(NURSE_TEAM).flags).toEqual(['medical_refusal']);
    expect(composeMedicalRefusal(EMPTY_TEAM).flags).toEqual(['medical_refusal']);
  });

  it('carries no memory ops (a refusal records nothing to memory)', () => {
    expect(composeMedicalRefusal(NURSE_TEAM).memory_ops).toEqual([]);
  });

  it('still emits an actionable card even with no known contact', () => {
    const output = composeMedicalRefusal(EMPTY_TEAM);
    expect(output.cards).toHaveLength(1);
    expect(output.cards[0]!.type).toBe('actionable');
    expect(output.cards[0]!.action).toEqual({ kind: 'acknowledge' });
    expect(output.cards[0]!.body).toBe(MEDICAL_REFUSAL.card_body);
  });

  it('names a non-phone contact in the card body without a call action', () => {
    const output = composeMedicalRefusal(NAME_ONLY_TEAM);
    expect(output.cards[0]!.body).toContain('Dr. Lee');
    expect(output.cards[0]!.action).toEqual({ kind: 'acknowledge' });
  });
});

describe('assertSpokenAndShown — spoken AND shown invariant (safety guardrail)', () => {
  it('passes for a well-formed refusal (both spoken and shown)', () => {
    expect(() => assertSpokenAndShown(composeMedicalRefusal(NURSE_TEAM))).not.toThrow();
    expect(() => assertSpokenAndShown(composeMedicalRefusal(EMPTY_TEAM))).not.toThrow();
  });

  it('throws when the refusal would be card-only (no spoken line)', () => {
    const cardOnly = { ...composeMedicalRefusal(NURSE_TEAM), say: '   ' } as ReturnType<
      typeof composeMedicalRefusal
    >;
    expect(() => assertSpokenAndShown(cardOnly)).toThrow(/spoken/);
  });

  it('throws when the refusal would be spoken-only (no actionable card)', () => {
    const spokenOnly = { ...composeMedicalRefusal(NURSE_TEAM), cards: [] } as ReturnType<
      typeof composeMedicalRefusal
    >;
    expect(() => assertSpokenAndShown(spokenOnly)).toThrow(/shown/);
  });

  it('throws when the medical_refusal flag is missing', () => {
    const unflagged = { ...composeMedicalRefusal(NURSE_TEAM), flags: ['none'] } as ReturnType<
      typeof composeMedicalRefusal
    >;
    expect(() => assertSpokenAndShown(unflagged)).toThrow(/owner review/);
  });

  it('composeMedicalRefusal output always satisfies the invariant across contact shapes', () => {
    for (const team of [NURSE_TEAM, NAME_ONLY_TEAM, EMPTY_TEAM, null]) {
      expect(() => assertSpokenAndShown(composeMedicalRefusal(team))).not.toThrow();
    }
  });
});

describe('guardrail refusal — end-to-end persistence marks the turn for owner review (R5.5)', () => {
  let repos: Repositories;
  const neverRepair: RepairFn = () => {
    throw new Error('repair should not be called for a valid refusal');
  };

  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    repos = createRepositories(db, createCipher('test-key'));
  });

  it('persists the spoken refusal, the actionable card, and the medical_refusal flag', async () => {
    const cg = repos.caregiver.create({ display_name: 'Alex' });
    const patient = repos.patient.create({
      caregiver_id: cg.id,
      name: 'Sam',
      diagnosis: 'metastatic_cancer',
      diagnosis_notes: null,
      care_team: NURSE_TEAM,
    });
    const session = repos.session.create(cg.id);

    // Medical-flagged turns bypass routing; the composer's output flows through the
    // same validate-before-speaking + persistence path as any other turn (Task 15).
    const refusal = composeMedicalRefusal(patient.care_team);
    const res = await finalizeTurn(
      refusal,
      { sessionId: session.id, turnId: 'turn-med' },
      neverRepair,
      { repos, patientId: patient.id },
    );

    expect(res.outcome).toBe('valid');
    expect(res.cardIds).toHaveLength(1);

    // The turn is marked medical_refusal for owner review.
    const turns = repos.turn.listBySession(session.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.flag).toBe('medical_refusal');
    expect(turns[0]!.text).toBe(refusal.say);

    // The actionable care-team card is persisted (spoken AND shown, verifiably).
    const card = repos.card.get(res.cardIds[0]!);
    expect(card?.type).toBe('actionable');
    expect(card?.action).toEqual({ kind: 'call', target: 'tel:+15551234567' });
    expect(card?.status).toBe('active');
  });
});
