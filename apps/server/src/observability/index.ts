import { QA_DECLINE_LINE, type Session, type Turn, type TurnFlag } from '@turtle/shared';
import type { Repositories } from '../store/index.js';
import { p50, p95 } from '../gateway/latency.js';

/**
 * Observability & metrics (Task 36, R15.4 / R5.5).
 *
 * The per-turn STRUCTURED LOG (latency breakdown → flags → mode transitions → card
 * emissions) is already emitted at the point a turn completes: the gateway hands a
 * {@link TurnLatencyRecord} to its {@link LatencyLogSink} (see `gateway/latency.ts`,
 * `consoleLatencySink`) and persists the headline latency, flags, mode transitions and
 * cards onto the session/turn rows. This module is the READ side of that data — it does
 * not re-instrument anything, it reads the store the gateway already wrote:
 *
 *   1. Owner review of flagged transcripts (R5.5): every session that carries a
 *      crisis / medical_refusal flag, with its full turn transcript and the specific
 *      turns marked. Human-in-the-loop by design (design.md §Observability).
 *
 *   2. Lightweight metrics (design.md §Observability): sessions/day, p50/p95 response
 *      latency, refusal/crisis counts, and grounded-answer rate — a small snapshot the
 *      owner can pull without a full analytics pipeline.
 *
 * Everything is a pure read over injected {@link Repositories}, so the whole surface is
 * unit-testable against an in-memory store with zero network. No transcript text leaves
 * this module except through the owner-review view, which is the owner's own data
 * (single-user MVP; scope by owner in a multi-user build).
 */

/** The two owner-review flags. `none` is not a review signal. */
const REVIEW_FLAGS: readonly TurnFlag[] = ['crisis', 'medical_refusal'] as const;

// ---------------------------------------------------------------------------
// Owner review of flagged transcripts (R5.5)
// ---------------------------------------------------------------------------

/** One turn inside a flagged transcript, with its owner-review flag surfaced. */
export interface FlaggedTurn {
  id: string;
  seq: number;
  speaker: Turn['speaker'];
  text: string;
  /** The turn's flag, or null. Non-null flags are the reason the turn is marked. */
  flag: string | null;
  /** True when this specific turn carries an owner-review flag (crisis/medical_refusal). */
  flagged: boolean;
}

/** A flagged session surfaced for owner review: the session, its flags, and its turns. */
export interface FlaggedTranscript {
  session_id: string;
  caregiver_id: string;
  started_at: string;
  ended_at: string | null;
  /** The owner-review flags accumulated on the session (crisis / medical_refusal). */
  flags: string[];
  /** The full turn transcript, with the flagged turns marked for quick scanning. */
  turns: FlaggedTurn[];
  /** Count of turns in this session that carry an owner-review flag. */
  flagged_turn_count: number;
}

/**
 * Build the owner review view: every session marked with a crisis or medical_refusal
 * flag (R5.5), newest first, each with its full transcript and the specific flagged
 * turns marked. Reads only what the gateway already persisted — the session's
 * accumulated `flags` and each turn's `flag`.
 */
export function listFlaggedTranscripts(repos: Repositories): FlaggedTranscript[] {
  return repos.session.listFlagged().map((session) => toFlaggedTranscript(repos, session));
}

function toFlaggedTranscript(repos: Repositories, session: Session): FlaggedTranscript {
  const turns = repos.turn.listBySession(session.id).map<FlaggedTurn>((t) => ({
    id: t.id,
    seq: t.seq,
    speaker: t.speaker,
    text: t.text,
    flag: t.flag,
    flagged: isReviewFlag(t.flag),
  }));
  return {
    session_id: session.id,
    caregiver_id: session.caregiver_id,
    started_at: session.started_at,
    ended_at: session.ended_at,
    flags: session.flags,
    turns,
    flagged_turn_count: turns.filter((t) => t.flagged).length,
  };
}

/** True when a turn/flag string is one of the owner-review flags (not `none`/null). */
function isReviewFlag(flag: string | null): boolean {
  return flag != null && (REVIEW_FLAGS as readonly string[]).includes(flag);
}

// ---------------------------------------------------------------------------
// Lightweight metrics (design.md §Observability)
// ---------------------------------------------------------------------------

/** A single day's session count, keyed by UTC calendar date (YYYY-MM-DD). */
export interface SessionsPerDay {
  date: string;
  count: number;
}

/** The lightweight metrics snapshot. */
export interface MetricsSnapshot {
  /** Total sessions ever started. */
  total_sessions: number;
  /** Sessions started per UTC day, newest day first. */
  sessions_per_day: SessionsPerDay[];
  /** Response-latency percentiles over recorded turns (end-of-speech → first audio, ms). */
  latency_ms: { p50: number | null; p95: number | null; count: number };
  /** Owner-review flag counts across all turns. */
  flags: { crisis: number; medical_refusal: number };
  /**
   * Grounded-answer rate for Q&A (R8.x / R15.2): of the assistant turns that either
   * grounded an answer in retrieved KB chunks OR declined ("one for your care team"),
   * the share that were grounded. `rate` is null when there were no such turns.
   */
  grounded_answers: { grounded: number; declined: number; rate: number | null };
}

/**
 * Compute the lightweight metrics snapshot from the store. Pure read over all sessions
 * and turns; uses the same percentile helpers the latency targets are checked with.
 */
export function computeMetrics(repos: Repositories): MetricsSnapshot {
  const sessions = repos.session.listAll();
  const turns = repos.turn.listAll();

  const sessionsPerDay = countSessionsPerDay(sessions);

  // Latency percentiles over the persisted headline figures (turns with no audio byte
  // — text-only or user turns — have null latency_ms and are excluded).
  const latencies = turns
    .map((t) => t.latency_ms)
    .filter((v): v is number => typeof v === 'number');

  const flags = countTurnFlags(turns);
  const grounded = groundedAnswerStats(turns);

  return {
    total_sessions: sessions.length,
    sessions_per_day: sessionsPerDay,
    latency_ms: { p50: p50(latencies), p95: p95(latencies), count: latencies.length },
    flags,
    grounded_answers: grounded,
  };
}

/** Count sessions per UTC calendar day from their `started_at`, newest day first. */
function countSessionsPerDay(sessions: Session[]): SessionsPerDay[] {
  const byDay = new Map<string, number>();
  for (const s of sessions) {
    const date = utcDate(s.started_at);
    if (date === null) continue;
    byDay.set(date, (byDay.get(date) ?? 0) + 1);
  }
  return [...byDay.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** The YYYY-MM-DD UTC calendar date of an ISO timestamp, or null when unparseable. */
function utcDate(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Count owner-review flags across turns. Flags are recorded on the assistant turn
 * (`turn.flag`) when a turn is crisis/medical_refusal; `none`/null turns don't count.
 */
function countTurnFlags(turns: Turn[]): { crisis: number; medical_refusal: number } {
  let crisis = 0;
  let medical_refusal = 0;
  for (const t of turns) {
    if (t.flag === 'crisis') crisis++;
    else if (t.flag === 'medical_refusal') medical_refusal++;
  }
  return { crisis, medical_refusal };
}

/**
 * Grounded-answer stats. A Q&A turn is GROUNDED when the assistant turn carries the
 * retrieved-chunk provenance (`retrieved_chunk_ids` non-empty, written by the Q&A mode,
 * R8.1). A Q&A turn DECLINED when the assistant spoke the exact decline line
 * ({@link QA_DECLINE_LINE}) — the only path that answers a diagnosis question without
 * grounding. The rate is grounded / (grounded + declined); null when there were none.
 *
 * Turns from other modes (checkin/log/prep) neither ground nor decline, so they are not
 * counted in either bucket — the rate reflects Q&A behavior only.
 */
function groundedAnswerStats(
  turns: Turn[],
): { grounded: number; declined: number; rate: number | null } {
  let grounded = 0;
  let declined = 0;
  for (const t of turns) {
    if (t.speaker !== 'assistant') continue;
    if (t.retrieved_chunk_ids.length > 0) grounded++;
    else if (isDeclineLine(t.text)) declined++;
  }
  const total = grounded + declined;
  return { grounded, declined, rate: total === 0 ? null : grounded / total };
}

/** True when the assistant text is the Q&A decline line (whitespace/case-insensitive). */
function isDeclineLine(text: string): boolean {
  return normalize(text) === normalize(QA_DECLINE_LINE);
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}
