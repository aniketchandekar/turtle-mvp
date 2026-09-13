import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TTS_PRESET } from '@turtle/shared';
import { loadConfig, type Config, type EnvSource } from '../../config.js';
import type { TtsCallbacks, TtsStream } from '../index.js';
import {
  buildInitFrame,
  createElevenLabsTtsProvider,
  ELEVENLABS_EVENTS,
  splitSentences,
  type ElevenLabsConnectOptions,
  type ElevenLabsConnection,
  type ElevenLabsHttpRenderOptions,
} from './elevenlabs.js';

/**
 * Streaming TTS integration — ElevenLabs (Task 10).
 *
 * All coverage runs against FAKE connection + HTTP factories — no network calls:
 *   - Preset/message construction: frozen model/output/voice-settings/chunk schedule,
 *     flush on the FINAL sentence, and the `{"text":" "}` keepalive (never `""`).
 *   - Sentence splitting for sentence-by-sentence streaming.
 *   - Static pre-render over HTTP streaming.
 *   - Text-only degradation when no key (or no fixed voice id) is present (R4.5/R16.4).
 */

// A live TTS config needs BOTH a key and a fixed voice id (voice chosen once for MVP).
const LIVE_ENV: EnvSource = { ELEVENLABS_API_KEY: 'el-test-key', ELEVENLABS_VOICE_ID: 'voice-123' };

// ----------------------------------------------------------------------------
// Controllable fake of an ElevenLabs stream-input connection. Tests emit events
// and inspect the JSON frames sent without touching `ws` or the network.
// ----------------------------------------------------------------------------
class FakeElevenLabsConnection implements ElevenLabsConnection {
  private listeners = new Map<string, Array<(payload?: unknown) => void>>();
  sent: Array<Record<string, unknown>> = [];
  closeCount = 0;

  on(event: string, listener: (payload?: unknown) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }

  send(json: string): void {
    this.sent.push(JSON.parse(json) as Record<string, unknown>);
  }

  close(): void {
    this.closeCount += 1;
  }

  // ---- test drivers ----
  emit(event: string, payload?: unknown): void {
    for (const l of this.listeners.get(event) ?? []) l(payload);
  }

  emitOpen(): void {
    this.emit(ELEVENLABS_EVENTS.open);
  }

  /** Build a server frame carrying base64-encoded PCM `audio`. */
  emitAudio(bytes: number[], opts: { final?: boolean } = {}): void {
    this.emit(ELEVENLABS_EVENTS.message, {
      audio: Buffer.from(bytes).toString('base64'),
      isFinal: opts.final ?? false,
    });
  }
}

function collectingCallbacks() {
  const audio: Buffer[] = [];
  let turnDone = 0;
  const callbacks: TtsCallbacks = {
    onAudioChunk: (chunk) => audio.push(chunk),
    onTurnDone: () => {
      turnDone += 1;
    },
  };
  return { audio, turnDone: () => turnDone, callbacks };
}

/** Only the text/control frames (everything after the init frame). */
function textFrames(conn: FakeElevenLabsConnection): Array<Record<string, unknown>> {
  return conn.sent.slice(1);
}

describe('splitSentences — sentence-by-sentence streaming', () => {
  it('splits on sentence-ending punctuation and keeps the punctuation', () => {
    expect(splitSentences('Hello there. How are you? I am glad!')).toEqual([
      'Hello there.',
      'How are you?',
      'I am glad!',
    ]);
  });

  it('returns a single sentence when there is no terminal punctuation', () => {
    expect(splitSentences('just one line')).toEqual(['just one line']);
  });

  it('trims and ignores empty input', () => {
    expect(splitSentences('   ')).toEqual([]);
    expect(splitSentences('')).toEqual([]);
  });

  it('keeps ellipses attached to their sentence', () => {
    expect(splitSentences('Well... I think so.')).toEqual(['Well... I think so.']);
  });
});

describe('buildInitFrame — frozen Turtle preset', () => {
  it('sends the frozen voice settings and chunk schedule, primes with a space, no optimize_streaming_latency', () => {
    const cfg = loadConfig(LIVE_ENV);
    const frame = buildInitFrame(cfg, 'el-test-key');

    // Primes the connection with a single space (no generation yet), never "".
    expect(frame.text).toBe(' ');
    expect(frame.voice_settings).toEqual(TTS_PRESET.voice_settings);
    expect(frame.voice_settings).toMatchObject({
      stability: 0.5,
      similarity_boost: 0.8,
      use_speaker_boost: false,
      speed: 1.0,
    });
    expect((frame.generation_config as { chunk_length_schedule: number[] }).chunk_length_schedule).toEqual([
      120, 160, 250, 290,
    ]);
    // The deprecated latency knob must never be sent.
    expect(frame).not.toHaveProperty('optimize_streaming_latency');
    // The key travels with the init frame at the edge, but is the config value.
    expect(frame.xi_api_key).toBe('el-test-key');
  });
});

describe('ElevenLabs provider — liveness + degradation (R4.5/R16.4)', () => {
  it('is not live and returns null when no ElevenLabs key is present', () => {
    const cfg = loadConfig({});
    const connect = vi.fn();
    const httpRender = vi.fn(async () => {});
    const provider = createElevenLabsTtsProvider(cfg, connect, httpRender);

    expect(provider.live).toBe(false);
    expect(provider.open(collectingCallbacks().callbacks)).toBeNull();
    // No key → never even attempt to open a synthesizer.
    expect(connect).not.toHaveBeenCalled();
  });

  it('is not live when a key is present but no fixed voice id is configured', () => {
    const cfg = loadConfig({ ELEVENLABS_API_KEY: 'el-test-key' });
    const connect = vi.fn();
    const provider = createElevenLabsTtsProvider(cfg, connect, vi.fn(async () => {}));

    expect(provider.live).toBe(false);
    expect(provider.open(collectingCallbacks().callbacks)).toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });

  it('is live and opens a synthesizer when key + voice id are present', () => {
    const cfg = loadConfig(LIVE_ENV);
    const conn = new FakeElevenLabsConnection();
    const connect = vi.fn(() => conn);
    const provider = createElevenLabsTtsProvider(cfg, connect, vi.fn(async () => {}));

    expect(provider.live).toBe(true);
    const stream = provider.open(collectingCallbacks().callbacks);
    expect(stream).not.toBeNull();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('opens with the frozen model + output format + fixed voice', () => {
    const cfg = loadConfig(LIVE_ENV);
    let opts: ElevenLabsConnectOptions | undefined;
    const connect = vi.fn((o: ElevenLabsConnectOptions) => {
      opts = o;
      return new FakeElevenLabsConnection();
    });
    createElevenLabsTtsProvider(cfg, connect, vi.fn(async () => {})).open(collectingCallbacks().callbacks);

    expect(opts).toMatchObject({
      voiceId: 'voice-123',
      modelId: 'eleven_flash_v2_5',
      outputFormat: 'pcm_16000',
    });
    expect(opts?.apiKey).toBe('el-test-key');
  });

  it('degrades to text-only (null) when opening the connection throws', () => {
    const cfg = loadConfig(LIVE_ENV);
    const connect = vi.fn(() => {
      throw new Error('elevenlabs unreachable');
    });
    const provider = createElevenLabsTtsProvider(cfg, connect, vi.fn(async () => {}));

    expect(provider.live).toBe(true);
    expect(() => provider.open(collectingCallbacks().callbacks)).not.toThrow();
    expect(provider.open(collectingCallbacks().callbacks)).toBeNull();
  });
});

describe('ElevenLabs provider — streaming a turn (preset + flush + keepalive)', () => {
  let cfg: Config;
  beforeEach(() => {
    cfg = loadConfig(LIVE_ENV);
  });

  it('sends the frozen init frame first, before any text', () => {
    const conn = new FakeElevenLabsConnection();
    const provider = createElevenLabsTtsProvider(cfg, () => conn, vi.fn(async () => {}));
    provider.open(collectingCallbacks().callbacks);
    conn.emitOpen();

    expect(conn.sent[0]).toMatchObject({
      text: ' ',
      voice_settings: TTS_PRESET.voice_settings,
    });
  });

  it('streams sentence-by-sentence with flush:true ONLY on the final sentence', () => {
    const conn = new FakeElevenLabsConnection();
    const provider = createElevenLabsTtsProvider(cfg, () => conn, vi.fn(async () => {}));
    const stream = provider.open(collectingCallbacks().callbacks) as TtsStream;
    conn.emitOpen();

    stream.speak('First sentence. Second sentence. Third and last.');

    const frames = textFrames(conn);
    expect(frames).toHaveLength(4);
    expect((frames[0]!.text as string).trim()).toBe('First sentence.');
    expect((frames[1]!.text as string).trim()).toBe('Second sentence.');
    expect((frames[2]!.text as string).trim()).toBe('Third and last.');
    // Only the final sentence carries flush:true.
    expect(frames[0]!.flush).toBeUndefined();
    expect(frames[1]!.flush).toBeUndefined();
    expect(frames[2]!.flush).toBe(true);
    expect(frames[3]).toEqual({ text: '' });
  });

  it('buffers frames until the socket opens, then flushes them in order (init first)', () => {
    const conn = new FakeElevenLabsConnection();
    const provider = createElevenLabsTtsProvider(cfg, () => conn, vi.fn(async () => {}));
    const stream = provider.open(collectingCallbacks().callbacks) as TtsStream;

    // speak() before open — nothing sent yet.
    stream.speak('Only one.');
    expect(conn.sent).toHaveLength(0);

    conn.emitOpen();
    // Init frame first, then the single (final) sentence with flush and EOS.
    expect(conn.sent[0]!.text).toBe(' ');
    expect(conn.sent[1]).toMatchObject({ flush: true });
    expect((conn.sent[1]!.text as string).trim()).toBe('Only one.');
    expect(conn.sent[2]).toEqual({ text: '' });
  });

  it('ends the sequence after a flushed turn so ElevenLabs emits the final frame', () => {
    const conn = new FakeElevenLabsConnection();
    const { callbacks } = collectingCallbacks();
    const provider = createElevenLabsTtsProvider(cfg, () => conn, vi.fn(async () => {}));
    const stream = provider.open(callbacks) as TtsStream;
    conn.emitOpen();

    stream.speak('A turn.');
    // The explicit EOS frame follows the final flushed sentence.
    expect(conn.sent).toContainEqual({ text: '' });
    // ElevenLabs signals end of generation with isFinal.
    conn.emitAudio([1, 2, 3], { final: true });

    expect(conn.sent.filter((f) => f.text === '')).toHaveLength(1);
    expect(conn.closeCount).toBe(0);
  });

  it('flush() (barge-in) closes the active stream immediately', () => {
    const conn = new FakeElevenLabsConnection();
    const provider = createElevenLabsTtsProvider(cfg, () => conn, vi.fn(async () => {}));
    const stream = provider.open(collectingCallbacks().callbacks) as TtsStream;
    conn.emitOpen();

    stream.speak('Interrupt me.');
    stream.flush();

    expect(conn.closeCount).toBe(1);
  });

  it('forwards received PCM audio chunks and signals turn done on isFinal', () => {
    const conn = new FakeElevenLabsConnection();
    const { audio, turnDone, callbacks } = collectingCallbacks();
    const provider = createElevenLabsTtsProvider(cfg, () => conn, vi.fn(async () => {}));
    const stream = provider.open(callbacks) as TtsStream;
    conn.emitOpen();

    stream.speak('Say this.');
    conn.emitAudio([10, 20]);
    conn.emitAudio([30, 40], { final: true });

    expect(audio.map((b) => [...b])).toEqual([
      [10, 20],
      [30, 40],
    ]);
    expect(turnDone()).toBe(1);
  });

  it('close() tears down the socket', () => {
    const conn = new FakeElevenLabsConnection();
    const provider = createElevenLabsTtsProvider(cfg, () => conn, vi.fn(async () => {}));
    const stream = provider.open(collectingCallbacks().callbacks) as TtsStream;
    conn.emitOpen();

    stream.close();
    expect(conn.closeCount).toBe(1);
  });

  it('stops forwarding audio after the connection errors', () => {
    const conn = new FakeElevenLabsConnection();
    const { audio, callbacks } = collectingCallbacks();
    const provider = createElevenLabsTtsProvider(cfg, () => conn, vi.fn(async () => {}));
    const stream = provider.open(callbacks) as TtsStream;
    conn.emitOpen();

    conn.emit(ELEVENLABS_EVENTS.error, new Error('boom'));
    conn.emitAudio([9, 9]);
    expect(audio).toHaveLength(0);
  });
});

describe('ElevenLabs provider — static pre-render over HTTP streaming', () => {
  it('renders a static string through the HTTP factory with the frozen voice/model/format', async () => {
    const cfg = loadConfig(LIVE_ENV);
    let opts: ElevenLabsHttpRenderOptions | undefined;
    const httpRender = vi.fn(async (o: ElevenLabsHttpRenderOptions, onChunk: (c: Buffer) => void) => {
      opts = o;
      onChunk(Buffer.from([1, 2]));
      onChunk(Buffer.from([3, 4]));
    });
    const provider = createElevenLabsTtsProvider(cfg, () => new FakeElevenLabsConnection(), httpRender);

    const chunks: Buffer[] = [];
    await provider.renderStatic('Turtle is an AI. It never gives medical advice.', (c) => chunks.push(c));

    expect(httpRender).toHaveBeenCalledTimes(1);
    expect(opts).toMatchObject({
      voiceId: 'voice-123',
      modelId: 'eleven_flash_v2_5',
      outputFormat: 'pcm_16000',
      text: 'Turtle is an AI. It never gives medical advice.',
    });
    expect(chunks.map((b) => [...b])).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('is a no-op (no HTTP call) when TTS is degraded', async () => {
    const cfg = loadConfig({});
    const httpRender = vi.fn(async () => {});
    const provider = createElevenLabsTtsProvider(cfg, vi.fn(), httpRender);

    await provider.renderStatic('AI disclosure', () => {});
    expect(httpRender).not.toHaveBeenCalled();
  });

  it('degrades gracefully when the HTTP render throws (never crashes)', async () => {
    const cfg = loadConfig(LIVE_ENV);
    const httpRender = vi.fn(async () => {
      throw new Error('http down');
    });
    const provider = createElevenLabsTtsProvider(cfg, () => new FakeElevenLabsConnection(), httpRender);

    await expect(provider.renderStatic('greeting', () => {})).resolves.toBeUndefined();
  });
});
