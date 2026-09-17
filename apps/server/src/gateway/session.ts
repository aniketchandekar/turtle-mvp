import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  clientMessageSchema,
  serverMessageSchema,
  type AssistantState,
  type ClientMessage,
  type OnboardingPrompt,
  type OnboardingSnapshot,
  type ServerMessage,
  type TurnContract,
} from '@turtle/shared';
import { isRecapCard } from '../orchestrator/recap.js';
import type {
  AsrStream,
  GatewayDeps,
  SessionChannelHandle,
  TtsStream,
} from './index.js';
import { ConversationStateMachine } from './state-machine.js';
import { TurnTimer, consoleLatencySink, type LatencyLogSink } from './latency.js';
import { voiceLog } from './voice-log.js';
import { createOnboardingEngine, OnboardingConflictError, type OnboardingEngine } from '../onboarding/engine.js';

function isSpokenConfirmation(value: string): boolean {
  return /\b(yes|yeah|yep|correct|confirm|confirmed|that'?s right|looks good|all good|finish|done|sí|si|correcto|correcta|confirmo|terminar|listo)\b/i.test(value);
}

/**
 * A single WebSocket session channel (Task 7).
 *
 * One connection per session, kept open for the whole 5–10 minute session (no
 * per-turn reconnect, matching the ElevenLabs guidance). The channel:
 *   - binds the socket to a session (client sends `attach_session` after connect);
 *   - routes the client↔server realtime protocol (design.md §Realtime protocol);
 *   - drives the assistant state and forwards the validated turn contract;
 *   - persists session lifecycle — mode_transitions and flags per turn, and the
 *     end time when the socket closes (R2.7).
 *
 * Downstream ASR (Task 9), TTS (Task 10), and the orchestrator (Tasks 15–22) are
 * reached through the seams in ./index.ts. When those providers are absent the
 * channel degrades honestly (text-in / text-only) and NEVER fabricates provider
 * output.
 */
export class SessionChannel implements SessionChannelHandle {
  sessionId: string | null = null;

  private closed = false;
  private asr: AsrStream | null = null;
  private tts: TtsStream | null = null;
  private ttsLanguage: 'en' | 'es' = 'en';
  /** Resolves the active TTS turn once ElevenLabs emits its final frame. */
  private finishTtsTurn: (() => void) | null = null;
  /** True once a turn is in flight; used to discard partial responses on barge-in. */
  private currentTurnId: string | null = null;
  /**
   * Latency instrumentation for the in-flight turn (Task 13, R16.1/R15.4). Created
   * when the user turn commits and marked as the turn crosses each pipeline stage
   * boundary. Held on the channel so the TTS audio callback can mark the first audio
   * byte. Cleared when the turn finishes or a barge-in discards it.
   */
  private turnTimer: TurnTimer | null = null;
  /**
   * Records the end-of-speech instant for the CURRENT user turn independently of the
   * turn timer. On the ASR path end-of-speech (turn_end) precedes the final
   * transcript that starts turn processing, so we capture it here and seed the timer
   * when the turn actually begins.
   */
  private endOfSpeechAt: number | null = null;
  /** Prevent a missing ASR final from leaving the session in THINKING forever. */
  private asrFinalTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-capture transport counters; reset after every turn_end. */
  private inboundAudioChunks = 0;
  private inboundAudioBytes = 0;
  private inboundAudioStartedAt: number | null = null;
  /**
   * Whether TTS audio frames should be forwarded to the client. Set true when a turn
   * begins speaking and flipped false the instant a barge-in lands (R4.3). The TTS
   * socket is kept open across turns, so the provider may still emit a few buffered
   * frames just after `flush()`; this gate stops those frames from reaching the
   * client so the audible response halts immediately rather than trickling on.
  */
  private forwardingAudio = false;
  /** Ensures first-audio diagnostics emit once per assistant delivery. */
  private forwardedAudioForCurrentDelivery = false;
  /** Persisted onboarding remains active until its server snapshot is complete. */
  private onboarding: { caregiverId: string } | null = null;
  private readonly onboardingEngine: OnboardingEngine;
  private onboardingWarningTimer: ReturnType<typeof setTimeout> | null = null;
  private onboardingCapTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serializes spoken onboarding prompts and prevents overlapping TTS turns. */
  private onboardingSpeech: Promise<void> = Promise.resolve();

  /**
   * The conversation state machine (Task 11, R2.1–R2.5/R2.7). It owns the legal
   * transition graph, announces each entered state via `assistant_state`, records it
   * on the session's mode_transitions, and auto-advances WAITING → LISTENING after a
   * short silence. The channel only asks it to transition; it never mutates state
   * directly.
   */
  private readonly sm: ConversationStateMachine;

  constructor(
    private readonly socket: WebSocket,
    private readonly deps: GatewayDeps,
  ) {
    voiceLog('gateway_socket_connected');
    this.onboardingEngine = createOnboardingEngine({ repos: deps.store.repos });
    this.sm = new ConversationStateMachine({
      // Announce every entered state to the client.
      emit: (state) => this.send({ type: 'assistant_state', state }),
      // Persist every entered state on the bound session (R2.7). Before a session is
      // bound (the initial IDLE), there is nothing to record — the state is still
      // announced so the armed client can render it.
      record: (state) => {
        if (this.sessionId) {
          this.deps.store.repos.session.appendTransition(this.sessionId, state);
        }
      },
      waitingSilenceMs: this.deps.cfg.waitingSilenceMs,
    });

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      // Binary frames are raw PCM audio_chunk frames (never JSON). See messages.ts.
      if (isBinary) {
        this.onAudioChunk(data);
        return;
      }
      this.onControlMessage(data);
    });
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());

    // Armed but not recording (R2.1): announce IDLE and, if any provider is
    // degraded, tell the client honestly so it can switch to text-in / text-only.
    this.setState('IDLE');
    this.announceDegradation();
  }

  /** The current assistant state (SessionChannelHandle). Driven by the state machine. */
  get state(): AssistantState {
    return this.sm.state;
  }

  // ---- Inbound: control messages (client → server) ----

  private onControlMessage(data: Buffer): void {
    let json: unknown;
    try {
      json = JSON.parse(data.toString('utf8'));
    } catch {
      voiceLog('client_control_rejected', {
        session_id: this.sessionId,
        reason: 'invalid_json',
        payload_bytes: data.byteLength,
      }, 'warn');
      this.sendError('bad_json', 'Message was not valid JSON.');
      return;
    }

    const parsed = clientMessageSchema.safeParse(json);
    if (!parsed.success) {
      voiceLog('client_control_rejected', {
        session_id: this.sessionId,
        reason: 'schema_validation',
      }, 'warn');
      this.sendError('bad_message', 'Message did not match the client protocol.');
      return;
    }

    const msg = parsed.data;
    voiceLog('client_control_received', {
      session_id: this.sessionId,
      type: msg.type,
    });
    switch (msg.type) {
      case 'attach_session':
        this.attachSession(msg.session_id);
        return;
      case 'text_input':
        this.onTextInput(msg.text);
        return;
      case 'onboarding_answer':
        this.send({ type: 'transcript_final', text: msg.value });
        void this.processOnboardingAnswer(msg.value, msg.prompt_id, msg.capture_method);
        return;
      case 'onboarding_section_confirm':
        void this.processOnboardingControl(() =>
          this.onboardingEngine.confirmSection(this.requireOnboardingCaregiver(), msg.prompt_id));
        return;
      case 'onboarding_edit':
        void this.processOnboardingControl(() =>
          this.onboardingEngine.edit(this.requireOnboardingCaregiver(), msg.prompt_id, msg.step_id));
        return;
      case 'onboarding_skip':
        void this.processOnboardingControl(() =>
          this.onboardingEngine.skip(this.requireOnboardingCaregiver(), msg.prompt_id));
        return;
      case 'onboarding_back':
        void this.processOnboardingControl(() =>
          this.onboardingEngine.back(this.requireOnboardingCaregiver(), msg.prompt_id));
        return;
      case 'onboarding_pause':
        void this.processOnboardingControl(() =>
          this.onboardingEngine.pause(this.requireOnboardingCaregiver(), msg.prompt_id));
        return;
      case 'onboarding_resume': {
        if (!this.onboarding) return;
        const resumed = this.onboardingEngine.resume(this.onboarding.caregiverId);
        this.scheduleOnboardingCap(this.onboarding.caregiverId);
        this.sendOnboardingSnapshot(resumed);
        if (resumed.prompt) this.queueOnboardingPrompt(resumed.prompt);
        return;
      }
      case 'onboarding_replay': {
        if (!this.onboarding) return;
        const active = this.onboardingEngine.getSnapshot(this.onboarding.caregiverId).prompt;
        if (!active || active.id !== msg.prompt_id) {
          this.sendError('stale_onboarding_prompt', 'This onboarding prompt is no longer active.');
          return;
        }
        // The first copy may have been generated while browser audio was locked.
        // Stop it and synthesize a fresh ElevenLabs turn after the user's gesture.
        if (this.state === 'SPEAKING' || this.state === 'THINKING') this.onInterrupt();
        this.queueOnboardingPrompt(active);
        return;
      }
      case 'onboarding_language':
        void this.processOnboardingControl(() =>
          this.onboardingEngine.switchLanguage(this.requireOnboardingCaregiver(), msg.prompt_id, msg.locale));
        return;
      case 'turn_end':
        this.onTurnEnd();
        return;
      case 'interrupt':
        this.onInterrupt();
        return;
      case 'card_action':
        this.onCardAction(msg);
        return;
      default:
        // Exhaustive: discriminated union above.
        return;
    }
  }

  /** Bind this socket to an existing session (created via POST /sessions). */
  private attachSession(sessionId: string): void {
    const session = this.deps.store.repos.session.get(sessionId);
    if (!session) {
      this.sendError('unknown_session', 'No such session. Create one via POST /sessions first.');
      return;
    }
    if (session.ended_at) {
      this.sendError('session_ended', 'That session has already ended.');
      return;
    }
    this.sessionId = sessionId;
    voiceLog('session_attached', {
      session_id: sessionId,
    });
    // A fresh, armed session sits in LISTENING once bound (push-to-talk gates capture
    // client-side; the server does not record in the background — R3.1/R16.5).
    this.setState('LISTENING');
    // Open the per-session provider streams once, kept open for the whole session
    // (no per-turn reconnect — matches the ElevenLabs guidance).
    this.openAsrIfLive();
    this.openTtsIfLive();

    const snapshot = this.onboardingEngine.resume(session.caregiver_id);
    // This is the client's routing handshake. Send it for every profile state so
    // the UI never has to guess whether it should show onboarding or the regular
    // assistant while the socket is attaching.
    this.sendOnboardingSnapshot(snapshot);
    if (snapshot.status !== 'completed') {
      this.onboarding = { caregiverId: session.caregiver_id };
      this.scheduleOnboardingCap(session.caregiver_id);
      voiceLog('onboarding_started', { session_id: sessionId, step: snapshot.currentStep });
      if (snapshot.prompt) this.queueOnboardingPrompt(snapshot.prompt);
    }
  }

  /** Binary PCM audio arriving while push-to-talk is engaged (R3.2). */
  private onAudioChunk(chunk: Buffer): void {
    if (!this.requireSession()) return;
    this.inboundAudioChunks += 1;
    this.inboundAudioBytes += chunk.byteLength;
    if (this.inboundAudioChunks === 1) {
      this.inboundAudioStartedAt = this.clock()();
      voiceLog('gateway_audio_received', {
        session_id: this.sessionId,
        first_chunk_bytes: chunk.byteLength,
        asr_available: Boolean(this.asr),
      });
    }
    // Re-open after a transient provider disconnect. The new stream buffers this
    // first chunk until its upstream socket is ready, so the retry loses no leading audio.
    if (!this.asr) this.openAsrIfLive();
    if (this.asr) {
      this.asr.pushAudio(chunk);
    }
    // When ASR is degraded there is no recognizer; the client uses text_input
    // instead. We intentionally drop audio here rather than buffer it — no
    // background recording, and no fabricated transcript.
  }

  /** End-of-speech for the current user turn (R2.3). */
  private onTurnEnd(): void {
    if (!this.requireSession()) return;
    voiceLog('gateway_turn_end', {
      session_id: this.sessionId,
      audio_chunks: this.inboundAudioChunks,
      audio_bytes: this.inboundAudioBytes,
      capture_duration_ms: this.inboundAudioStartedAt === null
        ? null
        : Math.round(this.clock()() - this.inboundAudioStartedAt),
      asr_available: Boolean(this.asr),
      state: this.state,
    }, this.inboundAudioChunks === 0 ? 'warn' : 'info');
    this.inboundAudioChunks = 0;
    this.inboundAudioBytes = 0;
    this.inboundAudioStartedAt = null;
    // Mark the end-of-speech instant now (button release / endpointing). The final
    // transcript arrives later via onFinal, which starts turn processing (R16.1).
    this.endOfSpeechAt = this.clock()();
    if (this.asr) {
      // Deepgram VAD/endpointing (Task 9) will emit the final transcript via
      // onFinal, which drives the orchestrator handoff.
      this.asr.endTurn();
      this.setState('THINKING');
      this.clearAsrFinalTimer();
      this.asrFinalTimer = setTimeout(() => {
        this.asrFinalTimer = null;
        this.endOfSpeechAt = null;
        if (this.state === 'THINKING') this.setState('LISTENING');
        voiceLog('asr_final_timeout', {
          session_id: this.sessionId,
          timeout_ms: 8_000,
        }, 'warn');
        this.sendError(
          'asr_timeout',
          "I couldn't hear an answer. Please try speaking again, or type it below.",
        );
      }, 8_000);
      this.asrFinalTimer.unref?.();
    }
    // With no ASR, turn_end is a no-op: the committed turn arrives via text_input.
  }

  /** Text-in fallback when ASR is unavailable (R3.6). Also the committed user turn. */
  private onTextInput(text: string): void {
    if (!this.requireSession()) return;
    this.clearAsrFinalTimer();
    voiceLog('text_turn_received', {
      session_id: this.sessionId,
      characters: text.length,
      onboarding: Boolean(this.onboarding),
    });
    // On the text-in path end-of-speech coincides with the committed text; there is
    // no recognizer span. Mark it now so the timer's ASR stage is ~0 (R16.1).
    this.endOfSpeechAt = this.clock()();
    // Echo the committed user text back as a final transcript so the client renders
    // it identically to the voice path.
    this.send({ type: 'transcript_final', text });
    void this.processUserTurn(text, null, 'text');
  }

  // ---- First-run onboarding -------------------------------------------------

  /** Route both typed and transcribed answers through the same persisted engine. */
  private async processOnboardingAnswer(
    value: string,
    promptId?: string,
    captureMethod: 'voice' | 'typed' = 'voice',
  ): Promise<void> {
    if (!this.sessionId || !this.onboarding) return;
    const answer = value.trim().replace(/\s+/g, ' ');
    if (!answer) return;
    const activePrompt = this.onboardingEngine.getSnapshot(this.onboarding.caregiverId).prompt;
    const boundPromptId = promptId ?? activePrompt?.id;
    if (!boundPromptId) return;
    voiceLog('onboarding_answer_received', {
      session_id: this.sessionId,
      step: activePrompt?.stepId,
      characters: answer.length,
    });
    // Review and wrap-up steps stay voice-first too. A spoken confirmation follows
    // the same audited mutation as the visible confirmation button; ambiguous speech
    // leaves the profile untouched and repeats the active prompt.
    if (activePrompt && (activePrompt.kind === 'review' || activePrompt.kind === 'info')) {
      if (isSpokenConfirmation(answer)) {
        await this.processOnboardingControl(() =>
          this.onboardingEngine.confirmSection(this.requireOnboardingCaregiver(), boundPromptId));
      } else {
        this.sendError('onboarding_confirmation_needed', 'Say yes to confirm, or choose a field to edit.');
        this.queueOnboardingPrompt(activePrompt);
      }
      return;
    }
    await this.processOnboardingControl(() =>
      this.onboardingEngine.answer(this.requireOnboardingCaregiver(), boundPromptId, answer, captureMethod));
  }

  private requireOnboardingCaregiver(): string {
    if (!this.onboarding) throw new OnboardingConflictError('Onboarding is not active.');
    return this.onboarding.caregiverId;
  }

  private async processOnboardingControl(
    mutate: () => { snapshot: OnboardingSnapshot; safetyMessage?: string; safetyFlag?: 'crisis' | 'medical_refusal' },
  ): Promise<void> {
    if (!this.sessionId || !this.onboarding) return;
    if (this.state === 'SPEAKING') this.onInterrupt();
    if (this.state === 'WAITING') this.setState('LISTENING');
    this.setState('THINKING');
    try {
      const previousLocale = this.onboardingEngine.getSnapshot(this.onboarding.caregiverId).locale;
      const result = mutate();
      if (result.snapshot.locale !== previousLocale) {
        // Language changes are applied only after the active turn has been interrupted,
        // so ElevenLabs reconnects cleanly at a turn boundary.
        this.tts?.close();
        this.tts = null;
        this.openTtsIfLive(result.snapshot.locale);
      }
      this.sendOnboardingSnapshot(result.snapshot);
      if (result.safetyMessage) {
        await this.deliver({
          session_id: this.sessionId,
          turn_id: crypto.randomUUID(),
          state: 'WAITING',
          say: result.safetyMessage,
          cards: [],
          memory_ops: [],
          flags: [result.safetyFlag ?? 'medical_refusal'],
        });
      }
      if (result.snapshot.status === 'completed') {
        this.onboarding = null;
        this.clearOnboardingTimers();
        voiceLog('onboarding_completed', { session_id: this.sessionId });
      }
      if (result.snapshot.prompt) this.queueOnboardingPrompt(result.snapshot.prompt);
      else if (result.snapshot.status === 'paused') {
        this.clearOnboardingTimers();
        await this.deliver({
          session_id: this.sessionId,
          turn_id: crypto.randomUUID(),
          state: 'WAITING',
          say: result.snapshot.locale === 'es'
            ? 'He guardado su lugar. Puede volver cuando esté listo.'
            : "I've saved your exact place. Come back whenever you're ready.",
          cards: [], memory_ops: [], flags: ['none'],
        });
      } else if (result.snapshot.status === 'declined') {
        await this.deliver({
          session_id: this.sessionId,
          turn_id: crypto.randomUUID(),
          state: 'WAITING',
          say: result.snapshot.locale === 'es'
            ? 'Entiendo. No guardaré más información y las conversaciones regulares seguirán bloqueadas.'
            : "I understand. I won't collect more information, and regular conversations will remain locked.",
          cards: [], memory_ops: [], flags: ['none'],
        });
      }
    } catch (error) {
      if (error instanceof OnboardingConflictError) {
        this.sendError('stale_onboarding_prompt', error.message);
        if (!this.onboarding) return;
        const snapshot = this.onboardingEngine.getSnapshot(this.onboarding.caregiverId);
        this.sendOnboardingSnapshot(snapshot);
        if (snapshot.prompt) this.queueOnboardingPrompt(snapshot.prompt);
        return;
      }
      throw error;
    }
  }

  private sendOnboardingSnapshot(snapshot: OnboardingSnapshot): void {
    this.send({ type: 'onboarding_snapshot', snapshot });
  }

  private scheduleOnboardingCap(caregiverId: string): void {
    this.clearOnboardingTimers();
    this.onboardingWarningTimer = setTimeout(() => {
      if (!this.onboarding || this.onboarding.caregiverId !== caregiverId) return;
      this.sendOnboardingSnapshot(this.onboardingEngine.tick(caregiverId).snapshot);
    }, 13 * 60_000 + 1_000);
    this.onboardingCapTimer = setTimeout(() => {
      if (!this.onboarding || this.onboarding.caregiverId !== caregiverId) return;
      void this.processOnboardingControl(() => this.onboardingEngine.tick(caregiverId));
    }, 15 * 60_000 + 1_000);
    this.onboardingWarningTimer.unref?.();
    this.onboardingCapTimer.unref?.();
  }

  private clearOnboardingTimers(): void {
    if (this.onboardingWarningTimer) clearTimeout(this.onboardingWarningTimer);
    if (this.onboardingCapTimer) clearTimeout(this.onboardingCapTimer);
    this.onboardingWarningTimer = null;
    this.onboardingCapTimer = null;
  }

  /** Send the single active card now, then speak the same prompt through Turtle. */
  private queueOnboardingPrompt(prompt: OnboardingPrompt): void {
    voiceLog('onboarding_prompt_queued', {
      session_id: this.sessionId,
      step: prompt.stepId,
      confirmation: prompt.kind === 'review',
      complete: Boolean(prompt.complete),
      question_characters: prompt.question.length,
    });
    this.send({ type: 'onboarding_prompt', prompt });
    const sessionId = this.sessionId;
    if (!sessionId) return;
    const contract: TurnContract = {
      session_id: sessionId,
      turn_id: crypto.randomUUID(),
      state: 'WAITING',
      say: prompt.question,
      cards: [],
      memory_ops: [],
      flags: ['none'],
    };
    this.onboardingSpeech = this.onboardingSpeech
      .catch(() => undefined)
      .then(async () => {
        if (this.closed) return;
        if (!prompt.complete) {
          if (!this.onboarding) return;
          const active = this.onboardingEngine.getSnapshot(this.onboarding.caregiverId).prompt;
          if (active?.id !== prompt.id) return;
        }
        // The initial greeting begins from LISTENING; later queued prompts normally
        // begin from WAITING once the previous utterance has finished.
        if (this.state === 'WAITING') this.setState('LISTENING');
        if (this.state === 'LISTENING') this.setState('THINKING');
        await this.deliverOnboarding(contract);
      });
  }

  /**
   * Onboarding prompts are complete strings rather than incrementally generated LLM
   * text. Use ElevenLabs' HTTP streaming path for them so PCM is emitted without the
   * buffering and close lifecycle of a stream-input WebSocket.
   */
  private async deliverOnboarding(contract: TurnContract): Promise<void> {
    const render = this.deps.tts?.renderStatic;
    if (!render || !this.deps.tts?.live) {
      await this.deliver(contract);
      return;
    }

    this.setState('SPEAKING');
    this.forwardingAudio = true;
    this.forwardedAudioForCurrentDelivery = false;
    const emittedAudio = await render(contract.say, (chunk) => {
      if (!this.forwardingAudio || chunk.byteLength === 0) return;
      if (!this.forwardedAudioForCurrentDelivery) {
        this.forwardedAudioForCurrentDelivery = true;
        voiceLog('tts_first_audio_forwarded', {
          session_id: this.sessionId,
          chunk_bytes: chunk.byteLength,
          path: 'onboarding_http_stream',
        });
      }
      this.sendBinary(chunk);
    });

    // A replay or barge-in invalidates the older HTTP render while it winds down.
    if (!this.forwardingAudio) return;
    if (!emittedAudio) {
      this.sendError(
        'onboarding_tts_unavailable',
        'ElevenLabs audio is unavailable. Turtle will use your device voice if supported.',
        true,
      );
    }
    this.send({ type: 'turn_contract', contract });
    this.forwardingAudio = false;
    if (contract.state === 'CLOSING') this.setState('CLOSING');
    else this.setState('WAITING');
  }

  /**
   * Barge-in during playback (R4.3/R4.4/R16.3).
   *
   * Everything here is synchronous so the audible halt and state transition complete
   * in well under the 300ms budget — there is no network round-trip on the halt path:
   *   1. Stop forwarding TTS audio to the client immediately (any frames the provider
   *      buffers past `flush()` are dropped, so playback stops now, not eventually).
   *   2. Flush the TTS buffer so the synthesizer stops generating this turn's audio
   *      (the socket stays open across turns per the frozen preset).
   *   3. Discard the partial response: clearing `currentTurnId` makes the in-flight
   *      orchestrator turn a no-op when it resolves (see processUserTurn's guard), so
   *      no stale contract, cards, or audio land after the interruption.
   *   4. Return to LISTENING and treat the new speech as the next turn. The
   *      interruption is NEVER penalized or scolded (R4.4) — no flag, no apology.
   */
  private onInterrupt(): void {
    if (!this.requireSession()) return;
    voiceLog('voice_turn_interrupted', {
      session_id: this.sessionId,
      state: this.state,
    });
    this.clearAsrFinalTimer();
    this.forwardingAudio = false;
    const tts = this.tts;
    this.tts = null;
    tts?.flush();
    // Flushes intentionally do not produce ElevenLabs' final-frame event, so release
    // a deliver() that is awaiting it. The closed audio gate prevents the abandoned
    // contract from being forwarded.
    this.finishTtsTurn?.();
    this.currentTurnId = null;
    // An interruption is not a latency sample: drop the in-flight turn's timer and
    // any pending end-of-speech mark so they don't contaminate the next turn.
    this.turnTimer = null;
    this.endOfSpeechAt = null;
    this.setState('LISTENING');
  }

  /**
   * Tap parity for a card action (R16.8). The voice path flows through a normal
   * turn; a tap arrives here. Task 23 (card service) owns the real lifecycle — for
   * now we persist the obvious status transitions so the artifact stays consistent.
   */
  private onCardAction(msg: Extract<ClientMessage, { type: 'card_action' }>): void {
    if (!this.requireSession()) return;
    const { repos } = this.deps.store;
    const card = repos.card.get(msg.card_id);
    if (!card) {
      this.sendError('unknown_card', 'No such card.');
      return;
    }
    if (msg.kind === 'acknowledge') {
      repos.card.setStatus(card.id, 'dismissed');
    } else if (msg.kind === 'call' || msg.kind === 'link' || msg.kind === 'share') {
      repos.card.setStatus(card.id, 'done');
    }
  }

  // ---- Turn processing (orchestrator handoff) ----

  /**
   * Hand committed user text to the orchestrator, persist the turn + any cards,
   * apply session lifecycle side effects, then speak + forward the contract.
   */
  private async processUserTurn(
    userText: string,
    asrConf: number | null,
    inputSource: 'text' | 'asr',
  ): Promise<void> {
    if (!this.sessionId) return;
    voiceLog('user_turn_processing_started', {
      session_id: this.sessionId,
      source: inputSource,
      characters: userText.length,
      asr_confidence: asrConf,
      onboarding: Boolean(this.onboarding),
    });
    if (this.onboarding) {
      const snapshot = this.onboardingEngine.getSnapshot(this.onboarding.caregiverId);
      if (snapshot.status === 'completed') {
        this.onboarding = null;
      } else {
        await this.processOnboardingAnswer(userText, snapshot.prompt?.id, inputSource === 'asr' ? 'voice' : 'typed');
        return;
      }
    }
    const sessionId = this.sessionId;
    const turnId = crypto.randomUUID();
    this.currentTurnId = turnId;

    // Start per-turn latency instrumentation (R16.1/R15.4). Seed end-of-speech from
    // the boundary captured on turn_end / text_input; if it is missing (a turn that
    // never passed through those paths) fall back to now so the timer is consistent.
    const timer = new TurnTimer(this.clock());
    this.turnTimer = timer;
    timer.markEndOfSpeech(this.endOfSpeechAt ?? undefined);
    // The final transcript is in hand now (this method runs on the committed text),
    // closing the ASR stage. On the text-in path this equals end-of-speech (~0ms).
    timer.markAsrFinal();
    this.endOfSpeechAt = null;

    this.setState('THINKING');

    const { repos } = this.deps.store;

    // Persist the user turn.
    repos.turn.create({
      session_id: sessionId,
      seq: repos.turn.nextSeq(sessionId),
      speaker: 'user',
      text: userText,
      asr_conf: asrConf,
      retrieved_chunk_ids: [],
      flag: null,
      latency_ms: null,
    });

    let contract: TurnContract;
    timer.markOrchestratorStart();
    try {
      contract = await this.processor().handleTurn({ sessionId, turnId, userText });
    } catch {
      contract = fallbackContract(sessionId, turnId);
    }
    // The orchestrator (classifier → mode router → LLM → contract validation) is
    // done; the contract is in hand. Finer classify/LLM marks are reported by an
    // instrumented orchestrator later — until then this span is the LLM stage.
    timer.markOrchestratorDone();

    // Barge-in may have landed while the orchestrator was thinking — discard the
    // partial response and its timer (the interruption is not a latency sample).
    if (this.closed || this.currentTurnId !== turnId) {
      if (this.turnTimer === timer) this.turnTimer = null;
      return;
    }

    this.applyContractSideEffects(contract, sessionId, turnId);
    const delivery = await this.deliver(contract);

    // An interrupt can land while TTS is streaming. In that case deliver() returns
    // false so the abandoned turn never sends a stale contract or settles over the
    // newer LISTENING state.
    if (!delivery.delivered || this.closed || this.currentTurnId !== turnId) {
      if (this.turnTimer === timer) this.turnTimer = null;
      return;
    }

    // Record the finished breakdown: persist the headline figure on the assistant
    // turn and emit the structured per-turn log (R15.4).
    this.recordTurnLatency(timer, contract, sessionId, turnId, !delivery.usedTts);

    this.currentTurnId = null;
    if (this.turnTimer === timer) this.turnTimer = null;
  }

  /**
   * Persist the assistant turn, cards, memory ops, mode transitions, and flags
   * from the validated contract (R2.7, R6.5). Cards and flags flow ONLY from the
   * contract — never inferred here.
   */
  private applyContractSideEffects(
    contract: TurnContract,
    sessionId: string,
    turnId: string,
  ): void {
    const { repos } = this.deps.store;

    const flag = contract.flags.find((f) => f !== 'none') ?? null;

    // Assistant turn.
    repos.turn.create({
      id: turnId,
      session_id: sessionId,
      seq: repos.turn.nextSeq(sessionId),
      speaker: 'assistant',
      text: contract.say,
      asr_conf: null,
      retrieved_chunk_ids: [],
      flag,
      latency_ms: null,
    });

    // Session flags for owner review (R5.5): record any non-`none` flag.
    for (const f of contract.flags) {
      if (f !== 'none') repos.session.addFlag(sessionId, f);
    }

    // Cards are created only from the contract (R10.1). Persist them so the archive
    // and REST plane see the same rows the voice path wrote, and stamp the persisted
    // id back onto the contract card so the forwarded turn_contract carries an id the
    // client can reference in a `card_action` tap (voice parity, R16.8).
    //
    // On a CLOSING turn the recap composer (Task 32) emits a recap card; we capture its
    // persisted id here so `close()` can wire it to `session.recap_card_id`, persisting
    // the recap as the session's long-term artifact (R14.3).
    let recapCardId: string | undefined;
    for (const card of contract.cards) {
      const record = repos.card.create({
        session_id: sessionId,
        type: card.type,
        title: card.title,
        body: card.body,
        action: card.action ?? null,
      });
      card.id = record.id;
      if (contract.state === 'CLOSING' && isRecapCard(card)) recapCardId = record.id;
    }

    // Memory ops (R6.5). Resolve the session's own patient once, so dictated log
    // entries and appointments become part of the next natural conversation rather
    // than only appearing as a transient card.
    const caregiverId = repos.session.get(sessionId)?.caregiver_id;
    const patient = caregiverId ? repos.patient.getByCaregiver(caregiverId) : null;
    for (const op of contract.memory_ops) {
      if (op.op === 'set_fact') {
        repos.session.appendTransition(sessionId, `fact:${op.key}=${op.value}`);
      }
      if (op.op === 'append_log' && patient) {
        repos.logEntry.create({
          patient_id: patient.id,
          category: op.category,
          text: op.text,
          at: op.at ?? new Date().toISOString(),
          structured: null,
        });
      }
      if (op.op === 'add_appointment' && patient) {
        repos.appointment.create({
          patient_id: patient.id,
          title: op.title,
          at: op.at,
          with_whom: op.with_whom ?? null,
          purpose: op.purpose ?? null,
        });
      }
    }

    // If the contract closes the session, record the end time and wire the recap card
    // as the session's long-term artifact when one was emitted (R2.6/R7.5/R14.3).
    if (contract.state === 'CLOSING') {
      repos.session.close(sessionId, recapCardId);
    }
  }

  /**
   * Speak the contract's `say` (TTS when live, else text-only), then forward the
   * turn contract and settle the final state.
   */
  private async deliver(contract: TurnContract): Promise<{ delivered: boolean; usedTts: boolean }> {
    voiceLog('assistant_delivery_started', {
      session_id: this.sessionId,
      turn_id: contract.turn_id,
      say_characters: contract.say.length,
      cards: contract.cards.length,
      tts_available: Boolean(this.tts),
    });
    // SPEAKING while audio streams (R2.4). Text-only mode still transits SPEAKING so
    // the client renders the transcript consistently.
    this.setState('SPEAKING');
    let usedTts = false;

    // ElevenLabs closes each stream after the end-of-sequence frame, so prepare a
    // fresh synthesizer for the next response when necessary.
    if (!this.tts) this.openTtsIfLive();
    if (this.tts) {
      usedTts = true;
      // Open the audio gate for this turn; a barge-in closes it again (onInterrupt).
      this.forwardingAudio = true;
      this.forwardedAudioForCurrentDelivery = false;
      await this.speakViaTts(contract.say);
      // A barge-in settles the pending TTS promise but must not allow this abandoned
      // response's text, card, or state transition to reach the client.
      if (!this.forwardingAudio) return { delivered: false, usedTts };
    }
    // else: text-only degradation — the `say` text is delivered via turn_contract
    // and rendered in the transcript (R4.5). No audio frames are sent.

    // Forward the validated contract; the client renders cards after the
    // corresponding utterance finishes (R10.3).
    this.send({ type: 'turn_contract', contract });
    voiceLog('assistant_contract_sent', {
      session_id: this.sessionId,
      turn_id: contract.turn_id,
      used_tts: usedTts,
    });

    // This turn's audio is complete; close the gate so nothing from it forwards into
    // the next turn (a fresh turn reopens it in deliver()).
    this.forwardingAudio = false;

    // Settle to the contract's terminal state. CLOSING stays CLOSING; everything
    // else lands in WAITING. The state machine then returns to LISTENING on its own
    // after a short silence (R2.5) — the channel does not force that step here.
    if (contract.state === 'CLOSING') {
      this.setState('CLOSING');
    } else {
      this.setState('WAITING');
    }
    return { delivered: true, usedTts };
  }

  private speakViaTts(say: string): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.tts) return resolve();
      // Keep the audio gate open until the provider's final frame. Resolving here
      // used to close `forwardingAudio` before ElevenLabs had emitted its first
      // asynchronous audio chunk, silently dropping all spoken output.
      this.finishTtsTurn = () => {
        this.finishTtsTurn = null;
        resolve();
      };
      try {
        this.tts.speak(say);
      } catch {
        // A provider failure degrades this turn to text rather than leaving the
        // session stuck in SPEAKING.
        this.finishTtsTurn();
      }
    });
  }

  // ---- Provider seams ----

  private openAsrIfLive(): void {
    const provider = this.deps.asr;
    if (!provider || !provider.live || this.asr) return;
    let stream: AsrStream | null = null;
    voiceLog('session_asr_open_requested', { session_id: this.sessionId });
    stream = provider.open({
      onReady: () => {
        voiceLog('session_asr_ready', { session_id: this.sessionId });
      },
      onInterim: (text) => this.send({ type: 'transcript_interim', text }),
      onFinal: (text, confidence) => {
        this.clearAsrFinalTimer();
        voiceLog('session_asr_final_received', {
          session_id: this.sessionId,
          characters: text.length,
          confidence,
        });
        this.send({ type: 'transcript_final', text });
        void this.processUserTurn(text, confidence, 'asr');
      },
      onUnavailable: (message) => {
        if (this.asr === stream) this.asr = null;
        this.clearAsrFinalTimer();
        this.endOfSpeechAt = null;
        if (this.state === 'THINKING') this.setState('LISTENING');
        voiceLog('session_asr_unavailable', {
          session_id: this.sessionId,
          state: this.state,
        }, 'warn');
        this.sendError('asr_unavailable', `${message} Please try again or type your answer.`, true);
      },
    });
    this.asr = stream;
    if (!stream) {
      voiceLog('session_asr_open_returned_null', { session_id: this.sessionId }, 'warn');
    }
  }

  private openTtsIfLive(language: 'en' | 'es' = this.ttsLanguage): void {
    const provider = this.deps.tts;
    if (!provider || !provider.live || this.tts) return;
    this.ttsLanguage = language;
    this.tts = provider.open({
      // Forward audio only while this turn is still live. A barge-in flips
      // `forwardingAudio` off (see onInterrupt), so any frames the provider emits
      // just after flush() are dropped instead of trickling to the client (R4.3).
      onAudioChunk: (chunk) => {
        if (this.forwardingAudio) {
          // The first forwarded frame is the R16.1 headline boundary
          // (end-of-speech → first audio byte). Only the first mark counts.
          this.turnTimer?.markFirstAudioByte();
          if (!this.forwardedAudioForCurrentDelivery) {
            this.forwardedAudioForCurrentDelivery = true;
            voiceLog('tts_first_audio_forwarded', {
              session_id: this.sessionId,
              chunk_bytes: chunk.byteLength,
            });
          }
          this.sendBinary(chunk);
        }
      },
      onTurnDone: () => {
        this.finishTtsTurn?.();
        this.tts = null;
      },
    }, language);
  }

  private processor(): NonNullable<GatewayDeps['processor']> {
    return this.deps.processor ?? cannedProcessor;
  }

  /** The injectable clock for latency marks (defaults to performance.now()). */
  private clock(): NonNullable<GatewayDeps['clock']> {
    return this.deps.clock ?? (() => performance.now());
  }

  /** The structured per-turn log sink (defaults to the JSON console sink). */
  private latencySink(): LatencyLogSink {
    return this.deps.latencySink ?? consoleLatencySink;
  }

  /**
   * Persist the turn's headline latency and emit the structured per-turn log
   * (R16.1/R15.4). The headline figure (end-of-speech → first audio byte) is written
   * to the assistant turn's `latency_ms`; text-only turns have no audio byte, so it
   * is null there. The log carries the full stage breakdown plus the turn's flags,
   * mode transitions, and card count for observability (Task 36 consumes it).
   */
  private recordTurnLatency(
    timer: TurnTimer,
    contract: TurnContract,
    sessionId: string,
    turnId: string,
    textOnly: boolean,
  ): void {
    const breakdown = timer.breakdown();
    const { repos } = this.deps.store;

    // Persist the headline figure on the assistant turn (rounded to whole ms).
    if (breakdown.endToFirstAudioMs !== null) {
      repos.turn.setLatency(turnId, Math.round(breakdown.endToFirstAudioMs));
    }

    // The mode transitions recorded for THIS turn are the tail appended since the
    // turn began; the session accumulates them, so we read the current list. The
    // orchestrator records the routed mode (Task 18); until then this may be empty.
    const session = repos.session.get(sessionId);
    const modeTransitions = session?.mode_transitions ?? [];

    const flags = contract.flags.filter((f) => f !== 'none');

    this.latencySink()({
      sessionId,
      turnId,
      breakdown,
      flags,
      modeTransitions,
      cardsEmitted: contract.cards.length,
      textOnly,
    });
  }

  // ---- Outbound helpers (server → client) ----

  /**
   * Request an assistant-state transition through the state machine. Illegal
   * transitions are rejected by the machine (they never mutate state or reach the
   * client); the channel treats the request as a no-op in that case.
   */
  private setState(state: AssistantState): void {
    const previous = this.state;
    const accepted = this.sm.transition(state);
    voiceLog('assistant_state_transition', {
      session_id: this.sessionId,
      from: previous,
      to: state,
      accepted,
    }, accepted ? 'info' : 'warn');
  }

  private send(msg: ServerMessage): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    // Validate outbound messages against the protocol so we never ship a malformed
    // frame (the turn_contract is already Zod-validated upstream).
    const parsed = serverMessageSchema.safeParse(msg);
    if (!parsed.success) return;
    this.socket.send(JSON.stringify(msg));
  }

  private sendBinary(chunk: Buffer): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(chunk, { binary: true });
  }

  private sendError(code: string, message: string, degraded = false): void {
    voiceLog('gateway_error_sent', {
      session_id: this.sessionId,
      code,
      degraded,
    }, 'warn');
    this.send({ type: 'error', code, message, degraded });
  }

  /** Tell the client which capabilities are degraded so it can adapt (R1.2/R16.4). */
  private announceDegradation(): void {
    const caps = this.deps.cfg.capabilities;
    if (!caps.asr.live) this.sendError('asr_degraded', caps.asr.fallback, true);
    if (!caps.tts.live) this.sendError('tts_degraded', caps.tts.fallback, true);
  }

  private clearAsrFinalTimer(): void {
    if (this.asrFinalTimer === null) return;
    clearTimeout(this.asrFinalTimer);
    this.asrFinalTimer = null;
  }

  private requireSession(): boolean {
    if (this.sessionId) return true;
    this.sendError('no_session', 'Send attach_session before other messages.');
    return false;
  }

  // ---- Lifecycle ----

  close(): void {
    if (this.closed) return;
    voiceLog('gateway_socket_closing', {
      session_id: this.sessionId,
      state: this.state,
    });
    this.closed = true;
    this.clearOnboardingTimers();
    this.clearAsrFinalTimer();
    // Stop the state machine's short-silence timer so it can't fire after close.
    this.sm.dispose();
    // Release provider resources.
    try {
      this.asr?.close();
    } catch {
      /* ignore */
    }
    try {
      this.tts?.close();
    } catch {
      /* ignore */
    }
    // Persist the session end time if it wasn't already closed by a CLOSING turn (R2.7).
    if (this.sessionId) {
      const session = this.deps.store.repos.session.get(this.sessionId);
      if (session && !session.ended_at) {
        this.deps.store.repos.session.close(this.sessionId);
      }
    }
    try {
      if (this.socket.readyState === this.socket.OPEN) this.socket.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Canned turn processor used until the real orchestrator (Tasks 15–22) is wired.
 * It echoes a warm, honest acknowledgement so the channel is exercisable with zero
 * keys. It emits NO cards, NO memory ops, and only the `none` flag — it must never
 * fabricate safety or artifact behavior. That behavior is contract-driven and lands
 * with the orchestrator.
 */
export const cannedProcessor: NonNullable<GatewayDeps['processor']> = {
  async handleTurn({ sessionId, turnId }) {
    return {
      session_id: sessionId,
      turn_id: turnId,
      state: 'WAITING',
      say: "I'm here with you. (The full conversation engine isn't wired up yet.)",
      cards: [],
      memory_ops: [],
      flags: ['none'],
    };
  },
};

function fallbackContract(sessionId: string, turnId: string): TurnContract {
  return {
    session_id: sessionId,
    turn_id: turnId,
    state: 'WAITING',
    say: "I'm having a little trouble right now. Let's try that again in a moment.",
    cards: [],
    memory_ops: [],
    flags: ['none'],
  };
}

/** Turtle's current MVP knowledge base is scoped to the metastatic cancer journey. */
export function isSupportedDiagnosis(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return (
    normalized.includes('metastatic') ||
    normalized.includes('cancer') ||
    normalized.includes('stage 4') ||
    normalized.includes('stage iv') ||
    normalized.includes('terminal')
  );
}

/** Clean punctuation and surrounding whitespace/quotes from spoken transcripts. */
export function cleanPunctuation(text: string): string {
  return text
    .replace(/^["'“”‘’.,!?;:\s]+|["'“”‘’.,!?;:\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract the care recipient's name from natural conversational speech.
 * Handles patterns like "My mom, Sarah", "I'm caring for Sarah", "Her name is Eleanor",
 * "My husband John", "It's Sarah", "My mom", etc.
 */
export function extractCareRecipientName(text: string): string {
  const cleaned = cleanPunctuation(text);
  if (!cleaned) return '';

  // Handle compound phrases like: "My name is Alex and I'm caring for (my mom,) Sarah"
  const compoundMatch = cleaned.match(
    /(?:i'm|i am|my name is)\s+([a-zA-Z'-]+)\s+(?:and|&)\s+(?:i'm|i am|currently)?\s*(?:caring for|taking care of|looking after)\s+(?:my\s+)?(?:mother|mom|father|dad|husband|wife|spouse|partner|son|daughter|sister|brother|friend|parent|child|grandma|grandmother|grandpa|grandfather)?\s*,?\s*([a-zA-Z0-9\s'-]+)$/i,
  );
  if (compoundMatch && compoundMatch[2]) {
    const candidate = cleanPunctuation(compoundMatch[2]);
    if (candidate) return candidate;
  }

  // Handle intro phrases: "I am caring for...", "I'm taking care of...", "Taking care of...", "Caring for..."
  const caringForMatch = cleaned.match(
    /^(?:i'm|i am|we're|we are|currently)?\s*(?:caring for|taking care of|looking after|helping|supporting)\s+(?:my\s+)?(?:mother|mom|father|dad|husband|wife|spouse|partner|son|daughter|sister|brother|friend|parent|child|grandma|grandmother|grandpa|grandfather)?\s*,?\s*([a-zA-Z0-9\s'-]+)$/i,
  );
  if (caringForMatch && caringForMatch[1]) {
    const candidate = cleanPunctuation(caringForMatch[1]);
    if (candidate && !['metastatic cancer', 'cancer'].includes(candidate.toLowerCase())) {
      return candidate;
    }
  }

  // Handle "Her name is...", "His name is...", "Their name is..."
  const nameIsMatch = cleaned.match(
    /^(?:her|his|their|my patient's|the patient's|the person's)?\s*name is\s+([a-zA-Z0-9\s'-]+)$/i,
  );
  if (nameIsMatch && nameIsMatch[1]) {
    const candidate = cleanPunctuation(nameIsMatch[1]);
    if (candidate) return candidate;
  }

  // Handle "It's...", "It is...", "This is for...", "For my..."
  const itsMatch = cleaned.match(
    /^(?:it's|it is|this is for|for)\s+(?:my\s+)?(?:mother|mom|father|dad|husband|wife|spouse|partner|son|daughter|sister|brother|friend|parent|child|grandma|grandmother|grandpa|grandfather)?\s*,?\s*([a-zA-Z0-9\s'-]+)$/i,
  );
  if (itsMatch && itsMatch[1]) {
    const candidate = cleanPunctuation(itsMatch[1]);
    if (candidate) return candidate;
  }

  // Handle "My [relationship], [Name]" e.g. "My mom, Sarah", "My mother Sarah", "My husband John"
  const relWithNameMatch = cleaned.match(
    /^(?:my\s+)?(mother|mom|mommy|father|dad|daddy|husband|wife|spouse|partner|son|daughter|sister|brother|friend|parent|child|grandma|grandmother|grandpa|grandfather)\s*,?\s+([a-zA-Z0-9\s'-]+)$/i,
  );
  if (relWithNameMatch && relWithNameMatch[2]) {
    const candidate = cleanPunctuation(relWithNameMatch[2]);
    if (candidate && !['who has cancer', 'with cancer', 'who has metastatic cancer'].includes(candidate.toLowerCase())) {
      return candidate;
    }
  }

  // Handle standalone relationships: "My mom", "My mother", "My dad", "My husband", "My wife"
  const standaloneRelMatch = cleaned.match(
    /^(?:my\s+)?(mother|mom|mommy|father|dad|daddy|husband|wife|spouse|partner|son|daughter|sister|brother|friend|parent|child|grandma|grandmother|grandpa|grandfather)$/i,
  );
  if (standaloneRelMatch && standaloneRelMatch[1]) {
    const rel = standaloneRelMatch[1].toLowerCase();
    return rel.charAt(0).toUpperCase() + rel.slice(1);
  }

  // Strip trailing diagnosis clauses if present e.g. "Sarah, she has metastatic cancer"
  const withDiagMatch = cleaned.match(/^([a-zA-Z0-9\s'-]+?)\s*,\s*(?:who has|she has|he has|with)\s+.*cancer.*$/i);
  if (withDiagMatch && withDiagMatch[1]) {
    const candidate = cleanPunctuation(withDiagMatch[1]);
    if (candidate) return candidate;
  }

  return cleaned;
}

/** Check if user utterance indicates confirmation / affirmation. */
export function isAffirmative(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const exactAffirmatives = [
    'yes',
    'yeah',
    'yep',
    'yup',
    'yea',
    'aye',
    'thats right',
    'that is right',
    'thats correct',
    'that is correct',
    'correct',
    'confirm',
    'sure',
    'sounds good',
    'right',
    'it is',
    'yes it is',
    'yes please',
    'correct please',
    'exactly',
    'perfect',
    'good',
    'okay',
    'ok',
    'looks good',
    'all good',
    'yes that is right',
    'yes thats right',
    'yes that is correct',
    'yes thats correct',
    'confirmed',
    'yes sir',
    'yes maam',
    'uh huh',
  ];
  if (exactAffirmatives.includes(normalized)) return true;
  if (/^(yes|yeah|yep|yup|sure|correct|confirm|right|perfect|exactly)\b/.test(normalized)) return true;
  if (
    /\b(that is right|thats right|thats correct|that is correct|is correct|sounds good|looks good|all good)\b/.test(
      normalized,
    )
  )
    return true;
  return false;
}

/** Check if user utterance indicates rejection / desire to edit. */
export function isNegative(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const exactNegatives = [
    'no',
    'nope',
    'nah',
    'wrong',
    'thats wrong',
    'that is wrong',
    'incorrect',
    'not right',
    'change',
    'edit',
    'no wait',
    'cancel',
    'redo',
    'not quite',
  ];
  if (exactNegatives.includes(normalized)) return true;
  if (/^(no|nope|nah|wrong|incorrect|change|edit|actually|wait|cancel|redo|sorry)\b/.test(normalized)) return true;
  return false;
}

/** Extract a new corrected name if user provides one in the confirmation step. */
export function extractNameCorrection(text: string): string | null {
  const cleaned = cleanPunctuation(text);
  if (!cleaned) return null;

  const match = cleaned.match(
    /^(?:no|nope|nah|wrong|incorrect|wait|actually|sorry|change(?:\s+it|\s+name)?(?:\s+to)?|redo|not\s+quite)[,.\s]+(?:it's|it is|its|her name is|his name is|their name is|the name is|i said|just|actually|my\s+(?:mom|mother|dad|father|husband|wife|spouse|partner|son|daughter|sister|brother|friend)?\s*,?)?\s*([a-zA-Z0-9\s'-]+)$/i,
  );
  if (match && match[1]) {
    const candidate = cleanPunctuation(match[1]);
    const lower = candidate.toLowerCase();
    const invalidWords = [
      'no',
      'nope',
      'nah',
      'wrong',
      'change',
      'edit',
      'cancel',
      'redo',
      'incorrect',
      'not right',
      'thats wrong',
      'that is wrong',
    ];
    if (candidate && !invalidWords.includes(lower)) {
      return extractCareRecipientName(candidate);
    }
  }

  // Handle direct re-introductions like "Her name is Sarah" or "It's Sarah"
  const directIntro = extractCareRecipientName(cleaned);
  if (directIntro && directIntro.toLowerCase() !== cleaned.toLowerCase()) {
    return directIntro;
  }

  return null;
}
