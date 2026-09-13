import { pcm16ToFloat32 } from './pcm';

/**
 * Low-latency Web Audio player for incoming TTS PCM chunks.
 *
 * The gateway streams `audio_chunk` binary frames (16 kHz mono signed 16-bit PCM,
 * per AUDIO_WIRE_FORMAT). This player schedules each chunk back-to-back on a single
 * AudioContext timeline so playback is gapless, while keeping only a small lead
 * buffer (~150–250ms) ahead of the playhead — matching the frozen latency budget
 * (R4.2, design.md "player buffer tuned to ~150–250ms").
 *
 * Scheduling model: we track `nextStartTime`, the AudioContext time at which the next
 * chunk should begin. Each chunk is scheduled at max(now + minLeadSeconds,
 * nextStartTime). The first chunk of a stream is offset by `targetBufferSeconds` so a
 * small cushion accumulates before audio reaches the speakers; subsequent chunks
 * simply append, so the added buffering stays bounded rather than growing per chunk.
 *
 * Barge-in / interrupt: `flush()` stops all scheduled sources immediately and resets
 * the timeline so the next turn starts fresh with the same small cushion.
 */
export interface PcmPlayerOptions {
  /** Wire sample rate of incoming PCM. Defaults to 16 kHz per the contract. */
  sampleRate?: number;
  /** Target lead buffer in seconds. Kept within the 150–250ms budget. */
  targetBufferSeconds?: number;
  /** Optional shared AudioContext (else one is created lazily). */
  context?: AudioContext;
  /**
   * Fired once the last scheduled chunk finishes playing and the queue has fully
   * drained — i.e. the current utterance has finished at the speakers. Used to gate
   * card rendering so a card appears only after its spoken content ends (R10.3/R16.2),
   * never interrupting speech. NOT fired after {@link flush} (barge-in): an interrupted
   * utterance did not "finish".
   */
  onIdle?: () => void;
}

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_TARGET_BUFFER = 0.2; // 200ms, centered in the 150–250ms budget
const MIN_LEAD = 0.02; // never schedule in the past; keep a tiny safety margin

export class PcmPlayer {
  private ctx: AudioContext | null;
  private readonly ownsContext: boolean;
  private readonly sampleRate: number;
  private readonly targetBufferSeconds: number;
  private readonly onIdle?: () => void;
  private gain: GainNode | null = null;

  /** AudioContext time where the next chunk should start. */
  private nextStartTime = 0;
  /** Sources currently scheduled, so flush() can stop them. */
  private readonly scheduled = new Set<AudioBufferSourceNode>();
  /**
   * Monotonic id of the current playback stream. Bumped on flush() so a stale
   * `onended` from a stopped source can never fire the idle signal for a stream that
   * was interrupted rather than allowed to finish.
   */
  private streamId = 0;

  constructor(opts: PcmPlayerOptions = {}) {
    this.sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.targetBufferSeconds = clampBuffer(opts.targetBufferSeconds ?? DEFAULT_TARGET_BUFFER);
    this.onIdle = opts.onIdle;
    this.ctx = opts.context ?? null;
    this.ownsContext = !opts.context;
  }

  /** Lazily create the AudioContext + gain node on first use (needs a user gesture). */
  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
    }
    if (!this.gain) {
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  /**
   * True when nothing is currently scheduled to play — the queue has drained (or was
   * flushed) and no chunk is pending at the speakers. Used to resolve the race where a
   * turn_contract lands after its audio already finished: the idle edge has passed, so
   * the caller flushes the gated card immediately instead of waiting for an `onIdle`
   * that will not fire again.
   */
  isIdle(): boolean {
    return this.scheduled.size === 0;
  }

  /** Resume a suspended context (browsers start suspended until a user gesture). */
  async resume(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();
  }

  /**
   * Enqueue one incoming PCM chunk for gapless playback. Safe to call rapidly as
   * chunks stream in; the lead buffer stays bounded near `targetBufferSeconds`.
   */
  enqueue(pcm: ArrayBuffer): void {
    const samples = pcm16ToFloat32(pcm);
    if (samples.length === 0) return;

    const ctx = this.ensureContext();
    const buffer = ctx.createBuffer(1, samples.length, this.sampleRate);
    // Write via the channel's own Float32Array to sidestep the strict
    // Float32Array<ArrayBuffer> vs ArrayBufferLike typing on copyToChannel.
    buffer.getChannelData(0).set(samples);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain ?? ctx.destination);

    const now = ctx.currentTime;
    // If the timeline has drained (or is stale), start a fresh cushion ahead of now.
    // Otherwise append right after the previously scheduled chunk (gapless).
    const earliest = now + MIN_LEAD;
    let startAt: number;
    if (this.nextStartTime < earliest) {
      startAt = now + this.targetBufferSeconds;
    } else {
      startAt = this.nextStartTime;
    }

    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;

    this.scheduled.add(source);
    const streamId = this.streamId;
    source.onended = () => {
      this.scheduled.delete(source);
      // Signal end-of-utterance only when this stream fully drains and was not
      // interrupted by a flush() in the meantime (streamId still current). Chunks
      // arrive faster than they play, so the last chunk's `onended` is the reliable
      // "speech finished" edge; any later chunk re-enters this block harmlessly.
      if (this.scheduled.size === 0 && streamId === this.streamId) {
        this.onIdle?.();
      }
    };
  }

  /**
   * Stop everything immediately and reset the timeline (barge-in / interrupt).
   * The next enqueue() begins a fresh stream with the standard cushion.
   */
  flush(): void {
    // Invalidate the current stream so no pending `onended` fires the idle signal:
    // an interrupted utterance did not finish and must not surface a gated card.
    this.streamId += 1;
    for (const source of this.scheduled) {
      try {
        source.onended = null;
        source.stop();
        source.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.scheduled.clear();
    this.nextStartTime = 0;
  }

  /** Tear down. Closes the context only if this player created it. */
  async close(): Promise<void> {
    this.flush();
    if (this.gain) {
      try {
        this.gain.disconnect();
      } catch {
        /* ignore */
      }
      this.gain = null;
    }
    if (this.ownsContext && this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        /* ignore */
      }
      this.ctx = null;
    }
  }
}

/** Keep the lead buffer within the frozen 150–250ms latency budget. */
function clampBuffer(seconds: number): number {
  const min = 0.15;
  const max = 0.25;
  if (seconds < min) return min;
  if (seconds > max) return max;
  return seconds;
}
