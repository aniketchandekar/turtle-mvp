import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { loadConfig, type Config, type EnvSource } from '../../config.js';
import { createStore, type Store } from '../../store/index.js';
import { createGateway } from '../index.js';
import type { AsrCallbacks, AsrProvider, AsrStream } from '../index.js';
import type { ServerMessage } from '@turtle/shared';
import {
  createDeepgramAsrProvider,
  DEEPGRAM_EVENTS,
  type DeepgramConnectOptions,
  type DeepgramLiveConnection,
} from './deepgram.js';

/**
 * Streaming ASR integration — Deepgram (Task 9).
 *
 * Two layers of coverage, no network calls:
 *   1. Provider unit tests drive a FAKE Deepgram connection to assert audio
 *      forwarding, interim-vs-final emission (R3.3–R3.5), and text-in degradation
 *      when no key is present (R3.6/R16.4).
 *   2. A wire test runs the real SessionChannel with a fake ASR provider to prove
 *      `transcript_interim` (dimmed) and `transcript_final` (committed user turn)
 *      reach the client and drive a full turn.
 */

// ----------------------------------------------------------------------------
// A controllable fake of a Deepgram live connection. Tests emit events and
// inspect sent audio without touching @deepgram/sdk or the network.
// ----------------------------------------------------------------------------
class FakeDeepgramConnection implements DeepgramLiveConnection {
  private listeners = new Map<string, Array<(payload?: unknown) => void>>();
  sent: Buffer[] = [];
  finalizeCount = 0;
  closeCount = 0;

  on(event: string, listener: (payload?: unknown) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }

  send(data: ArrayBufferLike | Uint8Array | Buffer): void {
    this.sent.push(Buffer.from(data as Uint8Array));
  }

  finalize(): void {
    this.finalizeCount += 1;
  }

  requestClose(): void {
    this.closeCount += 1;
  }

  // ---- test drivers ----
  emit(event: string, payload?: unknown): void {
    for (const l of this.listeners.get(event) ?? []) l(payload);
  }

  /** Simulate the socket becoming ready. */
  emitOpen(): void {
    this.emit(DEEPGRAM_EVENTS.open);
  }

  /** Build a Deepgram `Results` payload with a single alternative. */
  emitTranscript(transcript: string, opts: { final: boolean; confidence?: number }): void {
    this.emit(DEEPGRAM_EVENTS.transcript, {
      is_final: opts.final,
      speech_final: opts.final,
      channel: {
        alternatives: [{ transcript, confidence: opts.confidence ?? 0.9 }],
      },
    });
  }
}

/** Collect interim/final callbacks from a provider stream. */
function collectingCallbacks() {
  const interim: string[] = [];
  const finals: Array<{ text: string; confidence: number | null }> = [];
  const callbacks: AsrCallbacks = {
    onInterim: (text) => interim.push(text),
    onFinal: (text, confidence) => finals.push({ text, confidence }),
  };
  return { interim, finals, callbacks };
}

const LIVE_ENV: EnvSource = { DEEPGRAM_API_KEY: 'dg-test-key' };

describe('Deepgram provider — liveness + degradation (R3.6/R16.4)', () => {
  it('is not live and returns null when no Deepgram key is present', () => {
    const cfg = loadConfig({});
    const connect = vi.fn();
    const provider = createDeepgramAsrProvider(cfg, connect);

    expect(provider.live).toBe(false);
    const { callbacks } = collectingCallbacks();
    expect(provider.open(callbacks)).toBeNull();
    // No key → we must never even attempt to open a recognizer.
    expect(connect).not.toHaveBeenCalled();
  });

  it('is live and opens a recognizer when a key is present', () => {
    const cfg = loadConfig(LIVE_ENV);
    const conn = new FakeDeepgramConnection();
    const connect = vi.fn(() => conn);
    const provider = createDeepgramAsrProvider(cfg, connect);

    expect(provider.live).toBe(true);
    const { callbacks } = collectingCallbacks();
    const stream = provider.open(callbacks);
    expect(stream).not.toBeNull();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('configures linear16 / 16kHz / mono nova-3 with interim results', () => {
    const cfg = loadConfig(LIVE_ENV);
    let opts: DeepgramConnectOptions | undefined;
    const connect = vi.fn((o: DeepgramConnectOptions) => {
      opts = o;
      return new FakeDeepgramConnection();
    });
    createDeepgramAsrProvider(cfg, connect).open(collectingCallbacks().callbacks);

    expect(opts).toMatchObject({
      model: 'nova-3',
      encoding: 'linear16',
      sampleRate: 16000,
      channels: 1,
      interimResults: true,
    });
    // The key is passed through to the SDK edge but is the config value, by name.
    expect(opts?.apiKey).toBe('dg-test-key');
  });

  it('degrades to text-in (null) when opening the connection throws', () => {
    const cfg = loadConfig(LIVE_ENV);
    const connect = vi.fn(() => {
      throw new Error('deepgram unreachable');
    });
    const provider = createDeepgramAsrProvider(cfg, connect);

    // Still reports live (key present) but open() must not throw — it degrades.
    expect(provider.live).toBe(true);
    expect(() => provider.open(collectingCallbacks().callbacks)).not.toThrow();
    expect(provider.open(collectingCallbacks().callbacks)).toBeNull();
  });
});

describe('Deepgram provider — audio forwarding', () => {
  let cfg: Config;
  beforeEach(() => {
    cfg = loadConfig(LIVE_ENV);
  });

  it('buffers audio until open, then flushes it to the recognizer in order', () => {
    const conn = new FakeDeepgramConnection();
    const provider = createDeepgramAsrProvider(cfg, () => conn);
    const stream = provider.open(collectingCallbacks().callbacks) as AsrStream;

    // Audio arrives before the socket is ready — it must not be dropped.
    stream.pushAudio(Buffer.from([1, 2]));
    stream.pushAudio(Buffer.from([3, 4]));
    expect(conn.sent).toHaveLength(0);

    conn.emitOpen();
    expect(conn.sent.map((b) => [...b])).toEqual([
      [1, 2],
      [3, 4],
    ]);

    // Subsequent chunks forward straight through.
    stream.pushAudio(Buffer.from([5, 6]));
    expect([...conn.sent[2]!]).toEqual([5, 6]);
  });

  it('finalizes the utterance on endTurn (button release)', () => {
    const conn = new FakeDeepgramConnection();
    const provider = createDeepgramAsrProvider(cfg, () => conn);
    const stream = provider.open(collectingCallbacks().callbacks) as AsrStream;
    conn.emitOpen();

    stream.endTurn();
    expect(conn.finalizeCount).toBe(1);
  });

  it('stops forwarding and closes after the connection errors', () => {
    const conn = new FakeDeepgramConnection();
    const provider = createDeepgramAsrProvider(cfg, () => conn);
    const stream = provider.open(collectingCallbacks().callbacks) as AsrStream;
    conn.emitOpen();

    conn.emit(DEEPGRAM_EVENTS.error, new Error('boom'));
    const before = conn.sent.length;
    stream.pushAudio(Buffer.from([9, 9]));
    expect(conn.sent.length).toBe(before); // no further audio after error
  });
});

describe('Deepgram provider — interim vs final transcripts (R3.3–R3.5)', () => {
  let cfg: Config;
  beforeEach(() => {
    cfg = loadConfig(LIVE_ENV);
  });

  it('emits interim results as dimmed transcripts and finals as commits', () => {
    const conn = new FakeDeepgramConnection();
    const { interim, finals, callbacks } = collectingCallbacks();
    const provider = createDeepgramAsrProvider(cfg, () => conn);
    provider.open(callbacks);
    conn.emitOpen();

    conn.emitTranscript('how are', { final: false });
    conn.emitTranscript('how are you', { final: false });
    conn.emitTranscript('how are you today', { final: true, confidence: 0.97 });

    expect(interim).toEqual(['how are', 'how are you']);
    expect(finals).toEqual([{ text: 'how are you today', confidence: 0.97 }]);
  });

  it('ignores empty/whitespace transcripts (keepalive frames)', () => {
    const conn = new FakeDeepgramConnection();
    const { interim, finals, callbacks } = collectingCallbacks();
    const provider = createDeepgramAsrProvider(cfg, () => conn);
    provider.open(callbacks);
    conn.emitOpen();

    conn.emitTranscript('   ', { final: false });
    conn.emitTranscript('', { final: true });

    expect(interim).toEqual([]);
    expect(finals).toEqual([]);
  });

  it('treats speech_final as the endpoint even when is_final flips earlier', () => {
    const conn = new FakeDeepgramConnection();
    const { interim, finals, callbacks } = collectingCallbacks();
    const provider = createDeepgramAsrProvider(cfg, () => conn);
    provider.open(callbacks);
    conn.emitOpen();

    // Deepgram can send is_final=true mid-utterance (segment final) before the VAD
    // endpoint (speech_final). Only speech_final commits the user turn.
    conn.emit(DEEPGRAM_EVENTS.transcript, {
      is_final: true,
      speech_final: false,
      channel: { alternatives: [{ transcript: 'part one', confidence: 0.8 }] },
    });
    conn.emit(DEEPGRAM_EVENTS.transcript, {
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: 'part one and done', confidence: 0.9 }] },
    });

    expect(interim).toEqual(['part one']);
    expect(finals).toEqual([{ text: 'part one and done', confidence: 0.9 }]);
  });
});

// ----------------------------------------------------------------------------
// Wire test: the real SessionChannel with a fake ASR provider. Proves interim
// and final transcripts reach the client and a final drives a full turn.
// ----------------------------------------------------------------------------

/** A fake ASR provider that hands the test direct control of the callbacks. */
function fakeAsrProvider(): { provider: AsrProvider; fire: () => AsrCallbacks | null } {
  let captured: AsrCallbacks | null = null;
  const provider: AsrProvider = {
    live: true,
    open(callbacks) {
      captured = callbacks;
      return {
        pushAudio() {
          /* no-op for the wire test */
        },
        endTurn() {
          /* endpointing is simulated by the test firing onFinal */
        },
        close() {
          captured = null;
        },
      };
    },
  };
  return { provider, fire: () => captured };
}

interface WireHarness {
  store: Store;
  server: http.Server;
  wss: WebSocketServer;
  url: string;
  caregiverId: string;
  asrCallbacks: () => AsrCallbacks | null;
}

async function makeWireHarness(): Promise<WireHarness> {
  const cfg = loadConfig(LIVE_ENV);
  const store = createStore(':memory:', cfg.encryptionKey);
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/ws' });
  const { provider, fire } = fakeAsrProvider();
  createGateway({ cfg, store, asr: provider }).attach(wss);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const caregiver = store.repos.caregiver.create({ display_name: 'Alex' });
  return {
    store,
    server,
    wss,
    url: `ws://127.0.0.1:${port}/ws`,
    caregiverId: caregiver.id,
    asrCallbacks: fire,
  };
}

function connect(url: string): { ws: WebSocket; messages: ServerMessage[]; open: Promise<void> } {
  const ws = new WebSocket(url);
  const messages: ServerMessage[] = [];
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) return;
    messages.push(JSON.parse(data.toString('utf8')) as ServerMessage);
  });
  const open = new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  return { ws, messages, open };
}

function send(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

async function waitFor(
  messages: ServerMessage[],
  predicate: (msgs: ServerMessage[]) => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (!predicate(messages)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting. Got: ${JSON.stringify(messages)}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

let wire: WireHarness | undefined;

afterEach(async () => {
  if (wire) {
    for (const client of wire.wss.clients) client.terminate();
    await new Promise<void>((resolve) => wire!.wss.close(() => resolve()));
    await new Promise<void>((resolve) => wire!.server.close(() => resolve()));
    wire = undefined;
  }
});

describe('SessionChannel + Deepgram ASR — transcripts on the wire (R3.3–R3.5)', () => {
  it('does NOT announce asr_degraded when the ASR provider is live', async () => {
    wire = await makeWireHarness();
    const c = connect(wire.url);
    await c.open;
    await waitFor(c.messages, (m) => m.some((x) => x.type === 'assistant_state' && x.state === 'IDLE'));
    // Give any degradation notices a moment; a live ASR must not emit one.
    await new Promise((r) => setTimeout(r, 50));
    const codes = c.messages.filter((x) => x.type === 'error').map((x) => (x as { code: string }).code);
    expect(codes).not.toContain('asr_degraded');
    c.ws.close();
  });

  it('streams interim transcripts (dimmed) and commits a final as a user turn', async () => {
    wire = await makeWireHarness();
    const s = wire.store.repos.session.create(wire.caregiverId);
    const c = connect(wire.url);
    await c.open;
    send(c.ws, { type: 'attach_session', session_id: s.id });
    await waitFor(c.messages, (m) => m.some((x) => x.type === 'assistant_state' && x.state === 'LISTENING'));

    // The channel opened the recognizer on attach; grab its callbacks.
    const cb = wire.asrCallbacks();
    expect(cb).not.toBeNull();

    // Interim results surface as dimmed transcripts (client renders them faded).
    cb!.onInterim('I wanted to');
    cb!.onInterim('I wanted to talk about mom');
    await waitFor(c.messages, (m) => m.filter((x) => x.type === 'transcript_interim').length >= 2);

    // The endpointed final commits the user turn and drives a full turn.
    cb!.onFinal('I wanted to talk about mom', 0.95);
    await waitFor(c.messages, (m) => m.some((x) => x.type === 'turn_contract'));

    // transcript_final carries the committed text.
    expect(c.messages.some((x) => x.type === 'transcript_final' && x.text === 'I wanted to talk about mom')).toBe(true);

    // The committed transcript is persisted as the user turn (with confidence).
    const turns = wire.store.repos.turn.listBySession(s.id);
    const userTurn = turns.find((t) => t.speaker === 'user');
    expect(userTurn?.text).toBe('I wanted to talk about mom');
    expect(userTurn?.asr_conf).toBeCloseTo(0.95);
    c.ws.close();
  });
});
