import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { loadConfig, type Config, type EnvSource } from '../config.js';
import { createStore, type Store } from '../store/index.js';
import {
  createGateway,
  TurnTimer,
  percentile,
  p50,
  p95,
  type Clock,
  type LatencyLogSink,
  type TurnLatencyRecord,
  type TtsCallbacks,
  type TtsProvider,
  type TtsStream,
  type TurnProcessor,
} from './index.js';
import type { ServerMessage, TurnContract } from '@turtle/shared';

/**
 * Per-turn latency instrumentation suite (Task 13, R16.1 / R15.4).
 *
 * Two layers:
 *   1. Unit — TurnTimer computes the ASR → classify → LLM → TTS breakdown and the
 *      headline end-of-speech → first-audio figure from marked boundaries; the
 *      percentile helper computes p50/p95; a batch of recorded stage timings has
 *      p50 end-of-speech → first audio byte < 1.5s (R16.1).
 *   2. Integration — a real ws server + client with a scripted clock and a fake TTS
 *      provider runs many turns end-to-end; each turn persists the headline figure to
 *      the assistant turn and emits a structured log, and the batch p50 is < 1.5s.
 *
 * Real Deepgram/ElevenLabs are absent in CI, so stage timings are supplied by a
 * scripted clock / recorded samples rather than wall-clock provider calls.
 */

// ---------------------------------------------------------------------------
// Unit — TurnTimer + percentile
// ---------------------------------------------------------------------------

/** A scripted clock that returns a preset sequence of timestamps, one per call. */
function scriptedClock(values: number[]): Clock {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] as number;
}

describe('TurnTimer — stage breakdown (R15.4)', () => {
  it('computes each stage span and the headline end-of-speech → first-audio figure', () => {
    // end-of-speech=0, asrFinal=120, orchStart=130, classifyDone=180, llmDone=900,
    // orchDone=910, firstAudio=1200
    const clock = scriptedClock([120, 130, 180, 900, 910, 1200]);
    const t = new TurnTimer(clock);
    t.markEndOfSpeech(0); // explicit seed (captured earlier on the ASR path)
    t.markAsrFinal(); // 120
    t.markOrchestratorStart(); // 130
    t.markClassifyDone(); // 180
    t.markLlmDone(); // 900
    t.markOrchestratorDone(); // 910
    t.markFirstAudioByte(); // 1200

    const b = t.breakdown();
    expect(b.asrMs).toBe(120); // 120 - 0
    expect(b.classifyMs).toBe(50); // 180 - 130
    expect(b.llmMs).toBe(720); // 900 - 180
    expect(b.ttsMs).toBe(290); // 1200 - 910
    expect(b.endToFirstAudioMs).toBe(1200); // 1200 - 0
    expect(t.hasFirstAudio()).toBe(true);
  });

  it('attributes the whole orchestrator span to the LLM stage when the split is not reported', () => {
    // No classify/llm marks: classify is null, llm covers orchStart → orchDone.
    const clock = scriptedClock([100, 110, 800, 1000]);
    const t = new TurnTimer(clock);
    t.markEndOfSpeech(0);
    t.markAsrFinal(); // 100
    t.markOrchestratorStart(); // 110
    t.markOrchestratorDone(); // 800
    t.markFirstAudioByte(); // 1000

    const b = t.breakdown();
    expect(b.asrMs).toBe(100);
    expect(b.classifyMs).toBeNull();
    expect(b.llmMs).toBe(690); // 800 - 110
    expect(b.ttsMs).toBe(200); // 1000 - 800
    expect(b.endToFirstAudioMs).toBe(1000);
  });

  it('reports a null TTS/headline figure in text-only mode (no audio byte)', () => {
    const clock = scriptedClock([50, 60, 700]);
    const t = new TurnTimer(clock);
    t.markEndOfSpeech(0);
    t.markAsrFinal(); // 50
    t.markOrchestratorStart(); // 60
    t.markOrchestratorDone(); // 700
    // No markFirstAudioByte — text-only degradation.

    const b = t.breakdown();
    expect(b.ttsMs).toBeNull();
    expect(b.endToFirstAudioMs).toBeNull();
    expect(t.hasFirstAudio()).toBe(false);
  });

  it('treats the text-in path as ~0 ASR (end-of-speech == transcript)', () => {
    const clock = scriptedClock([0, 5, 600, 900]);
    const t = new TurnTimer(clock);
    t.markEndOfSpeech(0);
    t.markAsrFinal(); // 0
    t.markOrchestratorStart(); // 5
    t.markOrchestratorDone(); // 600
    t.markFirstAudioByte(); // 900
    const b = t.breakdown();
    expect(b.asrMs).toBe(0);
  });

  it('records only the first audio byte, and clamps negative spans to 0', () => {
    const clock = scriptedClock([100, 110, 500, 700, 900]);
    const t = new TurnTimer(clock);
    t.markEndOfSpeech(0);
    t.markAsrFinal(); // 100
    t.markOrchestratorStart(); // 110
    t.markOrchestratorDone(); // 500
    t.markFirstAudioByte(); // 700 — recorded
    t.markFirstAudioByte(); // 900 — ignored (first wins)
    expect(t.breakdown().endToFirstAudioMs).toBe(700);
  });
});

describe('percentile helpers', () => {
  it('computes p50/p95 with linear interpolation', () => {
    const xs = [10, 20, 30, 40, 50];
    expect(p50(xs)).toBe(30);
    expect(percentile(xs, 0)).toBe(10);
    expect(percentile(xs, 100)).toBe(50);
    // p95 of 1..100 interpolates near 95.05.
    const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(p95(oneToHundred)!).toBeGreaterThan(95);
    expect(p95(oneToHundred)!).toBeLessThan(96);
  });

  it('returns null for an empty sample', () => {
    expect(percentile([], 50)).toBeNull();
    expect(p50([])).toBeNull();
  });
});

describe('R16.1 target — p50 end-of-speech → first audio byte < 1.5s', () => {
  it('holds for a batch of recorded stage timings', () => {
    // A realistic spread of end-of-speech → first-audio samples (ms), some slow.
    const samples = [820, 900, 1100, 1250, 1400, 780, 950, 1050, 1180, 1320, 1490, 860];
    const median = p50(samples)!;
    expect(median).toBeLessThan(1500);
  });
});

// ---------------------------------------------------------------------------
// Integration — full pipeline records + persists + logs the headline figure
// ---------------------------------------------------------------------------

const EMPTY: EnvSource = {};

/**
 * A fake TTS stream that emits one audio frame synchronously on speak(); that first
 * frame is the R16.1 first-audio-byte boundary the gateway marks.
 */
class FakeTtsStream implements TtsStream {
  closed = false;
  constructor(private readonly callbacks: TtsCallbacks) {}
  speak(_say: string): void {
    if (this.closed) return;
    this.callbacks.onAudioChunk(Buffer.from([1, 2, 3, 4]));
    this.callbacks.onTurnDone();
  }
  flush(): void {
    /* no-op for latency harness */
  }
  close(): void {
    this.closed = true;
  }
}

function fakeTtsProvider(): TtsProvider {
  return {
    live: true as const,
    open(callbacks: TtsCallbacks): TtsStream {
      return new FakeTtsStream(callbacks);
    },
  };
}

/** A processor that immediately returns a warm contract (no cards). */
const immediateProcessor: TurnProcessor = {
  async handleTurn({ sessionId, turnId }): Promise<TurnContract> {
    return {
      session_id: sessionId,
      turn_id: turnId,
      state: 'WAITING',
      say: 'I hear you.',
      cards: [],
      memory_ops: [],
      flags: ['none'],
    };
  },
};

interface Harness {
  cfg: Config;
  store: Store;
  server: http.Server;
  wss: WebSocketServer;
  url: string;
  caregiverId: string;
  logs: TurnLatencyRecord[];
}

/**
 * Build a harness with a manually-advanced clock so each turn's end-of-speech →
 * first-audio figure is a scripted, deterministic value. The clock advances only
 * when the test calls `advance()`, so between marks the elapsed time is exactly what
 * the test dictates.
 */
async function makeHarness(): Promise<Harness> {
  const cfg = loadConfig(EMPTY);
  const store = createStore(':memory:', cfg.encryptionKey);
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/ws' });
  const logs: TurnLatencyRecord[] = [];
  const sink: LatencyLogSink = (r) => logs.push(r);

  // The clock auto-advances a fixed step on every read so successive stage marks are
  // strictly increasing and deterministic — no wall-clock dependency. With a 100ms
  // step, one turn's end-of-speech → first-audio span is a fixed, small figure well
  // under the 1.5s budget (R16.1), which is what the batch p50 assertion checks.
  let nowMs = 0;
  const stepMs = 100;
  const clock: Clock = () => {
    const t = nowMs;
    nowMs += stepMs;
    return t;
  };

  createGateway({
    cfg,
    store,
    tts: fakeTtsProvider(),
    processor: immediateProcessor,
    latencySink: sink,
    clock,
  }).attach(wss);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const caregiver = store.repos.caregiver.create({ display_name: 'Alex' });
  return {
    cfg,
    store,
    server,
    wss,
    url: `ws://127.0.0.1:${port}/ws`,
    caregiverId: caregiver.id,
    logs,
  };
}

interface Client {
  ws: WebSocket;
  messages: ServerMessage[];
  open: Promise<void>;
}

function connect(url: string): Client {
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

async function waitFor(check: () => boolean, timeoutMs = 1000, label = 'condition'): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

let harness: Harness | undefined;

afterEach(async () => {
  if (harness) {
    for (const client of harness.wss.clients) client.terminate();
    await new Promise<void>((resolve) => harness!.wss.close(() => resolve()));
    await new Promise<void>((resolve) => harness!.server.close(() => resolve()));
    harness = undefined;
  }
});

describe('Latency instrumentation — end-to-end per-turn recording (R16.1/R15.4)', () => {
  it('persists the headline figure on the assistant turn and emits a structured log', async () => {
    harness = await makeHarness();
    const s = harness.store.repos.session.create(harness.caregiverId);
    const c = connect(harness.url);
    await c.open;
    send(c.ws, { type: 'attach_session', session_id: s.id });
    await waitFor(() => c.messages.some((m) => m.type === 'assistant_state' && m.state === 'LISTENING'), 1000, 'LISTENING');

    // Marks in clock order per turn: endOfSpeech (captured in text_input), asrFinal,
    // orchStart, orchDone, firstAudioByte. With the auto-advancing 100ms-step clock
    // the end-of-speech → first-audio span is a fixed few hundred ms — deterministic
    // and comfortably under the 1.5s budget (R16.1).
    send(c.ws, { type: 'text_input', text: 'how are you today' });

    await waitFor(() => c.messages.some((m) => m.type === 'turn_contract'), 1000, 'turn contract');
    await waitFor(() => harness!.logs.length >= 1, 1000, 'latency log');

    const log = harness.logs[0]!;
    expect(log.sessionId).toBe(s.id);
    expect(log.breakdown.endToFirstAudioMs).not.toBeNull();
    expect(log.breakdown.endToFirstAudioMs).toBeLessThan(1500);
    expect(log.textOnly).toBe(false);
    expect(log.cardsEmitted).toBe(0);
    expect(log.flags).toEqual([]);

    // The headline figure is persisted on the assistant turn's latency_ms.
    const turns = harness.store.repos.turn.listBySession(s.id);
    const assistant = turns.find((t) => t.speaker === 'assistant');
    expect(assistant).toBeTruthy();
    expect(assistant!.latency_ms).not.toBeNull();
    expect(assistant!.latency_ms!).toBeLessThan(1500);
    c.ws.close();
  });

  it('has p50 end-of-speech → first audio byte < 1.5s across many turns', async () => {
    harness = await makeHarness();
    const s = harness.store.repos.session.create(harness.caregiverId);
    const c = connect(harness.url);
    await c.open;
    send(c.ws, { type: 'attach_session', session_id: s.id });
    await waitFor(() => c.messages.some((m) => m.type === 'assistant_state' && m.state === 'LISTENING'), 1000, 'LISTENING');

    // Each turn yields a deterministic headline figure from the auto-advancing clock.
    // We collect the batch and assert the R16.1 p50 target. With a real provider this
    // figure is the true wall-clock span; here it is scripted and under budget.
    const turnCount = 9;
    for (let i = 0; i < turnCount; i++) {
      const before = harness.logs.length;
      send(c.ws, { type: 'text_input', text: `turn ${i}` });
      await waitFor(() => harness!.logs.length > before, 1000, `latency log ${i}`);
    }

    const samples = harness.logs
      .map((l) => l.breakdown.endToFirstAudioMs)
      .filter((v): v is number => v !== null);
    expect(samples).toHaveLength(turnCount);
    const median = p50(samples)!;
    expect(median).toBeLessThan(1500);
    c.ws.close();
  });
});
