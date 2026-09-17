import { AUDIO_WIRE_FORMAT } from '@turtle/shared';
import type { Config } from '../../config.js';
import type { AsrCallbacks, AsrProvider, AsrStream } from '../index.js';
import { voiceLog } from '../voice-log.js';

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
  /** Keep an idle live-transcription socket open between caregiver turns. */
  keepAlive?(): void;
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
  /** Nova multilingual recognition for English/Spanish code-switching. */
  language: 'multi';
}

/** Factory that opens a live Deepgram connection. Injectable for tests. */
export type DeepgramConnectFactory = (opts: DeepgramConnectOptions) => DeepgramLiveConnection;

let nextDiagnosticStreamId = 0;

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
  private readonly diagnosticStreamId = ++nextDiagnosticStreamId;
  private closed = false;
  private ready = false;
  private intentionalClose = false;
  private unavailableNotified = false;
  /** True after the client ends push-to-talk and asks Deepgram to finalize. */
  private awaitingExplicitFinal = false;
  /** Finalize as soon as a still-connecting socket becomes ready. */
  private finalizeWhenReady = false;
  /** Audio captured before the socket signalled `open`, flushed once ready. */
  private pending: Buffer[] = [];
  /** Deepgram closes idle sockets after roughly 10 seconds without this heartbeat. */
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private keepAliveCount = 0;
  private sentChunkCount = 0;
  private sentByteCount = 0;

  constructor(
    private readonly conn: DeepgramLiveConnection,
    private readonly callbacks: AsrCallbacks,
  ) {
    voiceLog('asr_stream_created', { asr_stream_id: this.diagnosticStreamId });
    this.conn.on(DEEPGRAM_EVENTS.open, () => {
      this.ready = true;
      const pendingChunks = this.pending.length;
      const pendingBytes = this.pending.reduce((total, chunk) => total + chunk.byteLength, 0);
      voiceLog('asr_connection_open', {
        asr_stream_id: this.diagnosticStreamId,
        pending_chunks: pendingChunks,
        pending_bytes: pendingBytes,
        finalize_pending: this.finalizeWhenReady,
      });
      for (const chunk of this.pending) this.safeSend(chunk);
      this.pending = [];
      if (this.finalizeWhenReady) {
        this.finalizeWhenReady = false;
        this.sendFinalize();
      }
      this.startKeepAlive();
      this.callbacks.onReady?.();
    });
    this.conn.on(DEEPGRAM_EVENTS.transcript, (payload) => this.onTranscript(payload));
    this.conn.on(DEEPGRAM_EVENTS.error, () => {
      voiceLog('asr_connection_error', { asr_stream_id: this.diagnosticStreamId }, 'error');
      this.notifyUnavailable('Speech recognition connection failed.');
      this.close();
    });
    this.conn.on(DEEPGRAM_EVENTS.close, (payload) => {
      const unexpectedly = !this.intentionalClose && !this.closed;
      voiceLog('asr_connection_closed', {
        asr_stream_id: this.diagnosticStreamId,
        intentional: !unexpectedly,
        close_code: closeCode(payload),
        sent_chunks: this.sentChunkCount,
        sent_bytes: this.sentByteCount,
      }, unexpectedly ? 'warn' : 'info');
      this.closed = true;
      this.ready = false;
      this.pending = [];
      this.stopKeepAlive();
      if (unexpectedly) this.notifyUnavailable('Speech recognition disconnected.');
    });
  }

  pushAudio(chunk: Buffer): void {
    if (this.closed) {
      voiceLog('asr_audio_dropped', {
        asr_stream_id: this.diagnosticStreamId,
        reason: 'stream_closed',
        chunk_bytes: chunk.byteLength,
      }, 'warn');
      return;
    }
    // Buffer until the socket is open so no leading audio is dropped; after that,
    // forward straight through (no server-side recording is retained — R16.6).
    if (!this.ready) {
      this.pending.push(chunk);
      if (this.pending.length === 1) {
        voiceLog('asr_audio_buffering', {
          asr_stream_id: this.diagnosticStreamId,
          first_chunk_bytes: chunk.byteLength,
        });
      }
      return;
    }
    this.safeSend(chunk);
  }

  endTurn(): void {
    if (this.closed) {
      voiceLog('asr_finalize_skipped', {
        asr_stream_id: this.diagnosticStreamId,
        reason: 'stream_closed',
      }, 'warn');
      return;
    }
    voiceLog('asr_end_turn', {
      asr_stream_id: this.diagnosticStreamId,
      ready: this.ready,
      pending_chunks: this.pending.length,
      sent_chunks: this.sentChunkCount,
      sent_bytes: this.sentByteCount,
    });
    // Prefer an explicit finalize so Deepgram flushes the utterance promptly on
    // button release. The resulting result may be `is_final:true` without the
    // VAD-specific `speech_final:true`, so remember that this finalization was
    // explicitly requested and accept that final result below.
    // Do not ask the SDK to finalize before its socket is open. SDK v3 queues that
    // control frame internally but never flushes the queue, so the turn would remain
    // in THINKING forever. Audio is already buffered above; flush then finalize on open.
    if (!this.ready) {
      this.finalizeWhenReady = true;
      return;
    }
    this.sendFinalize();
  }

  close(): void {
    if (this.closed) return;
    this.intentionalClose = true;
    this.closed = true;
    this.ready = false;
    this.pending = [];
    this.stopKeepAlive();
    voiceLog('asr_stream_closing', {
      asr_stream_id: this.diagnosticStreamId,
      sent_chunks: this.sentChunkCount,
      sent_bytes: this.sentByteCount,
    });
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
      voiceLog('asr_transcript_final', {
        asr_stream_id: this.diagnosticStreamId,
        characters: alt.transcript.length,
        confidence: alt.confidence,
      });
      this.callbacks.onFinal(alt.transcript, alt.confidence);
    } else {
      voiceLog('asr_transcript_interim', {
        asr_stream_id: this.diagnosticStreamId,
        characters: alt.transcript.length,
      });
      this.callbacks.onInterim(alt.transcript);
    }
  }

  private safeSend(chunk: Buffer): void {
    try {
      this.conn.send(chunk);
      this.sentChunkCount += 1;
      this.sentByteCount += chunk.byteLength;
      if (this.sentChunkCount === 1) {
        voiceLog('asr_audio_forwarding_started', {
          asr_stream_id: this.diagnosticStreamId,
          first_chunk_bytes: chunk.byteLength,
        });
      }
    } catch {
      // A send failure means the recognizer is gone; degrade to text-in by closing.
      this.notifyUnavailable('Speech recognition stopped receiving audio.');
      this.close();
    }
  }

  private sendFinalize(): void {
    this.awaitingExplicitFinal = true;
    voiceLog('asr_finalize_sent', {
      asr_stream_id: this.diagnosticStreamId,
      sent_chunks: this.sentChunkCount,
      sent_bytes: this.sentByteCount,
    });
    try {
      this.conn.finalize?.();
    } catch {
      this.notifyUnavailable('Speech recognition could not finish the turn.');
      this.close();
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    // Deepgram requires an idle-audio KeepAlive every 3–5 seconds. This matters most
    // during Turtle's welcome speech, before the caregiver sends their first audio.
    this.keepAliveTimer = setInterval(() => {
      if (this.closed || !this.ready) return;
      try {
        this.conn.keepAlive?.();
        this.keepAliveCount += 1;
        if (this.keepAliveCount === 1 || this.keepAliveCount % 5 === 0) {
          voiceLog('asr_keepalive_sent', {
            asr_stream_id: this.diagnosticStreamId,
            sequence: this.keepAliveCount,
          });
        }
      } catch {
        this.notifyUnavailable('Speech recognition keepalive failed.');
        this.close();
      }
    }, 4_000);
    this.keepAliveTimer.unref?.();
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer === null) return;
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  private notifyUnavailable(message: string): void {
    if (this.intentionalClose || this.unavailableNotified) return;
    this.unavailableNotified = true;
    this.callbacks.onUnavailable?.(message);
  }
}

function closeCode(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object' || !('code' in payload)) return null;
  const code = (payload as { code?: unknown }).code;
  return typeof code === 'number' ? code : null;
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
      voiceLog('asr_open_requested', {
        provider: 'deepgram',
        model: cfg.deepgram.model,
        sample_rate_hz: AUDIO_WIRE_FORMAT.sample_rate_hz,
        channels: AUDIO_WIRE_FORMAT.channels,
      });
      let conn: DeepgramLiveConnection;
      try {
        conn = connect({
          apiKey: cfg.deepgram.apiKey,
          model: cfg.deepgram.model,
          encoding: 'linear16',
          sampleRate: AUDIO_WIRE_FORMAT.sample_rate_hz,
          channels: AUDIO_WIRE_FORMAT.channels,
          interimResults: true,
          language: 'multi',
        });
      } catch {
        voiceLog('asr_open_failed', { provider: 'deepgram' }, 'error');
        // Failing to open a recognizer must not take the session down — degrade to
        // text-in instead (R16.4).
        return null;
      }
      return new DeepgramAsrStream(conn, callbacks);
    },
  };
}
