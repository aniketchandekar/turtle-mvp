import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { loadConfig, type Config, type EnvSource } from '../config.js';
import { createStore, type Store } from '../store/index.js';
import { createGateway, type TurnProcessor } from './index.js';
import type { ServerMessage, TurnContract } from '@turtle/shared';

/**
 * WebSocket session channel (Task 7).
 *
 * Covers R2.7 (session lifecycle persistence — start/end, mode_transitions, flags)
 * and R3.2 (client↔server message routing over one WS per session). Uses a real
 * ws server + real ws client + an in-memory SQLite store — no mocks — so the wire
 * protocol and persistence are exercised end to end. The downstream orchestrator is
 * an injectable stub so we can assert routing without provider behavior.
 */

const EMPTY: EnvSource = {};

interface Harness {
  cfg: Config;
  store: Store;
  server: http.Server;
  wss: WebSocketServer;
  url: string;
  caregiverId: string;
}

async function makeHarness(env: EnvSource = EMPTY, processor?: TurnProcessor): Promise<Harness> {
  const cfg = loadConfig(env);
  const store = createStore(':memory:', cfg.encryptionKey);
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/ws' });
  createGateway({ cfg, store, processor }).attach(wss);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const caregiver = store.repos.caregiver.create({ display_name: 'Alex' });
  return { cfg, store, server, wss, url: `ws://127.0.0.1:${port}/ws`, caregiverId: caregiver.id };
}

/** Connect a client and collect JSON server messages as they arrive. */
function connect(url: string): {
  ws: WebSocket;
  messages: ServerMessage[];
  open: Promise<void>;
} {
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

/** Wait until `predicate` is true against the collected messages, or time out. */
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

const states = (msgs: ServerMessage[]) =>
  msgs.filter((m): m is Extract<ServerMessage, { type: 'assistant_state' }> => m.type === 'assistant_state').map((m) => m.state);

let harness: Harness | undefined;

afterEach(async () => {
  if (harness) {
    // Terminate any lingering sockets so wss.close() can drain promptly.
    for (const client of harness.wss.clients) client.terminate();
    await new Promise<void>((resolve) => harness!.wss.close(() => resolve()));
    await new Promise<void>((resolve) => harness!.server.close(() => resolve()));
    harness = undefined;
  }
});

describe('SessionChannel — connect + degradation (R1.2/R3.2)', () => {
  beforeEach(async () => {
    harness = await makeHarness();
  });

  it('announces IDLE and honest degradation notices with zero keys', async () => {
    const c = connect(harness!.url);
    await c.open;
    await waitFor(c.messages, (m) => m.some((x) => x.type === 'assistant_state' && x.state === 'IDLE'));

    // With no keys, ASR and TTS both degrade — the client is told so it can adapt.
    await waitFor(c.messages, (m) => m.filter((x) => x.type === 'error').length >= 2);
    const errors = c.messages.filter((x): x is Extract<ServerMessage, { type: 'error' }> => x.type === 'error');
    const codes = errors.map((e) => e.code);
    expect(codes).toContain('asr_degraded');
    expect(codes).toContain('tts_degraded');
    expect(errors.every((e) => e.degraded === true)).toBe(true);
    c.ws.close();
  });

  it('rejects messages sent before attach_session', async () => {
    const c = connect(harness!.url);
    await c.open;
    send(c.ws, { type: 'text_input', text: 'hello' });
    await waitFor(c.messages, (m) => m.some((x) => x.type === 'error' && x.code === 'no_session'));
    c.ws.close();
  });

  it('rejects attaching to an unknown session', async () => {
    const c = connect(harness!.url);
    await c.open;
    send(c.ws, { type: 'attach_session', session_id: 'does-not-exist' });
    await waitFor(c.messages, (m) => m.some((x) => x.type === 'error' && x.code === 'unknown_session'));
    c.ws.close();
  });
});

describe('SessionChannel — turn routing (R3.2)', () => {
  beforeEach(async () => {
    harness = await makeHarness();
  });

  it('routes text_input through a full turn: transcript_final → states → turn_contract', async () => {
    const s = harness!.store.repos.session.create(harness!.caregiverId);
    const c = connect(harness!.url);
    await c.open;
    send(c.ws, { type: 'attach_session', session_id: s.id });
    await waitFor(c.messages, (m) => m.some((x) => x.type === 'assistant_state' && x.state === 'LISTENING'));

    send(c.ws, { type: 'text_input', text: 'how are you' });
    await waitFor(c.messages, (m) => m.some((x) => x.type === 'turn_contract'));

    // The user turn is echoed back as a committed transcript.
    expect(c.messages.some((x) => x.type === 'transcript_final' && x.text === 'how are you')).toBe(true);

    // State progression includes THINKING → SPEAKING → WAITING → LISTENING.
    const seq = states(c.messages);
    expect(seq).toContain('THINKING');
    expect(seq).toContain('SPEAKING');
    expect(seq).toContain('WAITING');

    // The contract is carried on the wire and bound to this session.
    const contract = c.messages.find(
      (x): x is Extract<ServerMessage, { type: 'turn_contract' }> => x.type === 'turn_contract',
    )!.contract;
    expect(contract.session_id).toBe(s.id);
    expect(contract.say.length).toBeGreaterThan(0);
    c.ws.close();
  });

  it('persists both user and assistant turns for the session', async () => {
    const s = harness!.store.repos.session.create(harness!.caregiverId);
    const c = connect(harness!.url);
    await c.open;
    send(c.ws, { type: 'attach_session', session_id: s.id });
    await waitFor(c.messages, (m) => m.some((x) => x.type === 'assistant_state' && x.state === 'LISTENING'));
    send(c.ws, { type: 'text_input', text: 'a note about today' });
    await waitFor(c.messages, (m) => m.some((x) => x.type === 'turn_contract'));

    const turns = harness!.store.repos.turn.listBySession(s.id);
    const speakers = turns.map((t) => t.speaker);
    expect(speakers).toContain('user');
    expect(speakers).toContain('assistant');
    expect(turns.find((t) => t.speaker === 'user')?.text).toBe('a note about today');
  });

  it('rejects malformed JSON and unknown message shapes without crashing', async () => {
    const s = harness!.store.repos.session.create(harness!.caregiverId);
    const c = connect(harness!.url);
    await c.open;
    send(c.ws, { type: 'attach_session', session_id: s.id });
    await waitFor(c.messages, (m) => m.some((x) => x.type === 'assistant_state' && x.state === 'LISTENING'));

    c.ws.send('this is not json');
    await waitFor(c.messages, (m) => m.some((x) => x.type === 'error' && x.code === 'bad_json'));

    send(c.ws, { type: 'nonsense_message' });
    await waitFor(c.messages, (m) => m.some((x) => x.type === 'error' && x.code === 'bad_message'));
    c.ws.close();
  });
});

describe('SessionChannel — contract side effects + lifecycle (R2.7/R5.5/R6.5)', () => {
  it('persists cards, session flags, and CLOSING end time from the contract', async () => {
    // A processor that returns a safety flag, a card, and a CLOSING state.
    const processor: TurnProcessor = {
      async handleTurn({ sessionId, turnId }): Promise<TurnContract> {
        return {
          session_id: sessionId,
          turn_id: turnId,
          state: 'CLOSING',
          say: 'I hear you. Here are some resources.',
          cards: [
            {
              type: 'safety',
              title: '988 Suicide & Crisis Lifeline',
              body: 'Call or text 988, any time.',
              action: { kind: 'call', target: 'tel:988' },
            },
          ],
          memory_ops: [{ op: 'set_fact', key: 'recurring_theme', value: 'overwhelm' }],
          flags: ['crisis'],
        };
      },
    };
    harness = await makeHarness(EMPTY, processor);
    const s = harness.store.repos.session.create(harness.caregiverId);
    const c = connect(harness.url);
    await c.open;
    send(c.ws, { type: 'attach_session', session_id: s.id });
    await waitFor(c.messages, (m) => m.some((x) => x.type === 'assistant_state' && x.state === 'LISTENING'));
    send(c.ws, { type: 'text_input', text: 'I feel hopeless' });
    await waitFor(c.messages, (m) => m.some((x) => x.type === 'turn_contract'));

    // Card persisted from the contract (never inferred client-side).
    const cards = harness.store.repos.card.listByStatus('active');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.type).toBe('safety');

    // Session flagged for owner review, and the set_fact recorded as a transition.
    const reloaded = harness.store.repos.session.get(s.id);
    expect(reloaded?.flags).toContain('crisis');
    expect(reloaded?.mode_transitions.some((t) => t.startsWith('fact:recurring_theme'))).toBe(true);

    // CLOSING contract records the session end time (R2.7).
    expect(reloaded?.ended_at).not.toBeNull();
    c.ws.close();
  });

  it('records the session end time when the socket closes (R2.7)', async () => {
    harness = await makeHarness();
    const s = harness.store.repos.session.create(harness.caregiverId);
    const c = connect(harness.url);
    await c.open;
    send(c.ws, { type: 'attach_session', session_id: s.id });
    await waitFor(c.messages, (m) => m.some((x) => x.type === 'assistant_state' && x.state === 'LISTENING'));

    expect(harness.store.repos.session.get(s.id)?.ended_at).toBeNull();
    c.ws.close();

    // The server persists ended_at on socket close.
    await waitFor([], () => harness!.store.repos.session.get(s.id)?.ended_at != null, 1500);
    expect(harness.store.repos.session.get(s.id)?.ended_at).not.toBeNull();
  });

  it('handles interrupt by returning to LISTENING (R4.3/R4.4)', async () => {
    harness = await makeHarness();
    const s = harness.store.repos.session.create(harness.caregiverId);
    const c = connect(harness.url);
    await c.open;
    send(c.ws, { type: 'attach_session', session_id: s.id });
    await waitFor(c.messages, (m) => m.some((x) => x.type === 'assistant_state' && x.state === 'LISTENING'));

    const before = c.messages.length;
    send(c.ws, { type: 'interrupt' });
    // A fresh LISTENING state is emitted after the interrupt.
    await waitFor(
      c.messages,
      (m) => m.slice(before).some((x) => x.type === 'assistant_state' && x.state === 'LISTENING'),
    );
    c.ws.close();
  });

  it('records mode_transitions on the session as states are entered (R2.7/Task 11)', async () => {
    harness = await makeHarness();
    const s = harness.store.repos.session.create(harness.caregiverId);
    const c = connect(harness.url);
    await c.open;
    send(c.ws, { type: 'attach_session', session_id: s.id });
    await waitFor(c.messages, (m) => m.some((x) => x.type === 'assistant_state' && x.state === 'LISTENING'));
    send(c.ws, { type: 'text_input', text: 'just checking in' });
    await waitFor(c.messages, (m) => m.some((x) => x.type === 'turn_contract'));

    // The state machine records each entered state on the session (never the pre-bind
    // IDLE, which has no session yet). A full turn walks LISTENING → THINKING →
    // SPEAKING → WAITING.
    const reloaded = harness.store.repos.session.get(s.id);
    const transitions = reloaded?.mode_transitions ?? [];
    expect(transitions).toContain('LISTENING');
    expect(transitions).toContain('THINKING');
    expect(transitions).toContain('SPEAKING');
    expect(transitions).toContain('WAITING');
    // Pre-bind IDLE is announced to the armed client but not persisted (no session).
    expect(transitions).not.toContain('IDLE');
    c.ws.close();
  });

  it('returns to LISTENING after a short silence following an utterance (R2.5/Task 11)', async () => {
    // A tiny silence window keeps the test fast while still exercising the timer path.
    harness = await makeHarness({ TURTLE_WAITING_SILENCE_MS: '20' });
    const s = harness.store.repos.session.create(harness.caregiverId);
    const c = connect(harness.url);
    await c.open;
    send(c.ws, { type: 'attach_session', session_id: s.id });
    await waitFor(c.messages, (m) => m.some((x) => x.type === 'assistant_state' && x.state === 'LISTENING'));

    send(c.ws, { type: 'text_input', text: 'how are you' });
    // Wait for WAITING to be announced after the utterance completes.
    await waitFor(c.messages, (m) => m.some((x) => x.type === 'assistant_state' && x.state === 'WAITING'));

    // After the short silence, a fresh LISTENING is emitted (WAITING → LISTENING).
    const waitingIdx = c.messages.findIndex((x) => x.type === 'assistant_state' && x.state === 'WAITING');
    await waitFor(
      c.messages,
      (m) => m.slice(waitingIdx + 1).some((x) => x.type === 'assistant_state' && x.state === 'LISTENING'),
      1500,
    );
    c.ws.close();
  });

  it('applies a card_action tap by moving the card to done (R16.8)', async () => {
    harness = await makeHarness();
    const s = harness.store.repos.session.create(harness.caregiverId);
    const card = harness.store.repos.card.create({
      session_id: s.id,
      type: 'actionable',
      title: 'Call the nurse line',
      body: 'Nausea question',
      action: { kind: 'call', target: 'tel:+15551234' },
    });
    const c = connect(harness.url);
    await c.open;
    send(c.ws, { type: 'attach_session', session_id: s.id });
    await waitFor(c.messages, (m) => m.some((x) => x.type === 'assistant_state' && x.state === 'LISTENING'));

    send(c.ws, { type: 'card_action', card_id: card.id, kind: 'call' });
    await waitFor([], () => harness!.store.repos.card.get(card.id)?.status === 'done', 1500);
    expect(harness.store.repos.card.get(card.id)?.status).toBe('done');
    c.ws.close();
  });
});
