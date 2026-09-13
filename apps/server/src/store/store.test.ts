import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';
import { createCipher } from './crypto.js';
import { createRepositories, type Repositories } from './repositories.js';

// Keep a handle on the raw DB so tests can inspect ciphertext-at-rest, not just
// the decrypted round-trip. `repos` alone can't see the underlying column bytes.
function makeReposWithDb(): { repos: Repositories; db: Database.Database } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return { repos: createRepositories(db, createCipher('test-key')), db };
}

function makeRepos(): Repositories {
  return makeReposWithDb().repos;
}

describe('crypto', () => {
  it('round-trips encrypted values and tolerates plaintext', () => {
    const c = createCipher('k');
    const enc = c.encrypt('sensitive note');
    expect(enc).toMatch(/^enc:v1:/);
    expect(c.decrypt(enc)).toBe('sensitive note');
    expect(c.decrypt('legacy-plaintext')).toBe('legacy-plaintext');
    expect(c.encrypt(null)).toBeNull();
  });
});

describe('repositories', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = makeRepos();
  });

  it('creates caregiver, patient, and encrypts care team on disk', () => {
    const cg = repos.caregiver.create({ display_name: 'Alex' });
    const patient = repos.patient.create({
      caregiver_id: cg.id,
      name: 'Sam',
      diagnosis: 'metastatic_cancer',
      diagnosis_notes: null,
      care_team: { nurse_line: '555-1234', other: [] },
    });
    const fetched = repos.patient.get(patient.id);
    expect(fetched?.care_team.nurse_line).toBe('555-1234');
  });

  it('stores and retrieves log entries with decryption', () => {
    const cg = repos.caregiver.create({ display_name: 'Alex' });
    const patient = repos.patient.create({
      caregiver_id: cg.id,
      name: 'Sam',
      diagnosis: 'metastatic_cancer',
      diagnosis_notes: null,
      care_team: { other: [] },
    });
    repos.logEntry.create({ patient_id: patient.id, at: new Date().toISOString(), category: 'symptom', text: 'new cough', structured: null });
    const entries = repos.logEntry.list(patient.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe('new cough');
  });

  it('tracks session transitions, flags, turns, and next seq', () => {
    const cg = repos.caregiver.create({ display_name: 'Alex' });
    const s = repos.session.create(cg.id);
    repos.session.appendTransition(s.id, 'checkin');
    repos.session.addFlag(s.id, 'crisis');
    repos.session.addFlag(s.id, 'crisis'); // dedup
    expect(repos.turn.nextSeq(s.id)).toBe(1);
    repos.turn.create({ session_id: s.id, seq: 1, speaker: 'user', text: 'hi', asr_conf: null, retrieved_chunk_ids: [], flag: null, latency_ms: null });
    expect(repos.turn.nextSeq(s.id)).toBe(2);
    const reloaded = repos.session.get(s.id);
    expect(reloaded?.mode_transitions).toEqual(['checkin']);
    expect(reloaded?.flags).toEqual(['crisis']);
  });

  it('manages card lifecycle', () => {
    const cg = repos.caregiver.create({ display_name: 'Alex' });
    const s = repos.session.create(cg.id);
    const card = repos.card.create({ session_id: s.id, type: 'retained', title: 'Q', body: 'body', action: null });
    expect(repos.card.listByStatus('active')).toHaveLength(1);
    repos.card.setStatus(card.id, 'dismissed');
    expect(repos.card.listByStatus('active')).toHaveLength(0);
    expect(repos.card.listByStatus('dismissed')).toHaveLength(1);
  });

  it('round-trips appointments and filters upcoming (R1.3)', () => {
    const cg = repos.caregiver.create({ display_name: 'Alex' });
    const patient = repos.patient.create({
      caregiver_id: cg.id,
      name: 'Sam',
      diagnosis: 'metastatic_cancer',
      diagnosis_notes: null,
      care_team: { other: [] },
    });
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    repos.appointment.create({ patient_id: patient.id, title: 'Oncology', with_whom: 'Dr. Lee', at: future, purpose: 'follow-up' });
    const cancelled = repos.appointment.create({ patient_id: patient.id, title: 'Labs', with_whom: null, at: past, purpose: null });
    repos.appointment.updateStatus(cancelled.id, 'cancelled');
    const upcoming = repos.appointment.listUpcoming(patient.id);
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]?.title).toBe('Oncology');
    expect(repos.appointment.nextUpcoming(patient.id)?.title).toBe('Oncology');
  });

  it('round-trips kb chunks including JSON embedding column (R1.3)', () => {
    repos.kbChunk.upsert({
      id: 'chunk-1',
      diagnosis: 'metastatic_cancer',
      source_url: 'https://example.org',
      title: 'Nausea',
      content_md: '# Nausea\nSome content.',
      embedding: [0.1, 0.2, 0.3],
    });
    // Idempotent upsert (re-runnable) with a lexical-fallback (null embedding) row.
    repos.kbChunk.upsert({
      id: 'chunk-2',
      diagnosis: 'metastatic_cancer',
      source_url: null,
      title: null,
      content_md: 'plain',
      embedding: null,
    });
    const chunks = repos.kbChunk.listByDiagnosis('metastatic_cancer');
    expect(chunks).toHaveLength(2);
    const c1 = chunks.find((c) => c.id === 'chunk-1');
    expect(c1?.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(chunks.find((c) => c.id === 'chunk-2')?.embedding).toBeNull();
  });

  it('stores caregiver prefs and turn JSON columns round-trip (R1.3)', () => {
    const cg = repos.caregiver.create({
      display_name: 'Alex',
      prefs: { voice_id: 'v1', pace: 1.0, checkin_time: '09:00' },
    });
    expect(repos.caregiver.get(cg.id)?.prefs).toEqual({ voice_id: 'v1', pace: 1.0, checkin_time: '09:00' });

    const s = repos.session.create(cg.id);
    repos.turn.create({
      session_id: s.id,
      seq: 1,
      speaker: 'assistant',
      text: 'hello there',
      asr_conf: 0.9,
      retrieved_chunk_ids: ['chunk-1', 'chunk-2'],
      flag: null,
      latency_ms: 1200,
    });
    const turns = repos.turn.listBySession(s.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toBe('hello there');
    expect(turns[0]?.retrieved_chunk_ids).toEqual(['chunk-1', 'chunk-2']);
    expect(turns[0]?.latency_ms).toBe(1200);
  });

  describe('encryption at rest (R16.6)', () => {
    it('stores patient care-team contacts as ciphertext, not plaintext', () => {
      const { repos: r, db } = makeReposWithDb();
      const cg = r.caregiver.create({ display_name: 'Alex' });
      const patient = r.patient.create({
        caregiver_id: cg.id,
        name: 'Sam',
        diagnosis: 'metastatic_cancer',
        diagnosis_notes: null,
        care_team: { nurse_line: '555-1234', oncologist: 'Dr. Lee', other: [] },
      });
      const raw = db.prepare(`SELECT care_team FROM patient WHERE id = ?`).get(patient.id) as {
        care_team: string;
      };
      // Raw column must be encrypted: prefixed ciphertext, with no plaintext leak.
      expect(raw.care_team).toMatch(/^enc:v1:/);
      expect(raw.care_team).not.toContain('555-1234');
      expect(raw.care_team).not.toContain('Dr. Lee');
      // ...and it must decrypt transparently on read.
      expect(r.patient.get(patient.id)?.care_team.nurse_line).toBe('555-1234');
    });

    it('stores log-entry text as ciphertext, not plaintext', () => {
      const { repos: r, db } = makeReposWithDb();
      const cg = r.caregiver.create({ display_name: 'Alex' });
      const patient = r.patient.create({
        caregiver_id: cg.id,
        name: 'Sam',
        diagnosis: 'metastatic_cancer',
        diagnosis_notes: null,
        care_team: { other: [] },
      });
      const entry = r.logEntry.create({
        patient_id: patient.id,
        at: new Date().toISOString(),
        category: 'symptom',
        text: 'severe nausea after lunch',
        structured: null,
      });
      const raw = db.prepare(`SELECT text FROM log_entry WHERE id = ?`).get(entry.id) as {
        text: string;
      };
      expect(raw.text).toMatch(/^enc:v1:/);
      expect(raw.text).not.toContain('severe nausea');
      expect(r.logEntry.list(patient.id)[0]?.text).toBe('severe nausea after lunch');
    });

    it('stores turn transcript text as ciphertext, not plaintext', () => {
      const { repos: r, db } = makeReposWithDb();
      const cg = r.caregiver.create({ display_name: 'Alex' });
      const s = r.session.create(cg.id);
      const turn = r.turn.create({
        session_id: s.id,
        seq: 1,
        speaker: 'user',
        text: 'I am scared about the diagnosis',
        asr_conf: null,
        retrieved_chunk_ids: [],
        flag: null,
        latency_ms: null,
      });
      const raw = db.prepare(`SELECT text FROM turn WHERE id = ?`).get(turn.id) as { text: string };
      expect(raw.text).toMatch(/^enc:v1:/);
      expect(raw.text).not.toContain('scared');
      expect(r.turn.listBySession(s.id)[0]?.text).toBe('I am scared about the diagnosis');
    });
  });

  it('records consent and merges caregiver prefs (Task 33, R16.10)', () => {
    const cg = repos.caregiver.create({ display_name: 'Alex' });
    expect(repos.caregiver.get(cg.id)?.consent_at).toBeNull();
    repos.caregiver.setConsent(cg.id);
    expect(repos.caregiver.get(cg.id)?.consent_at).toBeTruthy();

    repos.caregiver.updatePrefs(cg.id, { checkin_time: '08:30', voice_id: 'v1' });
    repos.caregiver.updatePrefs(cg.id, { pace: 1.0 });
    const prefs = repos.caregiver.get(cg.id)?.prefs;
    expect(prefs).toEqual({ checkin_time: '08:30', voice_id: 'v1', pace: 1.0 });

    // Unknown caregiver is a no-op returning null.
    expect(repos.caregiver.updatePrefs('missing', { pace: 1.0 })).toBeNull();
  });

  it('deletes everything', () => {
    const cg = repos.caregiver.create({ display_name: 'Alex' });
    repos.session.create(cg.id);
    repos.deleteEverything();
    expect(repos.caregiver.get(cg.id)).toBeNull();
  });
});
