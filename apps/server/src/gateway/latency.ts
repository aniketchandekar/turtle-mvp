import type { TurnFlag } from '@turtle/shared';

/**
 * Per-turn latency instrumentation (Task 13, R16.1 / R15.4).
 *
 * A turn's audible responsiveness is measured end-of-speech → first audio byte
 * (R16.1: target < 1.5s p50, < 2.5s p95). To make regressions diagnosable rather
 * than just visible, we also record the stage breakdown along the pipeline
 * (R15.4: ASR → classify → LLM → TTS) and emit it as a structured per-turn log
 * alongside the turn's flags, mode transitions, and card emissions.
 *
 * This module is transport- and store-agnostic: the SessionChannel marks the stage
 * boundaries it can observe and hands the finished breakdown to the store and log
 * sink. The clock is injectable so timing tests are deterministic.
 *
 * Stage boundaries the gateway can observe on the turn path:
 *   endOfSpeech  — user turn committed (button release / ASR endpointing / text-in)
 *   asrFinal     — final transcript is in hand (== endOfSpeech on the text-in path)
 *   orchestrator start/done — the orchestrator produced a validated contract
 *   firstAudioByte — the first TTS PCM frame is forwarded to the client
 *
 * The orchestrator runs the classifier then the LLM inside one call, so the gateway
 * sees a single "orchestrator" span. Callers that can see the finer split (a future
 * instrumented orchestrator) may supply `classifyDoneMs` / `llmDoneMs` marks; when
 * absent we attribute the whole orchestrator span to the LLM stage and report the
 * classify stage as null rather than guessing.
 */

/** A monotonic millisecond clock. Defaults to `performance.now()`; injectable for tests. */
export type Clock = () => number;

const defaultClock: Clock = () => performance.now();

/**
 * The stage breakdown for one turn (R15.4). All spans are milliseconds, measured
 * from the boundary marks. A stage is `null` when it did not run or could not be
 * observed (e.g. classify is null when the orchestrator did not report its split;
 * tts is null in text-only degradation where no audio byte is produced).
 */
export interface LatencyBreakdown {
  /** end-of-speech → final transcript. 0 on the text-in path (no recognizer). */
  asrMs: number | null;
  /** final transcript → classifier verdict. null when the split is not reported. */
  classifyMs: number | null;
  /** classifier verdict (or transcript) → validated contract from the LLM/orchestrator. */
  llmMs: number | null;
  /** contract in hand → first audio byte forwarded. null in text-only mode. */
  ttsMs: number | null;
  /**
   * The headline figure (R16.1): end-of-speech → first audio byte. null in
   * text-only mode, where there is no audio byte to measure against.
   */
  endToFirstAudioMs: number | null;
}

/** A finished, structured per-turn timing record (R15.4). */
export interface TurnLatencyRecord {
  sessionId: string;
  turnId: string;
  breakdown: LatencyBreakdown;
  /** Non-`none` flags raised on the turn (owner-review signal, R5.5). */
  flags: TurnFlag[];
  /** Mode transitions recorded for the turn (e.g. the routed mode). */
  modeTransitions: string[];
  /** Number of cards emitted by the turn's contract (R10.1). */
  cardsEmitted: number;
  /** True when the turn ran in text-only degradation (no audible response). */
  textOnly: boolean;
}

/** A sink for structured per-turn logs. Defaults to a single-line JSON console log. */
export type LatencyLogSink = (record: TurnLatencyRecord) => void;

/**
 * Default structured log sink: one JSON line per turn on stdout. Kept intentionally
 * boring — a real observability pipeline (Task 36) can replace this sink without the
 * gateway changing. No transcript text is logged (privacy posture, R16.6).
 */
export const consoleLatencySink: LatencyLogSink = (record) => {
  const { breakdown } = record;
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      evt: 'turn_latency',
      session_id: record.sessionId,
      turn_id: record.turnId,
      end_to_first_audio_ms: round(breakdown.endToFirstAudioMs),
      asr_ms: round(breakdown.asrMs),
      classify_ms: round(breakdown.classifyMs),
      llm_ms: round(breakdown.llmMs),
      tts_ms: round(breakdown.ttsMs),
      flags: record.flags,
      mode_transitions: record.modeTransitions,
      cards_emitted: record.cardsEmitted,
      text_only: record.textOnly,
    }),
  );
};

function round(v: number | null): number | null {
  return v == null ? null : Math.round(v);
}

/**
 * Records the stage boundaries of a single turn and computes its breakdown.
 *
 * Usage (SessionChannel): create one timer per turn, `markEndOfSpeech()` when the
 * user turn commits, `markAsrFinal()` when the transcript is in hand, wrap the
 * orchestrator call with `markOrchestratorStart()`/`markOrchestratorDone()`, and
 * `markFirstAudioByte()` on the first forwarded PCM frame. Then `breakdown()`.
 *
 * Marks are idempotent-last-wins per boundary; only the first `firstAudioByte` mark
 * counts (subsequent frames are ignored) so the headline figure is the true first
 * byte, not the last.
 */
export class TurnTimer {
  private endOfSpeechAt: number | null = null;
  private asrFinalAt: number | null = null;
  private orchestratorStartAt: number | null = null;
  private classifyDoneAt: number | null = null;
  private llmDoneAt: number | null = null;
  private orchestratorDoneAt: number | null = null;
  private firstAudioByteAt: number | null = null;

  constructor(private readonly clock: Clock = defaultClock) {}

  /**
   * Mark end-of-speech. On the ASR path this boundary is captured earlier (on
   * turn_end) than when the turn begins processing, so an explicit `at` timestamp
   * may be supplied; otherwise the current clock value is used.
   */
  markEndOfSpeech(at?: number): void {
    this.endOfSpeechAt = at ?? this.clock();
  }

  markAsrFinal(): void {
    this.asrFinalAt = this.clock();
  }

  markOrchestratorStart(): void {
    this.orchestratorStartAt = this.clock();
  }

  /** Optional finer split: the classifier verdict landed (before the LLM ran). */
  markClassifyDone(): void {
    this.classifyDoneAt = this.clock();
  }

  /** Optional finer split: the LLM produced its output (before contract validation). */
  markLlmDone(): void {
    this.llmDoneAt = this.clock();
  }

  markOrchestratorDone(): void {
    this.orchestratorDoneAt = this.clock();
  }

  /** The first forwarded audio frame. Only the first call is recorded (R16.1). */
  markFirstAudioByte(): void {
    if (this.firstAudioByteAt === null) this.firstAudioByteAt = this.clock();
  }

  /** Whether the headline figure can be computed (both boundaries were marked). */
  hasFirstAudio(): boolean {
    return this.endOfSpeechAt !== null && this.firstAudioByteAt !== null;
  }

  /**
   * Compute the stage breakdown from whatever boundaries were marked. Missing
   * boundaries yield `null` stages rather than fabricated numbers.
   */
  breakdown(): LatencyBreakdown {
    const eos = this.endOfSpeechAt;
    const asrFinal = this.asrFinalAt ?? eos; // text-in path: transcript == end-of-speech.
    const orchStart = this.orchestratorStartAt ?? asrFinal;
    const orchDone = this.orchestratorDoneAt;
    const firstAudio = this.firstAudioByteAt;

    const asrMs = span(eos, asrFinal);

    // Classify/LLM split: use the finer marks when present, else attribute the whole
    // orchestrator span to the LLM stage and leave classify null (not guessed).
    let classifyMs: number | null = null;
    let llmMs: number | null = null;
    if (this.classifyDoneAt !== null && orchStart !== null) {
      classifyMs = span(orchStart, this.classifyDoneAt);
      const llmStart = this.classifyDoneAt;
      const llmEnd = this.llmDoneAt ?? orchDone;
      llmMs = span(llmStart, llmEnd);
    } else {
      llmMs = span(orchStart, orchDone);
    }

    // TTS: contract in hand → first audio byte. In text-only mode there is no audio.
    const ttsMs = span(orchDone, firstAudio);

    const endToFirstAudioMs = span(eos, firstAudio);

    return { asrMs, classifyMs, llmMs, ttsMs, endToFirstAudioMs };
  }
}

/** Non-negative span between two marks, or null when either is missing. */
function span(from: number | null, to: number | null): number | null {
  if (from === null || to === null) return null;
  const d = to - from;
  return d >= 0 ? d : 0;
}

/**
 * The p-th percentile (0–100) of a numeric sample using linear interpolation between
 * closest ranks. Empty input → null. Used to check the R16.1 p50/p95 targets from a
 * batch of recorded end-of-speech → first-audio figures.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  if (p <= 0) return Math.min(...values);
  if (p >= 100) return Math.max(...values);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loV = sorted[lo] as number;
  const hiV = sorted[hi] as number;
  if (lo === hi) return loV;
  const frac = rank - lo;
  return loV + (hiV - loV) * frac;
}

/** Convenience: the median (p50) of a sample. */
export function p50(values: readonly number[]): number | null {
  return percentile(values, 50);
}

/** Convenience: p95 of a sample. */
export function p95(values: readonly number[]): number | null {
  return percentile(values, 95);
}
