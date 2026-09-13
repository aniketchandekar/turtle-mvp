import { AUDIO_WIRE_FORMAT } from '@turtle/shared';
import type { Config } from '../../config.js';
import type { AsrCallbacks, AsrProvider, AsrStream } from '../index.js';

/**
 * Streaming ASR integration — Deepgram (Task 9).
 *
 * Forwards captured PCM (16kHz mono linear16) to Deepgram's live transcription
 * over a per-session WebSocket, using `nova-3` with interim results and the
 * built-in VAD endpointing. Interim results surface as `transcript_interim`
 * (dimmed) and each endpointed final becomes a committed `transcript_final` user
 * turn (R3.3–R3.5). When the Deepgram key is absent or the connection errors, the
 * provider degrades to text-in (R3.6/R16.4): `open()` returns null so the channel
 * uses the `text_input` path instead.
 *
 * The Deepgram SDK is reached only through an injectable `connect` factory. That
 * keeps the SDK at the composition edge (see `deepgramAsrProvider`) and lets the
 * unit tests drive the whole interim/final/degradation surface with a fake
 * connection and zero network calls.
 */

/** Events we consume from a live Deepgram connection. */
export const DEEPGRAM_EVENTS = {
  open: 'open',
  close: 'close',
  error: 'error',
  transcript: 'Results',
} as const;

/**
 * The minimal slice of a Deepgram live connection this provider depends on. The
 * real `@deepgram/sdk` live client is structurally compatible with this; keeping
 * our own shape means the provider (and its tests) never import the SDK directly.
 */
export interface DeepgramLiveConnection {
  on(event: string, listener: (payload?: unknown) => void): void;
  /** Send a chunk of raw PCM audio to the recognizer. */
  send(data: ArrayBufferLike | Uint8Array | Buffer): void;
  /**
   * Ask Deepgram to finalize any buffered audio for the current utterance. Present
   * on the v3+ live client; guarded because older/mocked clients may omit it.
   */
  finalize?(): void;
  /** Gracefully close the socket (SDK: `requestClose` / `finish`). */
  requestClose?(): void;
  finish?(): void;
}

/** Options passed to the connection factory; mirrors Deepgram live params. */
export interface DeepgramConnectOptions {
  apiKey: string;
  model: string;
  /** linear16 / 16000 / 1, derived from the frozen audio wire format. */
  encoding: string;
  sampleRate: number;
  channels: number;
  interimResults: boolean;
}

/** Factory that opens a live Deepgram connection. Injectable for tests. */
export type DeepgramConnectFactory = (opts: DeepgramConnectOptions) => DeepgramLiveConnection;

/** Shape of a Deepgram `Results` event payload (only the fields we read). */
interface DeepgramResult {
  is_final?: boolean;
  speech_final?: boolean;
  channel?: {
    alternatives?: Array<{ transcript?: string; confidence?: number }>;
  };
}

function firstAlternative(payload: unknown): { transcript: string; confidence: number | null } | null {
  const result = payload as DeepgramResult | undefined;
  const alt = result?.channel?.alternatives?.[0];
  if (!alt) return null;
  const transcript = (alt.transcript ?? '').trim();
  const confidence = typeof alt.confidence === 'number' ? alt.confidence : null;
  return { transcript, confidence };
}

/**
 * A single per-session Deepgram recognizer. Audio pushed in flows to Deepgram;
 * interim/final transcripts flow back out through the channel callbacks.
 */
class DeepgramAsrStream implements AsrStream {
  private closed = false;
  private ready = false;
  /** True after the client ends push-to-talk and asks Deepgram to finalize. */
  private awaitingExplicitFinal = false;
  /** Audio captured before the socket signalled `open`, flushed once ready. */
  private pending: Buffer[] = [];

  constructor(
    private readonly conn: DeepgramLiveConnection,
    private readonly callbacks: AsrCallbacks,
  ) {
    this.conn.on(DEEPGRAM_EVENTS.open, () => {
      this.ready = true;
      for (const chunk of this.pending) this.safeSend(chunk);
      this.pending = [];
    });
    this.conn.on(DEEPGRAM_EVENTS.transcript, (payload) => this.onTranscript(payload));
    this.conn.on(DEEPGRAM_EVENTS.error, () => this.close());
    this.conn.on(DEEPGRAM_EVENTS.close, () => {
      this.closed = true;
    });
  }

  pushAudio(chunk: Buffer): void {
    if (this.closed) return;
    // Buffer until the socket is open so no leading audio is dropped; after that,
    // forward straight through (no server-side recording is retained — R16.6).
    if (!this.ready) {
      this.pending.push(chunk);
      return;
    }
    this.safeSend(chunk);
  }

  endTurn(): void {
    if (this.closed) return;
    // Prefer an explicit finalize so Deepgram flushes the utterance promptly on
    // button release. The resulting result may be `is_final:true` without the
    // VAD-specific `speech_final:true`, so remember that this finalization was
    // explicitly requested and accept that final result below.
    this.awaitingExplicitFinal = true;
    try {
      this.conn.finalize?.();
    } catch {
      /* best-effort: VAD endpointing will still deliver the final */
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending = [];
    try {
      this.conn.requestClose?.();
      this.conn.finish?.();
    } catch {
      /* ignore teardown errors */
    }
  }

  private onTranscript(payload: unknown): void {
    if (this.closed) return;
    const alt = firstAlternative(payload);
    if (!alt || alt.transcript.length === 0) return;

    const result = payload as DeepgramResult;
    // A committed user turn is normally a VAD endpoint (`speech_final:true`). On a
    // button release we explicitly send Finalize; Deepgram may answer that request
    // with `is_final:true, speech_final:false`. Treat that as the end of this turn
    // too, otherwise the gateway remains in THINKING waiting for an endpoint that
    // will never arrive.
    const isFinal =
      result.speech_final === true ||
      (result.is_final === true &&
        (result.speech_final == null || this.awaitingExplicitFinal));

    if (isFinal) {
      this.awaitingExplicitFinal = false;
      this.callbacks.onFinal(alt.transcript, alt.confidence);
    } else {
      this.callbacks.onInterim(alt.transcript);
    }
  }

  private safeSend(chunk: Buffer): void {
    try {
      this.conn.send(chunk);
    } catch {
      // A send failure means the recognizer is gone; degrade to text-in by closing.
      this.close();
    }
  }
}

/**
 * Build an ASR provider backed by Deepgram. `live` reflects config capability
 * (a Deepgram key is present); when not live, `open()` returns null and the
 * channel falls back to text-in.
 *
 * @param cfg     - loaded config (reads `deepgram.apiKey` / `deepgram.model`).
 * @param connect - factory that opens a live connection; injected in tests.
 */
export function createDeepgramAsrProvider(
  cfg: Config,
  connect: DeepgramConnectFactory,
): AsrProvider {
  const live = cfg.capabilities.asr.live && Boolean(cfg.deepgram.apiKey);
  return {
    live,
    open(callbacks: AsrCallbacks): AsrStream | null {
      if (!live || !cfg.deepgram.apiKey) return null;
      let conn: DeepgramLiveConnection;
      try {
        conn = connect({
          apiKey: cfg.deepgram.apiKey,
          model: cfg.deepgram.model,
          encoding: 'linear16',
          sampleRate: AUDIO_WIRE_FORMAT.sample_rate_hz,
          channels: AUDIO_WIRE_FORMAT.channels,
          interimResults: true,
        });
      } catch {
        // Failing to open a recognizer must not take the session down — degrade to
        // text-in instead (R16.4).
        return null;
      }
      return new DeepgramAsrStream(conn, callbacks);
    },
  };
}
