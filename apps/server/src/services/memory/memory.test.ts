import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Caregiver, Patient } from '@turtle/shared';
import { SCHEMA_SQL } from '../../store/schema.js';
import { createCipher } from '../../store/crypto.js';
import { createRepositories, type Repositories } from '../../store/repositories.js';
import { createMemoryService, recallLine, relativeWhen } from './index.js';

function makeRepos(): Repositories {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return createRepositories(db, createCipher('test-key'));
}

/** Seed a caregiver + patient with the given care team, returning both. */
function seedCaregiverAndPatient(
  repos: Repositories,
  careTeam: Patient['care_team'] = { other: [] },
): { caregiver: Caregiver; patient: Patient } {
  const caregiver = repos.caregiver.create({ display_name: 'Alex' });
  const patient = repos.patient.create({
    caregiver_id: caregiver.id,
    name: 'Sam',
    diagnosis: 'metastatic_cancer',
    diagnosis_notes: 'private clinical notes that must NOT leak into context',
    care_team: careTeam,
  });
  return { caregiver, patient };
}

/** Create an ended session whose recap card body is `summary`. */
function seedEndedSessionWithSummary(repos: Repositories, caregiverId: string, summary: string): void {
  const session = repos.session.create(caregiverId);
  const card = repos.card.create({
    session_id: session.id,
    type: 'retained',
    title: 'Recap',
    body: summary,
    action: null,
  });
  repos.session.close(session.id, card.id);
}

describe('memory service — profile facts (R9.1)', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = makeRepos();
  });

  it('includes only patient, diagnosis, care-team, and next appointment', async () => {
    const { caregiver, patient } = seedCaregiverAndPatient(repos, {
      nurse_line: '555-1234',
      oncologist: 'Dr. Lee',
      other: [{ label: 'Palliative Care', contact: '555-9000' }],
    });
    const future = new Date(Date.now() + 86_400_000).toISOString();
    repos.appointment.create({
      patient_id: patient.id,
      title: 'Oncology follow-up',
      with_whom: 'Dr. Lee',
      at: future,
      purpose: 'scan review',
    });

    const mem = createMemoryService({ repos });
    const ctx = await mem.assemble(caregiver.id);

    expect(ctx.profileFacts.patient).toBe('Sam');
    expect(ctx.profileFacts.diagnosis).toBe('metastatic_cancer');
    expect(ctx.profileFacts['care_team.nurse_line']).toBe('555-1234');
    expect(ctx.profileFacts['care_team.oncologist']).toBe('Dr. Lee');
    expect(ctx.profileFacts['care_team.palliative_care']).toBe('555-9000');
    expect(ctx.profileFacts.next_appointment).toContain('Oncology follow-up');
    expect(ctx.profileFacts.next_appointment).toContain('Dr. Lee');
  });

  it('never leaks diagnosis notes or other patient fields into profile facts', async () => {
    const { caregiver } = seedCaregiverAndPatient(repos);
    const mem = createMemoryService({ repos });
    const ctx = await mem.assemble(caregiver.id);

    const serialized = JSON.stringify(ctx.profileFacts);
    expect(serialized).not.toContain('private clinical notes');
    // Allowed keys only: patient, diagnosis (+ care_team.* / next_appointment).
    for (const key of Object.keys(ctx.profileFacts)) {
      expect(
        key === 'patient' ||
          key === 'diagnosis' ||
          key === 'next_appointment' ||
          key.startsWith('care_team.'),
      ).toBe(true);
    }
  });

  it('surfaces only the NEXT upcoming appointment, not history or later ones', async () => {
    const { caregiver, patient } = seedCaregiverAndPatient(repos);
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    const later = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    repos.appointment.create({ patient_id: patient.id, title: 'Soon visit', with_whom: null, at: soon, purpose: null });
    repos.appointment.create({ patient_id: patient.id, title: 'Later visit', with_whom: null, at: later, purpose: null });
    repos.appointment.create({ patient_id: patient.id, title: 'Old visit', with_whom: null, at: past, purpose: null });

    const mem = createMemoryService({ repos });
    const ctx = await mem.assemble(caregiver.id);

    expect(ctx.profileFacts.next_appointment).toContain('Soon visit');
    expect(ctx.profileFacts.next_appointment).not.toContain('Later visit');
    expect(ctx.profileFacts.next_appointment).not.toContain('Old visit');
  });

  it('omits next_appointment when none upcoming', async () => {
    const { caregiver } = seedCaregiverAndPatient(repos);
    const mem = createMemoryService({ repos });
    const ctx = await mem.assemble(caregiver.id);
    expect(ctx.profileFacts.next_appointment).toBeUndefined();
  });

  it('returns empty context when no patient profile exists', async () => {
    const caregiver = repos.caregiver.create({ display_name: 'Alex' });
    const mem = createMemoryService({ repos });
    const ctx = await mem.assemble(caregiver.id);
    expect(ctx.profileFacts).toEqual({});
    expect(ctx.recentSummaries).toEqual([]);
    expect(ctx.recall).toEqual([]);
  });
});

describe('memory service — recent session summaries (R9.2)', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = makeRepos();
  });

  it('includes only the last 3 session summaries, most recent last, never transcripts', async () => {
    const { caregiver } = seedCaregiverAndPatient(repos);
    // Four ended sessions; created in order S1..S4 (S4 is most recent).
    for (const s of ['S1', 'S2', 'S3', 'S4']) {
      seedEndedSessionWithSummary(repos, caregiver.id, `${s} summary line`);
    }

    const mem = createMemoryService({ repos });
    const ctx = await mem.assemble(caregiver.id);

    // Only 3, dropping the oldest (S1), and ordered oldest→newest for chronological read.
    expect(ctx.recentSummaries).toEqual(['S2 summary line', 'S3 summary line', 'S4 summary line']);
  });

  it('skips ended sessions with no recap card', async () => {
    const { caregiver } = seedCaregiverAndPatient(repos);
    seedEndedSessionWithSummary(repos, caregiver.id, 'has summary');
    // Ended session without a recap card contributes no line.
    const bare = repos.session.create(caregiver.id);
    repos.session.close(bare.id);

    const mem = createMemoryService({ repos });
    const ctx = await mem.assemble(caregiver.id);
    expect(ctx.recentSummaries).toEqual(['has summary']);
  });

  it('ignores in-flight (not-yet-ended) sessions', async () => {
    const { caregiver } = seedCaregiverAndPatient(repos);
    repos.session.create(caregiver.id); // open session, no summary yet
    const mem = createMemoryService({ repos });
    const ctx = await mem.assemble(caregiver.id);
    expect(ctx.recentSummaries).toEqual([]);
  });
});

describe('memory service — mode-gated log recall (R9.3/R9.4)', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = makeRepos();
  });

  it('excludes recall by default (mode did not request it)', async () => {
    const { caregiver, patient } = seedCaregiverAndPatient(repos);
    repos.logEntry.create({
      patient_id: patient.id,
      at: new Date().toISOString(),
      category: 'symptom',
      text: 'a cough',
      structured: null,
    });

    const mem = createMemoryService({ repos });
    const ctx = await mem.assemble(caregiver.id);
    expect(ctx.recall).toEqual([]);
  });

  it('includes recall only when the mode requests it', async () => {
    const now = new Date('2025-01-08T12:00:00.000Z'); // a Wednesday
    const { caregiver, patient } = seedCaregiverAndPatient(repos);
    repos.logEntry.create({
      patient_id: patient.id,
      at: '2025-01-06T09:00:00.000Z', // Monday
      category: 'symptom',
      text: 'a cough',
      structured: null,
    });

    const mem = createMemoryService({ repos, now: () => now });
    const ctx = await mem.assemble(caregiver.id, { includeRecall: true });
    expect(ctx.recall).toEqual(['You noted a cough on Monday.']);
  });

  it('recall is stated as recall, not advice — no imperatives or judgment', async () => {
    const now = new Date('2025-01-08T12:00:00.000Z');
    const { caregiver, patient } = seedCaregiverAndPatient(repos);
    repos.logEntry.create({
      patient_id: patient.id,
      at: '2025-01-07T20:00:00.000Z', // yesterday
      category: 'sleep',
      text: 'he slept badly',
      structured: null,
    });

    const mem = createMemoryService({ repos, now: () => now });
    const ctx = await mem.assemble(caregiver.id, { includeRecall: true });

    expect(ctx.recall).toHaveLength(1);
    const line = ctx.recall[0]!;
    // Recall frame: echoes the caregiver's own words, anchored in time.
    expect(line).toBe('You noted he slept badly yesterday.');
    // Never advice / interpretation.
    for (const banned of ['you should', 'try to', 'i recommend', 'make sure', 'consider ', 'it might mean']) {
      expect(line.toLowerCase()).not.toContain(banned);
    }
  });

  it('bounds recall by look-back window and line count', async () => {
    const now = new Date('2025-01-10T12:00:00.000Z');
    const { caregiver, patient } = seedCaregiverAndPatient(repos);
    // Two recent entries within the window.
    repos.logEntry.create({ patient_id: patient.id, at: '2025-01-09T09:00:00.000Z', category: 'food', text: 'ate little', structured: null });
    repos.logEntry.create({ patient_id: patient.id, at: '2025-01-08T09:00:00.000Z', category: 'symptom', text: 'more nausea', structured: null });
    // One well outside a 7-day window.
    repos.logEntry.create({ patient_id: patient.id, at: '2024-12-01T09:00:00.000Z', category: 'note', text: 'old note', structured: null });

    const mem = createMemoryService({ repos, now: () => now });

    const windowed = await mem.assemble(caregiver.id, { includeRecall: true });
    expect(windowed.recall).toHaveLength(2);
    expect(windowed.recall.join(' ')).not.toContain('old note');

    const capped = await mem.assemble(caregiver.id, { includeRecall: true, maxRecallLines: 1 });
    expect(capped.recall).toHaveLength(1);
  });
});

describe('memory service — apply memory ops', () => {
  it('applies append_log ops to the patient log via the shared write path', async () => {
    const repos = makeRepos();
    const { patient } = seedCaregiverAndPatient(repos);
    const mem = createMemoryService({ repos });

    await mem.apply(patient.id, [
      { op: 'append_log', category: 'symptom', text: 'new cough', at: '2025-01-01T00:00:00.000Z' },
    ]);

    const entries = repos.logEntry.list(patient.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe('new cough');
    expect(entries[0]?.category).toBe('symptom');
  });
});

describe('recall phrasing helpers (R9.4)', () => {
  const now = new Date('2025-01-08T12:00:00.000Z'); // Wednesday

  it('relativeWhen renders today / yesterday / weekday / date', () => {
    expect(relativeWhen('2025-01-08T08:00:00.000Z', now)).toBe('today');
    expect(relativeWhen('2025-01-07T08:00:00.000Z', now)).toBe('yesterday');
    expect(relativeWhen('2025-01-06T08:00:00.000Z', now)).toBe('on Monday');
    expect(relativeWhen('2024-12-20T08:00:00.000Z', now)).toBe('on 2024-12-20');
    expect(relativeWhen('not-a-date', now)).toBe('recently');
  });

  it('recallLine echoes verbatim text with a neutral recall frame', () => {
    expect(recallLine('  a cough  ', '2025-01-06T08:00:00.000Z', now)).toBe(
      'You noted a cough on Monday.',
    );
  });
});
