import type { WebSocket, WebSocketServer } from 'ws';
import type { AssistantState, TurnContract } from '@turtle/shared';
import type { Config } from '../config.js';
import type { Store } from '../store/index.js';
import type { Clock, LatencyLogSink } from './latency.js';
import { SessionChannel } from './session.js';

/**
 * Voice Gateway module (design.md §Module boundaries).
 *
 * Owns the realtime edge: the WebSocket session channel (one connection per
 * session, kept open for the whole session), the Deepgram ASR client, the
 * ElevenLabs TTS client, audio muxing, and barge-in control. Holds provider API
 * keys — they are NEVER exposed to the client (client-initiated connections use
 * single-use tokens).
 *
 * Every provider degrades: no Deepgram → text-in; no ElevenLabs → text-only.
 * The gateway hands final user text to the Orchestrator and streams the returned
 * `say` back out as audio, then forwards the `turn_contract` to the client.
 *
 * Task 7 status: the session channel is real — it binds one WS to one session,
 * keeps the socket open for the whole session, routes the client↔server message
 * protocol, and persists session lifecycle (start/end, mode_transitions, flags).
 * The downstream ASR / TTS / orchestrator handoffs are declared here as seams and
 * wired to safe, honest stubs. Real provider behavior lands in Tasks 9 (Deepgram),
 * 10 (ElevenLabs), and 15–22 (orchestrator). The stubs NEVER fabricate provider
 * output; when a provider is degraded the channel says so via `error{degraded}`.
 */

// ---- Downstream seams (filled by later tasks) ----

/**
 * ASR seam (Task 9 — Deepgram streaming). The channel forwards captured PCM here
 * and receives interim/final transcripts back through the supplied callbacks.
 * A session opens exactly one ASR stream and keeps it for the session.
 */
export interface AsrStream {
  /** Push a chunk of captured PCM (16kHz mono) into the recognizer. */
  pushAudio(chunk: Buffer): void;
  /** Signal end-of-speech for the current user turn (button release / endpoint). */
  endTurn(): void;
  /** Tear down the recognizer when the session closes. */
  close(): void;
}

export interface AsrCallbacks {
  onInterim(text: string): void;
  /** Committed user turn text; drives the orchestrator handoff. */
  onFinal(text: string, confidence: number | null): void;
}

export interface AsrProvider {
  /** True when a real ASR provider (Deepgram) is configured. */
  readonly live: boolean;
  /** Open a per-session recognizer. Returns null when degraded (text-in fallback). */
  open(callbacks: AsrCallbacks): AsrStream | null;
}

/**
 * TTS seam (Task 10 — ElevenLabs streaming). The gateway streams the contract's
 * `say` here and forwards emitted PCM chunks to the client. One TTS connection is
 * kept open across turns per the frozen ElevenLabs preset.
 */
export interface TtsCallbacks {
  onAudioChunk(chunk: Buffer): void;
  /** The final flush of a turn has been emitted. */
  onTurnDone(): void;
}

export interface TtsStream {
  /** Synthesize one turn's `say` text (flush on the final sentence). */
  speak(say: string): void;
  /** Barge-in: flush the buffer and stop forwarding audio immediately. */
  flush(): void;
  close(): void;
}

export interface TtsProvider {
  /** True when a real TTS provider (ElevenLabs) is configured. */
  readonly live: boolean;
  /** Open a per-session synthesizer. Returns null when degraded (text-only). */
  open(callbacks: TtsCallbacks): TtsStream | null;
}

/**
 * Orchestrator seam (Tasks 15–22). Given committed user text, produce a validated
 * turn contract. Task 7 ships a canned processor so the channel is exercisable with
 * zero keys; it never invents cards, memory, or safety behavior.
 */
export interface TurnProcessor {
  handleTurn(input: {
    sessionId: string;
    turnId: string;
    userText: string;
  }): Promise<TurnContract>;
}

export interface GatewayDeps {
  cfg: Config;
  store: Store;
  /** Optional real providers; when omitted the channel runs in its degraded stub mode. */
  asr?: AsrProvider;
  tts?: TtsProvider;
  processor?: TurnProcessor;
  /**
   * Per-turn latency instrumentation seams (Task 13, R16.1 / R15.4). Both optional:
   * `latencySink` defaults to a structured single-line JSON console log; `clock`
   * defaults to `performance.now()` and is injectable so timing tests are
   * deterministic.
   */
  latencySink?: LatencyLogSink;
  clock?: Clock;
}

export interface SessionChannelHandle {
  readonly sessionId: string | null;
  readonly state: AssistantState;
  close(): void;
}

export interface Gateway {
  /** Attach session WebSocket handling to an existing ws server. */
  attach(wss: WebSocketServer): void;
}

/**
 * Build the gateway. Each incoming socket becomes a SessionChannel; the channel is
 * responsible for binding to a session, routing messages, and cleaning up on close.
 */
export function createGateway(deps: GatewayDeps): Gateway {
  return {
    attach(wss: WebSocketServer): void {
      wss.on('connection', (socket: WebSocket) => {
        new SessionChannel(socket, deps);
      });
    },
  };
}

export { SessionChannel } from './session.js';
export {
  TurnTimer,
  percentile,
  p50,
  p95,
  consoleLatencySink,
  type Clock,
  type LatencyBreakdown,
  type LatencyLogSink,
  type TurnLatencyRecord,
} from './latency.js';
