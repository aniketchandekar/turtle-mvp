import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../store/schema.js';
import { createCipher } from '../store/crypto.js';
import { createRepositories, type Repositories } from '../store/repositories.js';
import { createOnboardingEngine, OnboardingConflictError } from './engine.js';

function fixture(start = '2026-01-01T00:00:00.000Z') {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  const repos = createRepositories(db, createCipher('onboarding-test-key'));
  repos.caregiver.create({ id: 'caregiver-1', display_name: null });
  let ms = new Date(start).getTime();
  const engine = createOnboardingEngine({ repos, now: () => new Date(ms) });
  return { db, repos, engine, advance(seconds: number) { ms += seconds * 1000; } };
}

function answerCurrent(ctx: ReturnType<typeof fixture>, value: string) {
  const prompt = ctx.engine.getSnapshot('caregiver-1').prompt;
  if (!prompt) throw new Error('no prompt');
  return ctx.engine.answer('caregiver-1', prompt.id, value, 'typed').snapshot;
}

function confirmCurrent(ctx: ReturnType<typeof fixture>) {
  const prompt = ctx.engine.getSnapshot('caregiver-1').prompt;
  if (!prompt) throw new Error('no prompt');
  return ctx.engine.confirmSection('caregiver-1', prompt.id).snapshot;
}

function reachPatient(ctx: ReturnType<typeof fixture>) {
  ctx.engine.resume('caregiver-1');
  answerCurrent(ctx, 'I agree');
  answerCurrent(ctx, 'Alex');
  answerCurrent(ctx, 'daughter');
  answerCurrent(ctx, 'Nearby');
  answerCurrent(ctx, 'Both are okay');
  answerCurrent(ctx, 'I am the decision-maker');
  answerCurrent(ctx, 'My sleep is interrupted');
  confirmCurrent(ctx);
  answerCurrent(ctx, 'Yes, authorized');
}

describe('caregiver-first onboarding engine', () => {
  it('requires auditable AI consent before caregiver data and patient authorization before health data', () => {
    const ctx = fixture();
    let snapshot = ctx.engine.resume('caregiver-1');
    expect(snapshot.currentStep).toBe('ai_data_consent');
    snapshot = answerCurrent(ctx, 'I agree');
    expect(snapshot.currentStep).toBe('caregiver_name');
    expect(ctx.repos.consentRecord.latest('caregiver-1', 'ai_data_processing')?.evidence).toBe('I agree');

    for (const value of ['Alex', 'daughter', 'Nearby', 'English', 'I am the decision-maker', 'sleep is poor']) {
      snapshot = answerCurrent(ctx, value);
    }
    expect(snapshot.currentStep).toBe('caregiver_review');
    snapshot = confirmCurrent(ctx);
    expect(snapshot.currentStep).toBe('patient_authorization');
    snapshot = answerCurrent(ctx, 'Yes, authorized');
    expect(snapshot.currentStep).toBe('patient_name');
    expect(ctx.repos.consentRecord.list('caregiver-1').map((r) => r.consent_type)).toEqual([
      'ai_data_processing', 'patient_information',
    ]);
  });

  it('stores raw plus conservative normalization and confirms drafts only at section review', () => {
    const ctx = fixture();
    ctx.engine.resume('caregiver-1');
    answerCurrent(ctx, 'I agree');
    answerCurrent(ctx, 'Alexandra');
    answerCurrent(ctx, 'Her daughter');
    const distance = answerCurrent(ctx, 'I live nearby');
    expect(distance.answers.caregiver_distance).toMatchObject({ raw: 'I live nearby', normalized: 'nearby', confirmedAt: null });
    answerCurrent(ctx, 'Spanish');
    answerCurrent(ctx, 'My brother makes decisions');
    const review = answerCurrent(ctx, 'I barely sleep');
    expect(review.answers.decision_maker?.confirmedAt).toBeTruthy();
    expect(review.answers.caregiver_name?.confirmedAt).toBeNull();
    const confirmed = confirmCurrent(ctx);
    expect(confirmed.answers.caregiver_name?.confirmedAt).toBeTruthy();
    expect(confirmed.locale).toBe('es');
  });

  it('persists skips and the exact resume step, and rejects stale duplicate events', () => {
    const ctx = fixture();
    const first = ctx.engine.resume('caregiver-1').prompt!;
    const afterConsent = ctx.engine.answer('caregiver-1', first.id, 'I agree', 'voice').snapshot;
    expect(() => ctx.engine.answer('caregiver-1', first.id, 'duplicate', 'typed')).toThrow(OnboardingConflictError);
    const namePrompt = afterConsent.prompt!;
    const skipped = ctx.engine.skip('caregiver-1', namePrompt.id).snapshot;
    expect(skipped.answers.caregiver_name?.skipped).toBe(true);
    const paused = ctx.engine.pause('caregiver-1', skipped.prompt!.id).snapshot;
    expect(paused.status).toBe('paused');
    expect(paused.currentStep).toBe('caregiver_relationship');
    const resumed = ctx.engine.resume('caregiver-1');
    expect(resumed.currentStep).toBe('caregiver_relationship');
    expect(resumed.missingRequired).toContain('caregiver_name');
  });

  it('adds the hospice agency and 24-hour line only for hospice families', () => {
    const ctx = fixture();
    reachPatient(ctx);
    const answers: Record<string, string> = {
      patient_name: 'Rosa', patient_age: 'about 70', cancer_type: 'metastatic breast cancer', care_phase: 'Hospice',
      last_treatment_date: '2026-01-01', last_treatment_type: 'Chemotherapy', clinic: 'Hill Clinic', oncologist: 'Dr. Lee',
      after_hours_number: '512 555 0199', baseline_pain: '4 out of 10', baseline_breathing: 'normal',
      baseline_nutrition: 'eating less', baseline_alertness: 'alert', baseline_fever: 'none', medication_concern: 'morphine',
      hospice_agency: 'Kind Hospice', hospice_phone: '512-555-0100',
    };
    const visited: string[] = [];
    for (;;) {
      const snapshot = ctx.engine.getSnapshot('caregiver-1');
      if (snapshot.currentStep === 'patient_review') break;
      visited.push(snapshot.currentStep);
      answerCurrent(ctx, answers[snapshot.currentStep] ?? 'unknown');
    }
    expect(visited).toContain('hospice_agency');
    expect(visited).toContain('hospice_phone');
  });

  it('warns after 13 active minutes and automatically pauses at 15 without losing the step', () => {
    const ctx = fixture();
    ctx.engine.resume('caregiver-1');
    ctx.advance(781);
    const warned = answerCurrent(ctx, 'I agree');
    expect(warned.prompt?.warning).toMatch(/two minutes/i);
    const step = warned.currentStep;
    ctx.advance(120);
    const capped = answerCurrent(ctx, 'Alex');
    expect(capped.status).toBe('paused');
    expect(capped.currentStep).toBe(step);
    expect(capped.answers.caregiver_name).toBeUndefined();
  });

  it('interrupts dangerous answers and returns to the unchanged saved prompt', () => {
    const ctx = fixture();
    reachPatient(ctx);
    const before = ctx.engine.getSnapshot('caregiver-1');
    const result = ctx.engine.answer('caregiver-1', before.prompt!.id, "I can't go on anymore", 'voice');
    expect(result.safetyMessage).toMatch(/urgent/i);
    expect(result.snapshot.currentStep).toBe('patient_name');
    expect(result.snapshot.answers.patient_name).toBeUndefined();
  });
});

describe('onboarding persistence and consent audit', () => {
  let repos: Repositories;
  beforeEach(() => { repos = fixture().repos; });

  it('encrypts the profile document at rest and returns a decrypted round trip', () => {
    const ctx = fixture();
    ctx.engine.resume('caregiver-1');
    answerCurrent(ctx, 'I agree');
    answerCurrent(ctx, 'Highly distinctive caregiver name');
    const stored = ctx.db.prepare('SELECT profile FROM onboarding_profile WHERE caregiver_id = ?').get('caregiver-1') as { profile: string };
    expect(stored.profile).toMatch(/^enc:v1:/);
    expect(stored.profile).not.toContain('Highly distinctive caregiver name');
    expect(ctx.repos.onboardingProfile.get('caregiver-1')?.answers.caregiver_name?.raw).toBe('Highly distinctive caregiver name');
  });

  it('keeps grant and revoke entries append-only', () => {
    const base = { caregiver_id: 'caregiver-1', consent_type: 'outbound_ai_call' as const, actor: 'Alex', authority_basis: null, subject: 'Alex', capture_method: 'typed' as const, disclosure_version: 'v1', locale: 'en' as const };
    repos.consentRecord.append({ ...base, action: 'granted', evidence: 'yes' });
    repos.consentRecord.append({ ...base, action: 'revoked', evidence: 'stop calls' });
    expect(repos.consentRecord.list('caregiver-1').map((r) => r.action)).toEqual(['granted', 'revoked']);
    expect(repos.consentRecord.latest('caregiver-1', 'outbound_ai_call')?.action).toBe('revoked');
  });
});
