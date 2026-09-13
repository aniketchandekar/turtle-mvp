/**
 * Client-side voice activity detection for barge-in (Task 12, R4.3/R4.4/R16.3).
 *
 * While the assistant is SPEAKING, the client keeps a light ear on the microphone so
 * the caregiver can cut in at any moment. This module holds the ONLY detection math
 * and, like `pcm.ts`, is deliberately free of any browser API (AudioContext,
 * AudioWorklet, MediaStream) so it can be unit-tested in a plain Node environment.
 * The hook that owns the mic graph (`usePlaybackVad`) feeds float32 frames in here
 * and reacts to the boolean it returns.
 *
 * Approach: a simple, robust energy gate. We compute per-frame RMS and require speech
 * energy to hold ABOVE a threshold across several consecutive frames before declaring
 * a barge-in. That debounce keeps a single click/pop or the tail of the assistant's
 * own audio bleeding into the mic from tripping an interruption, while still firing
 * fast enough to halt playback within the 300ms budget. Detection is intentionally
 * conservative on the trigger side (avoid false interrupts) but cheap to run.
 */

/** Speech RMS threshold on the [0,1] float scale. Frames quieter than this are silence. */
export const DEFAULT_SPEECH_RMS_THRESHOLD = 0.06;

/**
 * Number of consecutive above-threshold frames required to declare speech. At the
 * ~20ms worklet cadence this is ~60ms of sustained voice — long enough to reject a
 * lone pop, short enough to stay well inside the 300ms halt budget.
 */
export const DEFAULT_SPEECH_FRAMES = 3;

/** Root-mean-square amplitude of a mono float32 frame ([-1,1] samples → [0,1] RMS). */
export function frameRms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i]!;
    sumSquares += s * s;
  }
  return Math.sqrt(sumSquares / frame.length);
}

export interface VadOptions {
  /** RMS above which a frame counts as voiced. Default {@link DEFAULT_SPEECH_RMS_THRESHOLD}. */
  threshold?: number;
  /** Consecutive voiced frames needed to fire. Default {@link DEFAULT_SPEECH_FRAMES}. */
  speechFrames?: number;
}

/**
 * A tiny streaming voice-activity detector. Push frames in with {@link accept}; it
 * returns `true` on the frame where sustained speech is first confirmed, then stays
 * latched at `true` for the rest of the utterance until {@link reset} is called.
 *
 * The detector is single-shot per activation on purpose: the caller runs it only
 * while the assistant is SPEAKING and tears it down the instant it fires the
 * barge-in, so one confirmed detection is all that is ever needed. It is stateful but
 * carries no audio buffer — just a small consecutive-frame counter.
 */
export class VoiceActivityDetector {
  private readonly threshold: number;
  private readonly speechFrames: number;
  private voicedRun = 0;
  private fired = false;

  constructor(opts: VadOptions = {}) {
    this.threshold = opts.threshold ?? DEFAULT_SPEECH_RMS_THRESHOLD;
    this.speechFrames = Math.max(1, opts.speechFrames ?? DEFAULT_SPEECH_FRAMES);
  }

  /** Whether speech has already been confirmed since the last reset. */
  get triggered(): boolean {
    return this.fired;
  }

  /**
   * Feed one mono float32 frame. Returns `true` exactly once — on the frame that
   * confirms `speechFrames` consecutive voiced frames — and `true` thereafter until
   * reset. A single sub-threshold frame breaks the run, so only sustained speech
   * (not a transient click) fires the barge-in.
   */
  accept(frame: Float32Array): boolean {
    if (this.fired) return true;
    if (frameRms(frame) >= this.threshold) {
      this.voicedRun += 1;
      if (this.voicedRun >= this.speechFrames) {
        this.fired = true;
        return true;
      }
    } else {
      this.voicedRun = 0;
    }
    return false;
  }

  /** Clear all state so the detector can be reused for the next SPEAKING window. */
  reset(): void {
    this.voicedRun = 0;
    this.fired = false;
  }
}
