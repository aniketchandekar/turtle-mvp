'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clientMessageSchema,
  serverMessageSchema,
  type AssistantState,
  type Card,
  type CardActionKind,
  type ClientMessage,
  type OnboardingPrompt,
  type OnboardingSnapshot,
  type OnboardingStepId,
  type OnboardingLocale,
  type ServerMessage,
  type TurnContract,
} from '@turtle/shared';
import { useAudioCapture } from './audio/useAudioCapture';
import { usePlaybackVad } from './audio/usePlaybackVad';
import { PcmPlayer } from './audio/PcmPlayer';
import { voiceDebug } from './audio/voiceDebug';

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:8787';
// Local single-user MVP: a fixed caregiver id is fine here (auth seam left for later).
const CAREGIVER_ID = process.env.NEXT_PUBLIC_CAREGIVER_ID ?? 'local-caregiver';

/** Derive the ws(s):// gateway URL from the http(s):// server URL. */
function wsUrl(): string {
  const base = SERVER_URL.replace(/^http/, 'ws').replace(/\/$/, '');
  return `${base}/ws`;
}

export interface SessionEvents {
  onTranscriptInterim?(text: string): void;
  onTranscriptFinal?(text: string): void;
  onState?(state: AssistantState): void;
  /**
   * Fired as soon as a validated turn contract arrives. Use this to render the spoken
   * line (`say`) into the transcript immediately. Do NOT read `cards` here for the card
   * surface — cards are gated behind {@link onCard} so they never appear before the
   * corresponding utterance has finished playing (R10.3/R16.2).
   */
  onContract?(contract: TurnContract): void;
  /**
   * Fired with the turn's single card (or `null`) at the moment it should render:
   * after the turn's spoken audio has finished playing, or immediately when the turn
   * produced no audio (text-only degradation). A turn that emits no card fires this
   * with `null` so any prior card is cleared and no-card sessions show only the mic +
   * transcript (R10.5). Never fires for a card whose utterance was interrupted (barge-in).
   */
  onCard?(card: Card | null): void;
  /** The server's single active first-run onboarding card. */
  onOnboardingPrompt?(prompt: OnboardingPrompt): void;
  onOnboardingSnapshot?(snapshot: OnboardingSnapshot): void;
  onError?(code: string, message: string, degraded: boolean): void;
}

export interface SessionApi {
  /** True once the WebSocket is open and bound to a session. */
  connected: boolean;
  /** Latest assistant state reported by the gateway. */
  assistantState: AssistantState;
  /** True while the microphone is actively capturing (push-to-talk held). */
  capturing: boolean;
  /** Most recent capture error surfaced to the mic indicator (honest failure). */
  micError: string | null;
  /** Begin continuous mic capture + streaming audio chunks. */
  pressStart(): void;
  /** Stop mic capture and commit the spoken turn. */
  pressEnd(): void;
  /** Toggle continuous mic capture on and off from the voice button. */
  toggleCapture(): void;
  /** Unlock browser audio from an intentional first-run gesture. */
  unlockAudio(): void;
  /** Barge-in during playback. */
  interrupt(): void;
  /** Text fallback when ASR is unavailable. */
  sendText(text: string): void;
  /**
   * Voice parity for card taps (R16.8): a tap on a card action sends `card_action` up
   * the same socket. The equivalent voice replies (okay/done/dismiss/call) flow through
   * the normal turn pipeline instead, so the tap path only needs to emit this message.
   */
  sendCardAction(cardId: string, kind: CardActionKind): void;
  /** Submit the value typed into the active onboarding card. */
  sendOnboardingAnswer(promptId: string, value: string, captureMethod?: 'voice' | 'typed'): void;
  /** Accept the displayed onboarding answer and advance to the next question. */
  confirmOnboarding(promptId: string): void;
  /** Return the active onboarding card to edit mode without saving anything. */
  editOnboarding(promptId: string, stepId: OnboardingStepId): void;
  skipOnboarding(promptId: string): void;
  backOnboarding(promptId: string): void;
  pauseOnboarding(promptId: string): void;
  resumeOnboarding(): void;
  /** Unlock playback and ask ElevenLabs to speak the active onboarding question again. */
  replayOnboarding(promptId: string): Promise<void>;
  switchOnboardingLanguage(promptId: string, locale: OnboardingLocale): void;
}

/**
 * Owns the single per-session WebSocket (kept open for the whole session — no
 * per-turn reconnect) and binds it to the audio capture and playback paths.
 *
 * Up: while push-to-talk is held, captured 16 kHz mono PCM chunks are sent as binary
 * `audio_chunk` frames; on release we send `turn_end` (design.md §Voice pipeline, R3.2).
 * Down: incoming binary frames are TTS PCM and are enqueued into the PcmPlayer with a
 * ~150–250ms buffer (R4.2). JSON frames are the transcript/state/contract protocol.
 */
export function useSession(events: SessionEvents = {}): SessionApi {
  const evRef = useRef(events);
  evRef.current = events;

  const [connected, setConnected] = useState(false);
  const [assistantState, setAssistantState] = useState<AssistantState>('IDLE');
  const [capturing, setCapturing] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const boundRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const uplinkChunksRef = useRef(0);
  const uplinkBytesRef = useRef(0);
  const uplinkDropLoggedRef = useRef(false);
  const downlinkChunksRef = useRef(0);
  const downlinkBytesRef = useRef(0);

  /**
   * The card from the turn whose audio is currently playing, held until playback
   * finishes so the card renders only AFTER its spoken content ends (R10.3/R16.2).
   * `null` while nothing is pending. A turn that emits no card is delivered as `null`
   * immediately (clears any prior card; keeps no-card sessions mic + transcript only,
   * R10.5). A barge-in clears the pending card so an interrupted utterance's card
   * never surfaces.
   */
  const pendingCardRef = useRef<Card | null>(null);
  /**
   * True once at least one TTS audio frame has been received for the pending turn, so
   * we know to wait for the player's idle signal. When a turn produces no audio
   * (text-only degradation), this stays false and the card is delivered immediately on
   * contract arrival.
   */
  const awaitingAudioRef = useRef(false);

  /** Deliver (or clear) the pending card to the app at render time. */
  const flushPendingCard = useCallback(() => {
    const card = pendingCardRef.current;
    pendingCardRef.current = null;
    awaitingAudioRef.current = false;
    evRef.current.onCard?.(card);
  }, []);

  const sendControl = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      voiceDebug('control_send_skipped', {
        type: msg.type,
        websocket_state: ws?.readyState ?? null,
      }, 'warn');
      return;
    }
    // Validate against the shared protocol before sending (parity with the server).
    const parsed = clientMessageSchema.safeParse(msg);
    if (!parsed.success) {
      voiceDebug('control_validation_failed', { type: msg.type }, 'error');
      return;
    }
    ws.send(JSON.stringify(msg));
    voiceDebug('control_sent', { type: msg.type, session_id: sessionIdRef.current });
  }, []);

  // ---- Capture wiring: stream PCM up while held ----
  const capture = useAudioCapture({
    onChunk: (pcm) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(pcm); // binary audio_chunk frame (16 kHz mono PCM)
        uplinkChunksRef.current += 1;
        uplinkBytesRef.current += pcm.byteLength;
        if (uplinkChunksRef.current === 1) {
          voiceDebug('audio_uplink_started', {
            session_id: sessionIdRef.current,
            first_chunk_bytes: pcm.byteLength,
          });
        }
      } else if (!uplinkDropLoggedRef.current) {
        uplinkDropLoggedRef.current = true;
        voiceDebug('audio_uplink_unavailable', {
          websocket_state: ws?.readyState ?? null,
        }, 'error');
      }
    },
    onError: (err) => {
      setCapturing(false);
      const message =
        err.name === 'NotAllowedError'
          ? 'Microphone access is off.'
          : 'Microphone unavailable.';
      setMicError(message);
      voiceDebug('microphone_error_surfaced', { error_name: err.name }, 'error');
      evRef.current.onError?.('mic_error', message, false);
    },
  });

  const pressStart = useCallback(() => {
    setMicError(null);
    setCapturing(true);
    uplinkChunksRef.current = 0;
    uplinkBytesRef.current = 0;
    uplinkDropLoggedRef.current = false;
    voiceDebug('push_to_talk_started', {
      session_id: sessionIdRef.current,
      websocket_state: wsRef.current?.readyState ?? null,
      assistant_state: assistantState,
    });
    // Unlock/resume playback on the same user gesture so the AudioContext is allowed.
    void playerRef.current?.resume().catch(() => undefined);
    void capture.start().catch(() => {
      // onError already surfaced the failure and reset state.
    });
  }, [assistantState, capture]);

  const pressEnd = useCallback(() => {
    if (!capture.isCapturing()) {
      setCapturing(false);
      return;
    }
    capture.stop();
    setCapturing(false);
    voiceDebug('push_to_talk_ended', {
      session_id: sessionIdRef.current,
      pcm_chunks_sent: uplinkChunksRef.current,
      pcm_bytes_sent: uplinkBytesRef.current,
    }, uplinkChunksRef.current === 0 ? 'warn' : 'info');
    // Signal end-of-speech for this turn (R2.3/R3 up-path).
    sendControl({ type: 'turn_end' });
  }, [capture, sendControl]);

  const toggleCapture = useCallback(() => {
    if (capture.isCapturing()) pressEnd();
    else pressStart();
  }, [capture, pressEnd, pressStart]);

  const unlockAudio = useCallback(() => {
    // Browsers suspend Web Audio until a user gesture. The welcome button is the
    // clearest, least surprising place to make that gesture count.
    void playerRef.current?.resume().catch(() => undefined);
  }, []);

  const interrupt = useCallback(() => {
    // Halt local playback immediately, then tell the gateway to flush TTS, discard
    // the partial response, and return to LISTENING (R4.3). The local flush makes the
    // audible stop instant rather than waiting on the round-trip.
    playerRef.current?.flush();
    // An interrupted utterance did not finish speaking, so its card must never render
    // (R10.3). Drop any card gated behind this turn's audio without delivering it.
    pendingCardRef.current = null;
    awaitingAudioRef.current = false;
    sendControl({ type: 'interrupt' });
  }, [sendControl]);

  // ---- Barge-in: client-side VAD during playback (R4.3/R4.4/R16.3) ----
  // A dedicated listener runs ONLY while the assistant is speaking and the caregiver
  // is not already holding push-to-talk. On sustained speech it fires `interrupt`,
  // treating the new speech as the next turn (never a penalty).
  const bargeIn = usePlaybackVad({
    onSpeech: () => interrupt(),
  });
  const bargeInRef = useRef(bargeIn);
  bargeInRef.current = bargeIn;

  const sendText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      sendControl({ type: 'text_input', text: trimmed });
    },
    [sendControl],
  );

  const sendCardAction = useCallback(
    (cardId: string, kind: CardActionKind) => {
      // Voice parity (R16.8): a tap emits `card_action`; the equivalent spoken reply
      // (okay/done/dismiss/call) instead flows through the normal turn pipeline. The
      // server owns the lifecycle transition — the client only reports the tap.
      sendControl({ type: 'card_action', card_id: cardId, kind });
    },
    [sendControl],
  );

  const sendOnboardingAnswer = useCallback(
    (promptId: string, value: string, captureMethod: 'voice' | 'typed' = 'typed') => {
      const trimmed = value.trim();
      if (trimmed) sendControl({ type: 'onboarding_answer', prompt_id: promptId, value: trimmed, capture_method: captureMethod });
    },
    [sendControl],
  );
  const confirmOnboarding = useCallback(
    (promptId: string) => sendControl({ type: 'onboarding_section_confirm', prompt_id: promptId }),
    [sendControl],
  );
  const editOnboarding = useCallback(
    (promptId: string, stepId: OnboardingStepId) => sendControl({ type: 'onboarding_edit', prompt_id: promptId, step_id: stepId }),
    [sendControl],
  );
  const skipOnboarding = useCallback((promptId: string) => sendControl({ type: 'onboarding_skip', prompt_id: promptId }), [sendControl]);
  const backOnboarding = useCallback((promptId: string) => sendControl({ type: 'onboarding_back', prompt_id: promptId }), [sendControl]);
  const pauseOnboarding = useCallback((promptId: string) => sendControl({ type: 'onboarding_pause', prompt_id: promptId }), [sendControl]);
  const resumeOnboarding = useCallback(() => sendControl({ type: 'onboarding_resume' }), [sendControl]);
  const replayOnboarding = useCallback(async (promptId: string) => {
    // Discard any question audio scheduled before the browser allowed playback.
    playerRef.current?.flush();
    pendingCardRef.current = null;
    awaitingAudioRef.current = false;
    await playerRef.current?.resume().catch(() => undefined);
    sendControl({ type: 'onboarding_replay', prompt_id: promptId });
  }, [sendControl]);
  const switchOnboardingLanguage = useCallback((promptId: string, locale: OnboardingLocale) => sendControl({ type: 'onboarding_language', prompt_id: promptId, locale }), [sendControl]);

  // ---- WebSocket lifecycle: one connection per session, kept open ----
  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;

    const reconnect = () => {
      if (disposed || reconnectTimer) return;
      // The server is commonly restarted during local development. A closed socket
      // must create a fresh server session before accepting another turn.
      const delay = Math.min(1_000 * 2 ** reconnectAttempts, 5_000);
      reconnectAttempts += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    };

    playerRef.current = new PcmPlayer({
      // End-of-utterance: the turn's audio has finished at the speakers. This is the
      // gate for rendering that turn's card (R10.3/R16.2 — within 500ms of the spoken
      // content finishing, and never interrupting speech). Fires only for utterances
      // that ran to completion; a barge-in flush invalidates the stream and suppresses
      // it, so an interrupted turn's card never surfaces.
      onIdle: () => {
        if (disposed) return;
        if (downlinkChunksRef.current > 0) {
          voiceDebug('tts_playback_finished', {
            session_id: sessionIdRef.current,
            pcm_chunks: downlinkChunksRef.current,
            pcm_bytes: downlinkBytesRef.current,
          });
          downlinkChunksRef.current = 0;
          downlinkBytesRef.current = 0;
        }
        if (pendingCardRef.current) flushPendingCard();
      },
    });

    async function connect() {
      // Create (or reuse) a session id via the REST control plane, then attach the WS.
      let sessionId: string;
      voiceDebug('session_create_requested', { server_url: SERVER_URL });
      try {
        const res = await fetch(`${SERVER_URL}/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ caregiver_id: CAREGIVER_ID }),
        });
        if (!res.ok) throw new Error(`session create failed: ${res.status}`);
        const session = (await res.json()) as { id: string };
        sessionId = session.id;
        sessionIdRef.current = sessionId;
        voiceDebug('session_created', { session_id: sessionId });
      } catch {
        if (!disposed) {
          const message = 'Could not reach the Turtle server.';
          evRef.current.onError?.('server_unreachable', message, false);
          voiceDebug('session_create_failed', { server_url: SERVER_URL }, 'error');
          reconnect();
        }
        return;
      }
      if (disposed) return;

      const ws = new WebSocket(wsUrl());
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      voiceDebug('websocket_connecting', { session_id: sessionId });

      ws.onopen = () => {
        boundRef.current = true;
        reconnectAttempts = 0;
        // Bind this socket to the session created above.
        ws.send(JSON.stringify({ type: 'attach_session', session_id: sessionId }));
        voiceDebug('websocket_open', { session_id: sessionId });
        voiceDebug('control_sent', { type: 'attach_session', session_id: sessionId });
        if (!disposed) setConnected(true);
      };

      ws.onmessage = (event: MessageEvent) => {
        // Binary frames are TTS PCM audio_chunk frames → playback buffer.
        if (event.data instanceof ArrayBuffer) {
          // Note this turn is producing audio, so a pending card waits for the
          // player's idle signal rather than rendering on contract arrival.
          awaitingAudioRef.current = true;
          downlinkChunksRef.current += 1;
          downlinkBytesRef.current += event.data.byteLength;
          if (downlinkChunksRef.current === 1) {
            voiceDebug('tts_audio_received', {
              session_id: sessionIdRef.current,
              first_chunk_bytes: event.data.byteLength,
            });
          }
          playerRef.current?.enqueue(event.data);
          return;
        }
        // JSON frames are the transcript/state/contract/error protocol.
        handleServerMessage(event.data as string);
      };

      ws.onclose = () => {
        if (disposed || wsRef.current !== ws) return;
        wsRef.current = null;
        boundRef.current = false;
        setConnected(false);
        setAssistantState('IDLE');
        voiceDebug('websocket_closed', { session_id: sessionId, reconnecting: true }, 'warn');
        reconnect();
      };
      ws.onerror = () => {
        if (!disposed) {
          voiceDebug('websocket_error', { session_id: sessionId }, 'error');
          evRef.current.onError?.('ws_error', 'Connection interrupted.', false);
        }
      };
    }

    function handleServerMessage(raw: string) {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        voiceDebug('server_message_invalid_json', { payload_chars: raw.length }, 'warn');
        return;
      }
      const parsed = serverMessageSchema.safeParse(json);
      if (!parsed.success) {
        voiceDebug('server_message_validation_failed', {
          message_type: typeof json === 'object' && json !== null && 'type' in json
            ? String((json as { type?: unknown }).type)
            : 'unknown',
        }, 'warn');
        return;
      }
      const msg: ServerMessage = parsed.data;
      switch (msg.type) {
        case 'transcript_interim':
          voiceDebug('transcript_interim_received', { characters: msg.text.length });
          evRef.current.onTranscriptInterim?.(msg.text);
          return;
        case 'transcript_final':
          voiceDebug('transcript_final_received', { characters: msg.text.length });
          evRef.current.onTranscriptFinal?.(msg.text);
          return;
        case 'assistant_state':
          voiceDebug('assistant_state_received', { state: msg.state });
          setAssistantState(msg.state);
          evRef.current.onState?.(msg.state);
          return;
        case 'turn_contract': {
          const contract = msg.contract;
          voiceDebug('turn_contract_received', {
            turn_id: contract.turn_id,
            state: contract.state,
            cards: contract.cards.length,
            say_characters: contract.say.length,
          });
          // The spoken line renders into the transcript immediately (contract-driven).
          evRef.current.onContract?.(contract);
          // The card is gated behind the utterance (R10.3/R16.2). Hold this turn's
          // single card (or null) as pending. If this turn streamed audio, wait for
          // the player's idle signal to surface it; otherwise (text-only) surface it
          // now. Delivering `null` clears any prior card so no-card turns leave the
          // session mic + transcript only (R10.5), and enforces one active card.
          pendingCardRef.current = contract.cards[0] ?? null;
          if (awaitingAudioRef.current) {
            // Audio is (or was) streaming for this turn: onIdle will flush the card.
            // If audio already fully drained before the contract landed, flush now so
            // the card is not stranded waiting for an idle edge that already passed.
            if (playerRef.current?.isIdle() ?? true) flushPendingCard();
          } else {
            flushPendingCard();
          }
          return;
        }
        case 'onboarding_prompt':
          voiceDebug('onboarding_prompt_received', {
            step: msg.prompt.stepId,
            confirmation: Boolean(msg.prompt.confirmation),
            complete: Boolean(msg.prompt.complete),
          });
          evRef.current.onOnboardingPrompt?.(msg.prompt);
          return;
        case 'onboarding_snapshot':
          evRef.current.onOnboardingSnapshot?.(msg.snapshot);
          return;
        case 'error':
          voiceDebug('server_error_received', {
            code: msg.code,
            degraded: Boolean(msg.degraded),
          }, 'warn');
          evRef.current.onError?.(msg.code, msg.message, msg.degraded ?? false);
          return;
        default:
          return;
      }
    }

    void connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      boundRef.current = false;
      voiceDebug('session_disposing', { session_id: sessionIdRef.current });
      capture.stop();
      const ws = wsRef.current;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
          }
        } catch {
          /* ignore */
        }
        wsRef.current = null;
      }
      void playerRef.current?.close().catch(() => undefined);
      playerRef.current = null;
      sessionIdRef.current = null;
    };
    // Intentionally run once per mount: one WebSocket per session, kept open for the
    // whole session (no per-turn reconnect). `capture` is a stable controls object.
  }, []);

  // Run the barge-in listener exactly while the assistant is SPEAKING and the mic is
  // not already engaged for the caregiver's own turn. Leaving SPEAKING (or the user
  // grabbing push-to-talk) stops the listener and releases the mic.
  useEffect(() => {
    const shouldListen = assistantState === 'SPEAKING' && !capturing;
    if (shouldListen) {
      void bargeInRef.current.start().catch(() => undefined);
    } else {
      bargeInRef.current.stop();
    }
  }, [assistantState, capturing]);

  return {
    connected,
    assistantState,
    capturing,
    micError,
    pressStart,
    pressEnd,
    toggleCapture,
    unlockAudio,
    interrupt,
    sendText,
    sendCardAction,
    sendOnboardingAnswer,
    confirmOnboarding,
    editOnboarding,
    skipOnboarding,
    backOnboarding,
    pauseOnboarding,
    resumeOnboarding,
    replayOnboarding,
    switchOnboardingLanguage,
  };
}
