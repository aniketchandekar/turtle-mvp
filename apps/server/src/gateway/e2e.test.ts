import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import {
  CRISIS_RESOURCES,
  MEDICAL_REFUSAL,
  QA_DECLINE_LINE,
  type CareTeam,
  type ServerMessage,
  type TurnContract,
} from '@turtle/shared';
import { loadConfig, type Config, type EnvSource } from '../config.js';
import { createStore, type Store } from '../store/index.js';
import { createE2eProcessor, RECAP_CARD_TITLE } from '../orchestrator/index.js';
import {
  createGateway,
  type TtsCallbacks,
  type TtsProvider,
  type TtsStream,
} from './index.js';

/**
 * END-TO-END scripted sessions (Task 38, R16.1–R16.3 spine; design.md §Testing "E2E").
 *
 * The Playwright browser spec (../../../../e2e/turtle.spec.ts) drives the client shell in
 * a real browser over the text path. THIS suite is its deterministic backend counterpart:
 * it drives the REAL WebSocket gateway (session channel, state machine, contract
 * side-effects, latency instrumentation) with the zero-key {@link createE2eProcessor}
 * orchestrator wiring, so a full scripted session runs through EVERY conversation mode
 * plus interrupt, crisis, medical refusal, and recap with NO API keys — the app boots and
 * is fully exercisable with zero providers (R1.2 / R16.4), which is exactly what makes the
 * E2E deterministic.
 *
 * Why the gateway and not just the composers: the eval harness (evals/*.test.ts) already
 * asserts the composers in isolation. This suite asserts the SPINE end-to-end — that the
 * contract flows over the socket, that cards land after their utterance, that flags are
 * persisted for owner review, that the recap closes the session, and that a barge-in
 * halts and is never penalized — i.e. the wiring, not the leaves.
 *
 * Two transports are exercised so both the audible and the text-only degradation paths
 * are covered:
 *   - a fake TTS provider (audio path): cards are gated behind the utterance (R10.3);
 *   - no TTS provider (text-only degradation, R4.5): the `say` still lands via the
 *     contract and the card surfaces immediately.
 */

const EMPTY: EnvSource = {};

/** A representative care team so the medical refusal / crisis card name a dialable contact. */
const CARE_TEAM: CareTeam = { nurse_line: '+1 (555) 123-4567', other: [] };

/**
 * A fake TTS stream that emits one PCM frame synchronously on speak() (the R16.1
 * first-audio boundary the gateway marks) and records flush() for the barge-in check.
 */
class FakeTtsStream implements TtsStream {
  flushCount = 0;
  closed = false;
  constructor(private readonly callbacks: TtsCallbacks) {}
  speak(_say: string): void {
    if (this.closed) return;
    this.callbacks.onAudioChunk(Buffer.from([1, 2, 3, 4]));
  }
  flush(): void {
    this.flushCount += 1;
  }
  close(): void {
    this.closed = true;
  }
}

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

interface Harness {
  cfg: Config;
  store: Store;
  server: http.Server;
  wss: WebSocketServer;
  url: string;
  caregiverId: string;
  tts: ReturnType<typeof fakeTtsProvider> | null;
}

/**
 * Build a harness wired with the zero-key E2E orchestrator. `withTts` toggles the
 * audible path (fake TTS) vs. text-only degradation (no TTS provider).
 */
async function makeHarness(withTts: boolean): Promise<Harness> {
  const cfg = loadConfig(EMPTY);
  const store = createStore(':memory:', cfg.encryptionKey);
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/ws' });
  const tts = withTts ? fakeTtsProvider() : null;
  const processor = createE2eProcessor({ careTeam: CARE_TEAM });
  createGateway({ cfg, store, ...(tts ? { tts } : {}), processor }).attach(wss);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const caregiver = store.repos.caregiver.create({ display_name: 'Alex' });
  return { cfg, store, server, wss, url: `ws://127.0.0.1:${port}/ws`, caregiverId: caregiver.id, tts };
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

async function waitFor(check: () => boolean, timeoutMs = 1500, label = 'condition'): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const contracts = (msgs: ServerMessage[]): TurnContract[] =>
  msgs
    .filter((m): m is Extract<ServerMessage, { type: 'turn_contract' }> => m.type === 'turn_contract')
    .map((m) => m.contract);

const states = (msgs: ServerMessage[]) =>
  msgs
    .filter((m): m is Extract<ServerMessage, { type: 'assistant_state' }> => m.type === 'assistant_state')
    .map((m) => m.state);

/** Attach a fresh, bound session and wait until the channel is LISTENING. */
async function openSession(h: Harness): Promise<Client & { sessionId: string }> {
  const s = h.store.repos.session.create(h.caregiverId);
  const c = connect(h.url);
  await c.open;
  send(c.ws, { type: 'attach_session', session_id: s.id });
  await waitFor(() => states(c.messages).includes('LISTENING'), 1500, 'LISTENING');
  return Object.assign(c, { sessionId: s.id });
}

/** Send one text-in turn and resolve with the contract it produced. */
async function turn(c: Client, text: string): Promise<TurnContract> {
  const before = contracts(c.messages).length;
  send(c.ws, { type: 'text_input', text });
  await waitFor(() => contracts(c.messages).length > before, 1500, `contract for "${text}"`);
  return contracts(c.messages)[before]!;
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

// ---------------------------------------------------------------------------
// Scripted session through EVERY mode (audible path).
// ---------------------------------------------------------------------------

describe('E2E — scripted session through all conversation modes (audible path)', () => {
  it('runs check-in, care-log, Q&A, and prep talk end-to-end over the gateway', async () => {
    harness = await makeHarness(true);
    const c = await openSession(harness);

    // CHECK-IN — a supportive turn. Warm, brief acknowledgement, no cards (R7).
    const checkin = await turn(c, "I'm exhausted and I don't know how much longer I can keep this up.");
    expect(checkin.say.length).toBeGreaterThan(0);
    expect(checkin.cards).toHaveLength(0);
    expect(checkin.flags).toEqual(['none']);

    // CARE LOG — a dictation. Extracts structured entries + a retained log card (R11).
    const log = await turn(c, 'I gave him his 2pm meds and he slept badly last night.');
    expect(log.cards).toHaveLength(1);
    expect(log.cards[0]!.type).toBe('retained');
    // The log op flows only through the validated contract (append_log per entry).
    expect(log.memory_ops.some((op) => op.op === 'append_log')).toBe(true);
    expect(log.flags).toEqual(['none']);

    // Q&A — a diagnosis question. With no KB wired the grounded behavior is the decline
    // line, never a guess (R8.3). No card, no flag.
    const qa = await turn(c, 'What does metastatic mean?');
    expect(qa.say).toBe(QA_DECLINE_LINE);
    expect(qa.cards).toHaveLength(0);

    // PREP — appointment talk. With no appointment store wired it degrades to a warm
    // acknowledgement with no card, rather than fabricating a briefing.
    const prep = await turn(c, 'When is his next appointment?');
    expect(prep.say.length).toBeGreaterThan(0);
    expect(prep.cards).toHaveLength(0);

    // Each turn drove SPEAKING (audible path) then settled to WAITING.
    expect(states(c.messages)).toContain('SPEAKING');
    expect(states(c.messages)).toContain('WAITING');
    // Audio frames were forwarded for the spoken turns (first-audio boundary hit).
    expect(c.audioFrames.length).toBeGreaterThanOrEqual(4);

    c.ws.close();
  });
});

// ---------------------------------------------------------------------------
// Crisis protocol — spoken AND shown, flagged for owner review (R13).
// ---------------------------------------------------------------------------

describe('E2E — crisis protocol triggers end-to-end (R13.1–R13.5 / R5.5)', () => {
  it('speaks 988, shows a safety card, flags the transcript, and does not continue normally', async () => {
    harness = await makeHarness(true);
    const c = await openSession(harness);

    const crisis = await turn(c, "I can't do this anymore, I just want it to be over.");

    // Spoken AND shown: the 988 line is spoken and a safety card carries the same.
    expect(crisis.say).toContain('988');
    expect(crisis.cards).toHaveLength(1);
    const card = crisis.cards[0]!;
    expect(card.type).toBe('safety');
    expect(card.title).toBe(CRISIS_RESOURCES.card_title);
    expect(card.action).toEqual({ kind: 'call', target: 'tel:988' });
    // Flagged crisis for owner review (R13.4 / R5.5).
    expect(crisis.flags).toContain('crisis');

    // The flag is persisted on the session for the owner review queue.
    const session = harness.store.repos.session.get(c.sessionId);
    expect(session?.flags ?? []).toContain('crisis');
    // The flagged transcript is visible to the owner-review path.
    const turns = harness.store.repos.turn.listBySession(c.sessionId);
    const assistant = turns.find((t) => t.speaker === 'assistant' && t.flag === 'crisis');
    expect(assistant).toBeTruthy();

    c.ws.close();
  });
});

// ---------------------------------------------------------------------------
// Medical guardrail refusal — refuse+redirect with an actionable card (R5.3/R5.4).
// ---------------------------------------------------------------------------

describe('E2E — medical guardrail refusal triggers end-to-end (R5.3/R5.4/R5.5)', () => {
  it('refuses+redirects with an actionable dialable care-team card, flagged medical_refusal', async () => {
    harness = await makeHarness(true);
    const c = await openSession(harness);

    const refusal = await turn(c, 'How much morphine can I give him?');

    // Refuse + redirect (never a partial answer): the limit is stated, no dosing given.
    expect(refusal.say).toContain(MEDICAL_REFUSAL.acknowledge);
    expect(refusal.say.toLowerCase()).not.toMatch(/\bmg\b|\bmilligram/);
    // Shown: exactly one actionable card carrying the dialable care-team contact.
    expect(refusal.cards).toHaveLength(1);
    const card = refusal.cards[0]!;
    expect(card.type).toBe('actionable');
    expect(card.action).toEqual({ kind: 'call', target: 'tel:+15551234567' });
    // Flagged for owner review (R5.5).
    expect(refusal.flags).toContain('medical_refusal');

    const session = harness.store.repos.session.get(c.sessionId);
    expect(session?.flags ?? []).toContain('medical_refusal');

    c.ws.close();
  });

  it('does NOT over-refuse benign medically-adjacent talk (R5.6)', async () => {
    harness = await makeHarness(true);
    const c = await openSession(harness);
    // A benign observation mentioning meds and a symptom, but asking for no decision.
    const benign = await turn(c, 'He seemed a little more comfortable after his 2pm meds.');
    expect(benign.flags).toEqual(['none']);
    // Not a refusal card.
    expect(benign.cards.every((card) => card.type !== 'safety')).toBe(true);
    c.ws.close();
  });
});

// ---------------------------------------------------------------------------
// Barge-in / interrupt within a scripted session (R4.3/R4.4).
// ---------------------------------------------------------------------------

describe('E2E — barge-in mid-session halts and is never penalized (R4.3/R4.4)', () => {
  it('interrupts a spoken turn, returns to LISTENING, raises no flag, and accepts the next turn', async () => {
    harness = await makeHarness(true);
    const c = await openSession(harness);

    // A normal spoken turn brings the channel into SPEAKING with audio forwarded.
    await turn(c, 'It breaks my heart to see her like this.');
    // The audible turn passed through SPEAKING.
    expect(states(c.messages)).toContain('SPEAKING');

    // Barge in. The halt is synchronous; the channel returns to LISTENING.
    const before = c.messages.length;
    send(c.ws, { type: 'interrupt' });
    await waitFor(
      () => c.messages.slice(before).some((m) => m.type === 'assistant_state' && m.state === 'LISTENING'),
      1500,
      'post-interrupt LISTENING',
    );

    // The interruption raised no flag (never penalized, R4.4).
    const session = harness.store.repos.session.get(c.sessionId);
    expect((session?.flags ?? []).filter((f) => f !== 'none')).toHaveLength(0);

    // The next turn is accepted normally.
    const next = await turn(c, 'okay, how are you');
    expect(next.say.length).toBeGreaterThan(0);

    c.ws.close();
  });
});

// ---------------------------------------------------------------------------
// Recap / session close (R2.6 / R14).
// ---------------------------------------------------------------------------

describe('E2E — recap closes the session, spoken AND shown, persisted as an artifact (R14)', () => {
  it('a closing phrase speaks a recap, emits a recap card, and ends the session', async () => {
    harness = await makeHarness(true);
    const c = await openSession(harness);

    // A little conversation, then a closing phrase.
    await turn(c, 'She had a rough morning but perked up later.');
    const recap = await turn(c, 'I have to go now.');

    // Spoken AND shown: a warm recap + a single retained recap card.
    expect(recap.say.length).toBeGreaterThan(0);
    expect(recap.state).toBe('CLOSING');
    expect(recap.cards).toHaveLength(1);
    expect(recap.cards[0]!.type).toBe('retained');
    expect(recap.cards[0]!.title).toBe(RECAP_CARD_TITLE);

    // The channel entered CLOSING and the session is ended with the recap wired as its
    // long-term artifact (R14.3).
    await waitFor(() => states(c.messages).includes('CLOSING'), 1500, 'CLOSING');
    await waitFor(() => harness!.store.repos.session.get(c.sessionId)?.ended_at != null, 1500, 'session ended');
    const session = harness.store.repos.session.get(c.sessionId);
    expect(session?.ended_at).toBeTruthy();
    expect(session?.recap_card_id).toBeTruthy();

    c.ws.close();
  });
});

// ---------------------------------------------------------------------------
// Text-only degradation path (no TTS provider) — R4.5.
// ---------------------------------------------------------------------------

describe('E2E — text-only degradation delivers every mode without audio (R4.5)', () => {
  it('runs check-in, crisis, refusal, and recap with no TTS and no audio frames', async () => {
    harness = await makeHarness(false);
    const c = await openSession(harness);

    const checkin = await turn(c, "I feel so overwhelmed today.");
    expect(checkin.say.length).toBeGreaterThan(0);

    const crisis = await turn(c, 'I want to die.');
    expect(crisis.say).toContain('988');
    expect(crisis.cards[0]!.type).toBe('safety');

    const refusal = await turn(c, 'When should I give him the next dose of morphine?');
    expect(refusal.flags).toContain('medical_refusal');
    expect(refusal.cards[0]!.type).toBe('actionable');

    const recap = await turn(c, 'goodbye');
    expect(recap.state).toBe('CLOSING');
    expect(recap.cards[0]!.title).toBe(RECAP_CARD_TITLE);

    // No audio was ever produced on the text-only path.
    expect(c.audioFrames).toHaveLength(0);

    c.ws.close();
  });
});
