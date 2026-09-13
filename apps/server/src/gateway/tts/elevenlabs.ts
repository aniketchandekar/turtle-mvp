import { TTS_PRESET } from '@turtle/shared';
import type { Config } from '../../config.js';
import type { TtsCallbacks, TtsProvider, TtsStream } from '../index.js';

/**
 * Streaming TTS integration — ElevenLabs (Task 10).
 *
 * Turns the orchestrator's `say` text into spoken PCM over a single ElevenLabs
 * stream-input WebSocket, using the frozen Turtle preset (Flash v2.5, pcm_16000,
 * fixed voice, `stability 0.5 / similarity_boost 0.8 / use_speaker_boost false /
 * speed 1.0`, `chunk_length_schedule [120,160,250,290]`).
 *
 *   - Each turn's `say` is split into sentences and streamed sentence-by-sentence.
 *   - `flush:true` rides the FINAL sentence of the turn so buffered text is spoken
 *     promptly at the turn boundary.
 *   - An explicit `{"text":""}` follows the flushed final sentence. ElevenLabs uses
 *     it to emit the terminal `isFinal` frame and close that turn's socket.
 *
 * Static strings (AI disclosure, greeting, crisis lines, recap) are pre-rendered
 * through the HTTP streaming endpoint (`renderStatic`) for sub-100ms availability;
 * those are fixed phrases that never change, so we don't pay WS synthesis latency.
 *
 * When the ElevenLabs key is absent, or opening/streaming errors, the provider
 * degrades to TEXT-ONLY (R4.5/R16.4): `open()` returns null so the session delivers
 * the `say` text via the turn contract with no audio. The app boots with zero keys.
 *
 * As with ASR, the network/SDK is reached only through injectable factories
 * (`connect` / `httpRender`). That keeps this module free of any real socket or
 * fetch, so the unit tests drive the entire surface with fakes and zero network.
 */

/** Events we consume from a live ElevenLabs stream-input connection. */
export const ELEVENLABS_EVENTS = {
  open: 'open',
  close: 'close',
  error: 'error',
  /** A server frame carrying base64 `audio` (and possibly `isFinal`). */
  message: 'message',
} as const;

/**
 * The minimal slice of an ElevenLabs stream-input WebSocket this provider depends
 * on. The real `ws` client is structurally compatible; keeping our own shape means
 * the provider (and its tests) never import `ws` or hit the network directly.
 */
export interface ElevenLabsConnection {
  on(event: string, listener: (payload?: unknown) => void): void;
  /** Send a JSON control/text frame to the synthesizer. */
  send(json: string): void;
  /** Close the socket (session teardown). */
  close(): void;
}

/** Options passed to the connection factory; mirrors the stream-input URL params. */
export interface ElevenLabsConnectOptions {
  apiKey: string;
  voiceId: string;
  modelId: string;
  /** e.g. pcm_16000 / pcm_24000 — from the frozen preset / config. */
  outputFormat: string;
}

/** Factory that opens a live ElevenLabs stream-input connection. Injectable for tests. */
export type ElevenLabsConnectFactory = (opts: ElevenLabsConnectOptions) => ElevenLabsConnection;

/** Options for a one-shot HTTP streaming render of a static string. */
export interface ElevenLabsHttpRenderOptions extends ElevenLabsConnectOptions {
  text: string;
}

/**
 * Factory that renders a static string via the ElevenLabs HTTP streaming endpoint,
 * invoking `onChunk` for each PCM chunk. Resolves when the full clip has streamed.
 * Injectable for tests.
 */
export type ElevenLabsHttpRenderFactory = (
  opts: ElevenLabsHttpRenderOptions,
  onChunk: (chunk: Buffer) => void,
) => Promise<void>;

/** The single-space keepalive frame. NEVER send `""` — that closes the socket. */
export const KEEPALIVE_FRAME = { text: ' ' } as const;

/**
 * Build the ElevenLabs "Initialize Connection" frame with the frozen Turtle preset.
 * Voice settings and the chunk schedule live in shared `TTS_PRESET`; the api key is
 * injected here and never leaves the gateway (R16 privacy posture).
 *
 * Note: `optimize_streaming_latency` is deprecated and intentionally NOT sent.
 */
export function buildInitFrame(cfg: Config, apiKey: string): Record<string, unknown> {
  return {
    // The first frame primes the connection with a single space (no generation yet).
    text: ' ',
    voice_settings: cfg.elevenlabs.voiceSettings,
    generation_config: {
      chunk_length_schedule: [...cfg.elevenlabs.chunkLengthSchedule],
    },
    xi_api_key: apiKey,
  };
}

/**
 * Split a turn's `say` into sentences for sentence-by-sentence streaming. Keeps the
 * terminal punctuation with each sentence and preserves the text otherwise. Falls
 * back to the whole (trimmed) string as a single sentence when there is no
 * sentence-ending punctuation.
 */
export function splitSentences(say: string): string[] {
  const text = say.trim();
  if (text.length === 0) return [];
  // Break at a sentence boundary: a single `.` or a run of `!`/`?` (optionally with
  // closing quotes/brackets) followed by whitespace. A run of 2+ dots is an ellipsis,
  // NOT a boundary, so "Well... I think so." stays a single spoken sentence.
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;

    // Consume the full run of terminal punctuation.
    let end = i;
    while (end + 1 < text.length && '.!?'.includes(text[end + 1]!)) end++;
    const run = text.slice(i, end + 1);
    const isEllipsis = run.length >= 2 && /^\.+$/.test(run);

    // Skip any trailing closing quotes/brackets so they stay with the sentence.
    let after = end + 1;
    while (after < text.length && `"')]`.includes(text[after]!)) after++;

    const atBoundary = !isEllipsis && (after >= text.length || /\s/.test(text[after]!));
    if (atBoundary) {
      const sentence = text.slice(start, after).trim();
      if (sentence.length > 0) sentences.push(sentence);
      start = after;
    }
    i = end; // resume past the punctuation run
  }
  const tail = text.slice(start).trim();
  if (tail.length > 0) sentences.push(tail);
  return sentences.length > 0 ? sentences : [text];
}

/** Read the base64 `audio` field out of a server frame, if present and non-empty. */
function audioFromFrame(payload: unknown): Buffer | null {
  if (!payload || typeof payload !== 'object') return null;
  const audio = (payload as { audio?: unknown }).audio;
  if (typeof audio !== 'string' || audio.length === 0) return null;
  try {
    return Buffer.from(audio, 'base64');
  } catch {
    return null;
  }
}

/**
 * A single per-session ElevenLabs synthesizer. `say` text pushed in flows to
 * ElevenLabs sentence-by-sentence (flush on the final sentence); PCM audio flows
 * back out through the channel callbacks. A fresh stream is opened for each turn.
 */
class ElevenLabsTtsStream implements TtsStream {
  private closed = false;
  private ready = false;
  /** JSON frames queued before the socket signalled `open`, flushed once ready. */
  private pending: string[] = [];
  /** True while a turn's sentences are streaming; drives keepalive-between-turns. */
  private speaking = false;

  constructor(
    private readonly conn: ElevenLabsConnection,
    private readonly cfg: Config,
    private readonly apiKey: string,
    private readonly callbacks: TtsCallbacks,
  ) {
    // Prime the connection with the frozen preset before any text.
    this.enqueue(buildInitFrame(this.cfg, this.apiKey));

    this.conn.on(ELEVENLABS_EVENTS.open, () => {
      this.ready = true;
      const queued = this.pending;
      this.pending = [];
      for (const frame of queued) this.safeSend(frame);
    });
    this.conn.on(ELEVENLABS_EVENTS.message, (payload) => this.onMessage(payload));
    this.conn.on(ELEVENLABS_EVENTS.error, () => this.close());
    this.conn.on(ELEVENLABS_EVENTS.close, () => this.close());
  }

  speak(say: string): void {
    if (this.closed) return;
    const sentences = splitSentences(say);
    if (sentences.length === 0) {
      this.callbacks.onTurnDone();
      return;
    }
    this.speaking = true;
    // Stream each sentence; the FINAL sentence carries flush:true so buffered text
    // is generated promptly at the turn boundary.
    sentences.forEach((sentence, i) => {
      const isFinal = i === sentences.length - 1;
      const frame: Record<string, unknown> = { text: ensureTrailingSpace(sentence) };
      if (isFinal) frame.flush = true;
      this.enqueue(frame);
    });
    // `flush` starts generation but does not end it. Without this EOS frame,
    // ElevenLabs returns audio but never its terminal `isFinal` message.
    this.enqueue({ text: '' });
  }

  /**
   * Barge-in: abandon the active generation. The next turn opens a fresh stream.
   */
  flush(): void {
    if (this.closed) return;
    this.close();
  }

  close(): void {
    if (this.closed) return;
    const wasSpeaking = this.speaking;
    this.closed = true;
    this.speaking = false;
    this.pending = [];
    try {
      this.conn.close();
    } catch {
      /* ignore teardown errors */
    }
    // If the transport failed before ElevenLabs could send `isFinal`, let the
    // gateway finish this turn as text instead of remaining in SPEAKING forever.
    if (wasSpeaking) this.callbacks.onTurnDone();
  }

  private onMessage(payload: unknown): void {
    if (this.closed) return;
    const audio = audioFromFrame(payload);
    if (audio && audio.length > 0) {
      this.callbacks.onAudioChunk(audio);
    }
    // ElevenLabs marks the end of a generation with isFinal:true. That completes the
    // current turn's audio; hand control back so the session can settle state.
    const isFinal = (payload as { isFinal?: unknown } | undefined)?.isFinal === true;
    if (isFinal && this.speaking) {
      this.speaking = false;
      this.callbacks.onTurnDone();
    }
  }

  private enqueue(frame: Record<string, unknown> | typeof KEEPALIVE_FRAME): void {
    const json = JSON.stringify(frame);
    if (!this.ready) {
      this.pending.push(json);
      return;
    }
    this.safeSend(json);
  }

  private safeSend(json: string): void {
    try {
      this.conn.send(json);
    } catch {
      // A send failure means the synthesizer is gone; degrade to text-only by
      // closing so the session stops forwarding (never fabricate audio).
      this.close();
    }
  }
}

/** Ensure a streamed text fragment ends with a space so words don't run together. */
function ensureTrailingSpace(text: string): string {
  return text.endsWith(' ') ? text : `${text} `;
}

/**
 * Build a TTS provider backed by ElevenLabs. `live` reflects config capability
 * (an ElevenLabs key AND a voice id are present); when not live, `open()` returns
 * null and the session runs text-only.
 *
 * @param cfg        - loaded config (reads `elevenlabs.*`).
 * @param connect    - factory that opens a live stream-input connection (tests inject a fake).
 * @param httpRender - factory that renders static strings over HTTP streaming (tests inject a fake).
 */
export function createElevenLabsTtsProvider(
  cfg: Config,
  connect: ElevenLabsConnectFactory,
  httpRender: ElevenLabsHttpRenderFactory,
): TtsProvider & {
  /** Pre-render a static string (AI disclosure, greeting, crisis, recap) via HTTP streaming. */
  renderStatic(text: string, onChunk: (chunk: Buffer) => void): Promise<void>;
} {
  const apiKey = cfg.elevenlabs.apiKey;
  const voiceId = cfg.elevenlabs.voiceId;
  // Live requires both a key and a fixed voice id (the voice is chosen once for MVP).
  const live = cfg.capabilities.tts.live && Boolean(apiKey) && Boolean(voiceId);

  return {
    live,
    open(callbacks: TtsCallbacks): TtsStream | null {
      if (!live || !apiKey || !voiceId) return null;
      let conn: ElevenLabsConnection;
      try {
        conn = connect({
          apiKey,
          voiceId,
          modelId: cfg.elevenlabs.modelId,
          outputFormat: cfg.elevenlabs.outputFormat,
        });
      } catch {
        // Failing to open a synthesizer must not take the session down — degrade to
        // text-only instead (R4.5/R16.4).
        return null;
      }
      return new ElevenLabsTtsStream(conn, cfg, apiKey, callbacks);
    },

    async renderStatic(text: string, onChunk: (chunk: Buffer) => void): Promise<void> {
      // Static strings are pre-rendered through HTTP streaming for sub-100ms
      // availability. When TTS is degraded this is a no-op (text-only).
      if (!live || !apiKey || !voiceId) return;
      const say = text.trim();
      if (say.length === 0) return;
      try {
        await httpRender(
          { apiKey, voiceId, modelId: cfg.elevenlabs.modelId, outputFormat: cfg.elevenlabs.outputFormat, text: say },
          onChunk,
        );
      } catch {
        // Pre-render failure degrades to text-only for that phrase; never crash.
      }
    },
  };
}
