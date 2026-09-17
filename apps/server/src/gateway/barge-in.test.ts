import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { loadConfig, type Config, type EnvSource } from '../config.js';
import { createStore, type Store } from '../store/index.js';
import {
  createGateway,
  type TtsCallbacks,
  type TtsProvider,
  type TtsStream,
  type TurnProcessor,
} from './index.js';
import type { ServerMessage, TurnContract } from '@turtle/shared';
import { seedCompletedOnboarding } from './test-onboarding.js';

/**
 * Barge-in — scripted interruption suite (Task 12, R4.3/R4.4/R16.3).
 *
 * Drives a real ws server + client through a full turn into SPEAKING, then sends
 * `interrupt` mid-playback and asserts the frozen barge-in contract:
 *   - the TTS buffer is FLUSHED and audio stops forwarding within 300ms (R4.3/R16.3);
 *   - the assistant transitions SPEAKING → LISTENING (R4.3);
 *   - a partial in-flight response is DISCARDED — no stale contract lands (R4.3);
 *   - the interruption is NEVER penalized: no flag is recorded, and the next turn is
 *     accepted normally (R4.4).
 *
 * A controllable fake TTS provider keeps the turn "speaking" (it emits audio but does
 * not auto-complete) so the interrupt lands squarely during playback. It records the
 * timestamp of `flush()` so the halt latency can be measured against the 300ms budget.
 */

const EMPTY: EnvSource = {};

/** A fake TTS stream we can drive by hand and inspect (flush timing, forwarded audio). */
class FakeTtsStream implements TtsStream {
  flushedAt: number | null = null;
  flushCount = 0;
  speakCount = 0;
  closed = false;
  constructor(private readonly callbacks: TtsCallbacks) {}

  speak(_say: string): void {
    // Emit one audio chunk to represent playback starting, then hold the turn open
    // (no onTurnDone) so the assistant stays in SPEAKING until interrupted.
    if (this.closed) return;
    this.speakCount += 1;
    this.callbacks.onAudioChunk(Buffer.from([1, 2, 3, 4]));
  }

  /** Simulate the provider emitting one more buffered frame (post-flush leakage test). */
  emitAudio(): void {
    if (this.closed) return;
    this.callbacks.onAudioChunk(Buffer.from([9, 9, 9, 9]));
  }

  /** Complete the current synthesized turn when a test wants normal playback. */
  finish(): void {
    if (this.closed) return;
    this.callbacks.onTurnDone();
  }

  flush(): void {
    this.flushCount += 1;
    this.flushedAt = Date.now();
  }

  close(): void {
    this.closed = true;
  }
}

/** A TTS provider that hands back the single fake stream it opened (for inspection). */
function fakeTtsProvider(): TtsProvider & { stream: FakeTtsStream | null } {
  const provider = {
    live: true as const,
    stream: null as FakeTtsStream | null,
    open(callbacks: TtsCallbacks): TtsStream {
      const s = new FakeTtsStream(callbacks);
      provider.stream = s;
      return s;
    },
  };
  return provider;
}

/**
 * A processor whose turns can be held in flight, so we can assert that a barge-in
 * discards a partial (still-thinking) response. Each handleTurn parks until released.
 */
function controllableProcessor(): TurnProcessor & {
  release(contract?: Partial<TurnContract>): void;
  pending: number;
} {
  let resolveCurrent: ((c: TurnContract) => void) | null = null;
  let lastInput: { sessionId: string; turnId: string } | null = null;
  const api = {
    pending: 0,
    release(contract?: Partial<TurnContract>) {
      if (!resolveCurrent || !lastInput) return;
      const full: TurnContract = {
        session_id: lastInput.sessionId,
        turn_id: lastInput.turnId,
        state: 'WAITING',
        say: 'Here is a long spoken response you might interrupt.',
        cards: [],
        memory_ops: [],
        flags: ['none'],
        ...contract,
      };
      const r = resolveCurrent;
      resolveCurrent = null;
      api.pending -= 1;
      r(full);
    },
    handleTurn(input: { sessionId: string; turnId: string; userText: string }) {
      lastInput = input;
      api.pending += 1;
      return new Promise<TurnContract>((resolve) => {
        resolveCurrent = resolve;
      });
    },
  };
  return api;
}

interface Harness {
  cfg: Config;
  store: Store;
  server: http.Server;
  wss: WebSocketServer;
  url: string;
  caregiverId: string;
  tts: ReturnType<typeof fakeTtsProvider>;
  processor: ReturnType<typeof controllableProcessor>;
}

async function makeHarness(): Promise<Harness> {
  const cfg = loadConfig(EMPTY);
  const store = createStore(':memory:', cfg.encryptionKey);
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/ws' });
  const tts = fakeTtsProvider();
  const processor = controllableProcessor();
  createGateway({ cfg, store, tts, processor }).attach(wss);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const caregiver = store.repos.caregiver.create({ display_name: 'Alex' });
  store.repos.caregiver.setConsent(caregiver.id);
  store.repos.patient.create({
    caregiver_id: caregiver.id,
    name: 'Morgan',
    diagnosis: 'metastatic_cancer',
    diagnosis_notes: null,
    care_team: { other: [] },
  });
  seedCompletedOnboarding(store.repos, caregiver.id);
  return {
    cfg,
    store,
    server,
    wss,
    url: `ws://127.0.0.1:${port}/ws`,
    caregiverId: caregiver.id,
    tts,
    processor,
  };
}

interface Client {
  ws: WebSocket;
  messages: ServerMessage[];
  audioFrames: Buffer[];
  open: Promise<void>;
}

function connect(url: string): Client {
  const ws = new WebSocket(url);
  const messages: ServerMessage[] = [];
  const audioFrames: Buffer[] = [];
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      audioFrames.push(Buffer.from(data));
      return;
    }
    messages.push(JSON.parse(data.toString('utf8')) as ServerMessage);
  });
  const open = new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  return { ws, messages, audioFrames, open };
}

function send(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

async function waitFor(
  check: () => boolean,
  timeoutMs = 1000,
  label = 'condition',
): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const states = (msgs: ServerMessage[]) =>
  msgs
    .filter((m): m is Extract<ServerMessage, { type: 'assistant_state' }> => m.type === 'assistant_state')
    .map((m) => m.state);

let harness: Harness | undefined;

afterEach(async () => {
  if (harness) {
    for (const client of harness.wss.clients) client.terminate();
    await new Promise<void>((resolve) => harness!.wss.close(() => resolve()));
    await new Promise<void>((resolve) => harness!.server.close(() => resolve()));
    harness = undefined;
  }
});

/** Drive a client through attach → text turn → released contract → SPEAKING. */
async function driveToSpeaking(h: Harness): Promise<Client & { sessionId: string }> {
  const s = h.store.repos.session.create(h.caregiverId);
  const c = connect(h.url);
  await c.open;
  send(c.ws, { type: 'attach_session', session_id: s.id });
  await waitFor(() => states(c.messages).includes('LISTENING'), 1000, 'LISTENING');

  // Start a turn; the processor parks until we release it.
  send(c.ws, { type: 'text_input', text: 'tell me something long' });
  await waitFor(() => h.processor.pending === 1, 1000, 'turn in flight');
  // Release the contract so the turn advances into SPEAKING and TTS starts.
  h.processor.release();
  await waitFor(() => states(c.messages).includes('SPEAKING'), 1000, 'SPEAKING');
  // The fake TTS emitted its first audio frame on speak().
  await waitFor(() => c.audioFrames.length >= 1, 1000, 'first audio frame');
  return Object.assign(c, { sessionId: s.id });
}

describe('Barge-in — halt within 300ms and correct state transition (R4.3/R16.3)', () => {
  it('flushes TTS and returns SPEAKING → LISTENING in under 300ms', async () => {
    harness = await makeHarness();
    const c = await driveToSpeaking(harness);
    const stream = harness.tts.stream!;
    expect(stream).toBeTruthy();
    expect(stream.flushedAt).toBeNull();

    const before = c.messages.length;
    const interruptAt = Date.now();
    send(c.ws, { type: 'interrupt' });

    // A fresh LISTENING lands after the interrupt (SPEAKING → LISTENING).
    await waitFor(
      () => c.messages.slice(before).some((m) => m.type === 'assistant_state' && m.state === 'LISTENING'),
      1000,
      'post-interrupt LISTENING',
    );
    const listeningAt = Date.now();

    // The TTS buffer was flushed…
    expect(stream.flushCount).toBeGreaterThanOrEqual(1);
    expect(stream.flushedAt).not.toBeNull();

    // …and both the flush and the state transition happened within the 300ms budget.
    expect(stream.flushedAt! - interruptAt).toBeLessThan(300);
    expect(listeningAt - interruptAt).toBeLessThan(300);

    // The observed transition sequence ends SPEAKING → LISTENING.
    const seq = states(c.messages);
    const speakingIdx = seq.lastIndexOf('SPEAKING');
    expect(speakingIdx).toBeGreaterThanOrEqual(0);
    expect(seq.slice(speakingIdx + 1)).toContain('LISTENING');
    c.ws.close();
  });

  it('stops forwarding buffered TTS audio the instant the interrupt lands (R4.3)', async () => {
    harness = await makeHarness();
    const c = await driveToSpeaking(harness);
    const stream = harness.tts.stream!;
    const framesBefore = c.audioFrames.length;

    send(c.ws, { type: 'interrupt' });
    await waitFor(
      () => states(c.messages).lastIndexOf('LISTENING') > states(c.messages).lastIndexOf('SPEAKING'),
      1000,
      'LISTENING after SPEAKING',
    );

    // The provider keeps emitting buffered frames just after flush(); none of them
    // should reach the client now that forwarding is gated off.
    stream.emitAudio();
    stream.emitAudio();
    // Give any (incorrectly) forwarded frames a moment to arrive.
    await new Promise((r) => setTimeout(r, 50));
    expect(c.audioFrames.length).toBe(framesBefore);
    c.ws.close();
  });
});

describe('Barge-in — never penalized, treated as the next turn (R4.4)', () => {
  it('records no flag for the interruption and accepts the next turn normally', async () => {
    harness = await makeHarness();
    const c = await driveToSpeaking(harness);
    const stream = harness.tts.stream!;

    send(c.ws, { type: 'interrupt' });
    await waitFor(
      () => states(c.messages).lastIndexOf('LISTENING') > states(c.messages).lastIndexOf('SPEAKING'),
      1000,
      'LISTENING after SPEAKING',
    );

    // No flag was raised by the barge-in itself (interruption is not penalized).
    const reloaded = harness.store.repos.session.get(c.sessionId);
    expect(reloaded?.flags ?? []).toHaveLength(0);

    // The new speech is accepted as the next turn: a fresh turn completes end-to-end.
    const beforeContracts = c.messages.filter((m) => m.type === 'turn_contract').length;
    send(c.ws, { type: 'text_input', text: 'okay never mind, how are you' });
    await waitFor(() => harness!.processor.pending === 1, 1000, 'next turn in flight');
    harness.processor.release();
    // This turn is allowed to finish normally; the first was intentionally held open
    // so the interrupt could land mid-playback.
    await waitFor(() => harness!.tts.stream !== stream, 1000, 'second turn TTS stream');
    harness.tts.stream!.finish();
    await waitFor(
      () => c.messages.filter((m) => m.type === 'turn_contract').length > beforeContracts,
      1000,
      'next turn contract',
    );
    c.ws.close();
  });

  it('discards a partial in-flight response when interrupted while THINKING (R4.3)', async () => {
    harness = await makeHarness();
    const s = harness.store.repos.session.create(harness.caregiverId);
    const c = connect(harness.url);
    await c.open;
    send(c.ws, { type: 'attach_session', session_id: s.id });
    await waitFor(() => states(c.messages).includes('LISTENING'), 1000, 'LISTENING');

    // Start a turn but DO NOT release it — it is parked in THINKING.
    send(c.ws, { type: 'text_input', text: 'this response will be abandoned' });
    await waitFor(() => harness!.processor.pending === 1, 1000, 'turn in flight');
    await waitFor(() => states(c.messages).includes('THINKING'), 1000, 'THINKING');

    const contractsBefore = c.messages.filter((m) => m.type === 'turn_contract').length;

    // Barge in while still thinking.
    send(c.ws, { type: 'interrupt' });
    await waitFor(
      () => states(c.messages).lastIndexOf('LISTENING') > states(c.messages).lastIndexOf('THINKING'),
      1000,
      'LISTENING after THINKING',
    );

    // Now release the abandoned turn: its contract must NOT be delivered (discarded).
    harness.processor.release();
    await new Promise((r) => setTimeout(r, 60));
    const contractsAfter = c.messages.filter((m) => m.type === 'turn_contract').length;
    expect(contractsAfter).toBe(contractsBefore);
    c.ws.close();
  });
});
