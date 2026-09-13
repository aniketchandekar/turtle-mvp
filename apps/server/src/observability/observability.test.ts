import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { QA_DECLINE_LINE } from '@turtle/shared';
import { SCHEMA_SQL } from '../store/schema.js';
import { createCipher } from '../store/crypto.js';
import { createRepositories, type Repositories } from '../store/repositories.js';
import { computeMetrics, listFlaggedTranscripts } from './index.js';

/**
 * Observability & metrics (Task 36, R15.4 / R5.5).
 *
 * Covers the READ side that this module owns:
 *   1. Owner review of flagged transcripts (R5.5) — only crisis/medical_refusal
 *      sessions surface, each with its full transcript and the specific flagged turns
 *      marked; unflagged sessions are excluded.
 *   2. Lightweight metrics — sessions/day, p50/p95 latency, refusal/crisis counts, and
 *      grounded-answer rate, computed from the persisted session/turn rows.
 *
 * Uses a real in-memory SQLite store (no mocks, no network), mirroring store.test.ts.
 */

/** Track each repos' underlying in-memory DB so tests can set deterministic timestamps. */
const dbByRepos = new WeakMap<Repositories, Database.Database>();

function makeRepos(): Repositories {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  const repos = createRepositories(db, createCipher('test-key'));
  dbByRepos.set(repos, db);
  return repos;
}

/**
 * Override a session's `started_at` for deterministic per-day grouping. The repo stamps
 * `now()` at create time with no public setter, so we write the TEXT column directly on
 * the same in-memory connection the repos closed over.
 */
function setStartedAt(repos: Repositories, sessionId: string, iso: string): void {
  const db = dbByRepos.get(repos);
  if (!db) throw new Error('no db handle registered for repos');
  db.prepare(`UPDATE session SET started_at = ? WHERE id = ?`).run(iso, sessionId);
}

describe('observability — flagged transcript owner review (R5.5)', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = makeRepos();
  });

  it('surfaces only flagged sessions, with the flagged turns marked', () => {
    const cg = repos.caregiver.create({ display_name: 'Alex' });

    // Session A: a crisis turn — should surface.
    const a = repos.session.create(cg.id);
    repos.turn.create({
      session_id: a.id, seq: 1, speaker: 'user', text: 'I want to give up',
      asr_conf: null, retrieved_chunk_ids: [], flag: null, latency_ms: null,
    });
    repos.turn.create({
      session_id: a.id, seq: 2, speaker: 'assistant', text: 'I hear you…',
      asr_conf: null, retrieved_chunk_ids: [], flag: 'crisis', latency_ms: 900,
    });
    repos.session.addFlag(a.id, 'crisis');

    // Session B: a plain check-in — should NOT surface.
    const b = repos.session.create(cg.id);
    repos.turn.create({
      session_id: b.id, seq: 1, speaker: 'assistant', text: 'How are you holding up?',
      asr_conf: null, retrieved_chunk_ids: [], flag: null, latency_ms: 800,
    });

    const flagged = listFlaggedTranscripts(repos);

    expect(flagged).toHaveLength(1);
    const t = flagged[0]!;
    expect(t.session_id).toBe(a.id);
    expect(t.flags).toEqual(['crisis']);
    expect(t.turns).toHaveLength(2);
    expect(t.flagged_turn_count).toBe(1);
    // The assistant turn (seq 2) is the flagged one; the user turn is not.
    expect(t.turns.find((x) => x.seq === 2)?.flagged).toBe(true);
    expect(t.turns.find((x) => x.seq === 1)?.flagged).toBe(false);
    // Transcript text round-trips through decryption.
    expect(t.turns.find((x) => x.seq === 1)?.text).toBe('I want to give up');
  });

  it('surfaces medical_refusal sessions too, newest first', () => {
    const cg = repos.caregiver.create({ display_name: 'Alex' });
    const older = repos.session.create(cg.id);
    repos.session.addFlag(older.id, 'medical_refusal');
    const newer = repos.session.create(cg.id);
    repos.session.addFlag(newer.id, 'crisis');

    const flagged = listFlaggedTranscripts(repos);
    expect(flagged.map((f) => f.session_id)).toEqual([newer.id, older.id]);
    expect(flagged[1]!.flags).toEqual(['medical_refusal']);
  });

  it('returns an empty list when nothing is flagged', () => {
    const cg = repos.caregiver.create({ display_name: 'Alex' });
    repos.session.create(cg.id);
    expect(listFlaggedTranscripts(repos)).toEqual([]);
  });
});

describe('observability — lightweight metrics', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = makeRepos();
  });

  it('counts total sessions and groups them per UTC day (newest first)', () => {
    const cg = repos.caregiver.create({ display_name: 'Alex' });
    // Two sessions today, one on an earlier day — override started_at directly since the
    // repo stamps "now" at create time (raw column write, matching the TEXT-time model).
    repos.session.create(cg.id);
    repos.session.create(cg.id);
    const old = repos.session.create(cg.id);
    setStartedAt(repos, old.id, '2020-01-01T10:00:00.000Z');

    const m = computeMetrics(repos);
    expect(m.total_sessions).toBe(3);
    // Newest day first; the 2020 day has exactly one session.
    expect(m.sessions_per_day[m.sessions_per_day.length - 1]).toEqual({
      date: '2020-01-01',
      count: 1,
    });
    const total = m.sessions_per_day.reduce((n, d) => n + d.count, 0);
    expect(total).toBe(3);
  });

  it('computes p50/p95 latency over turns with a recorded latency', () => {
    const cg = repos.caregiver.create({ display_name: 'Alex' });
    const s = repos.session.create(cg.id);
    const latencies = [500, 1000, 1500, 2000, 3000];
    latencies.forEach((ms, i) => {
      repos.turn.create({
        session_id: s.id, seq: i + 1, speaker: 'assistant', text: 'reply',
        asr_conf: null, retrieved_chunk_ids: [], flag: null, latency_ms: ms,
      });
    });
    // A user turn with null latency must be excluded from the sample.
    repos.turn.create({
      session_id: s.id, seq: 99, speaker: 'user', text: 'hi',
      asr_conf: null, retrieved_chunk_ids: [], flag: null, latency_ms: null,
    });

    const m = computeMetrics(repos);
    expect(m.latency_ms.count).toBe(5);
    expect(m.latency_ms.p50).toBe(1500);
    expect(m.latency_ms.p95).toBeGreaterThan(2000);
  });

  it('counts crisis and medical_refusal flags across turns', () => {
    const cg = repos.caregiver.create({ display_name: 'Alex' });
    const s = repos.session.create(cg.id);
    const mk = (seq: number, flag: string | null) =>
      repos.turn.create({
        session_id: s.id, seq, speaker: 'assistant', text: 'x',
        asr_conf: null, retrieved_chunk_ids: [], flag, latency_ms: null,
      });
    mk(1, 'crisis');
    mk(2, 'crisis');
    mk(3, 'medical_refusal');
    mk(4, null);

    const m = computeMetrics(repos);
    expect(m.flags).toEqual({ crisis: 2, medical_refusal: 1 });
  });

  it('computes the grounded-answer rate over grounded vs declined Q&A turns', () => {
    const cg = repos.caregiver.create({ display_name: 'Alex' });
    const s = repos.session.create(cg.id);

    // Two grounded answers (retrieved chunk ids present).
    repos.turn.create({
      session_id: s.id, seq: 1, speaker: 'assistant', text: 'Fatigue is common (source: c1).',
      asr_conf: null, retrieved_chunk_ids: ['c1'], flag: null, latency_ms: null,
    });
    repos.turn.create({
      session_id: s.id, seq: 2, speaker: 'assistant', text: 'Nausea can occur (source: c2).',
      asr_conf: null, retrieved_chunk_ids: ['c2'], flag: null, latency_ms: null,
    });
    // One decline (the exact decline line, no chunks).
    repos.turn.create({
      session_id: s.id, seq: 3, speaker: 'assistant', text: QA_DECLINE_LINE,
      asr_conf: null, retrieved_chunk_ids: [], flag: null, latency_ms: null,
    });
    // A checkin assistant turn (neither grounded nor declined) is ignored.
    repos.turn.create({
      session_id: s.id, seq: 4, speaker: 'assistant', text: 'How are you holding up?',
      asr_conf: null, retrieved_chunk_ids: [], flag: null, latency_ms: null,
    });

    const m = computeMetrics(repos);
    expect(m.grounded_answers.grounded).toBe(2);
    expect(m.grounded_answers.declined).toBe(1);
    expect(m.grounded_answers.rate).toBeCloseTo(2 / 3, 5);
  });

  it('reports a null grounded rate and empty metrics on an empty store', () => {
    const m = computeMetrics(repos);
    expect(m.total_sessions).toBe(0);
    expect(m.sessions_per_day).toEqual([]);
    expect(m.latency_ms).toEqual({ p50: null, p95: null, count: 0 });
    expect(m.flags).toEqual({ crisis: 0, medical_refusal: 0 });
    expect(m.grounded_answers.rate).toBeNull();
  });
});

