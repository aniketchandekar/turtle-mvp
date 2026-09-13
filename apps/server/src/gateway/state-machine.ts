import type { AssistantState } from '@turtle/shared';

/**
 * Conversation state machine (Task 11, Requirement 2).
 *
 * Drives the per-session assistant state through the frozen flow:
 *
 *   IDLE → LISTENING → THINKING → SPEAKING → WAITING → (LISTENING | CLOSING)
 *
 * Responsibilities (all owned here, so the SessionChannel stays a thin router):
 *   - Enforce the legal transition graph; illegal transitions are rejected, not
 *     silently applied, so a routing bug can't drive the client into a bad state.
 *   - Emit `assistant_state` to the client on EVERY accepted transition (R2.1–R2.5).
 *   - Record each entered state on the session's `mode_transitions` (R2.7).
 *   - Auto-advance WAITING → LISTENING after a short silence (R2.5). The timer is
 *     injectable so tests run without real time.
 *
 * The machine is transport-agnostic: it does not know about WebSockets or the store.
 * The SessionChannel wires the `emit` and `record` callbacks and owns provider I/O.
 */

/**
 * Legal transitions between assistant states. A transition is accepted only if the
 * target appears in the source's allow-list. Re-entering the same state is allowed
 * (it is still announced) so the client can be re-synced without a graph change.
 */
export const STATE_TRANSITIONS: Readonly<Record<AssistantState, readonly AssistantState[]>> = {
  // Armed but not recording. Binding a session arms LISTENING (R2.1 → R2.2).
  IDLE: ['IDLE', 'LISTENING', 'CLOSING'],
  // Capturing speech. End-of-speech (button release / endpointing) → THINKING (R2.3).
  // A barge-in or a fresh turn can re-enter LISTENING; a closing phrase → CLOSING.
  LISTENING: ['LISTENING', 'THINKING', 'CLOSING'],
  // Orchestrator working. Response streaming begins → SPEAKING (R2.4). An interrupt
  // while thinking abandons the turn back to LISTENING.
  THINKING: ['SPEAKING', 'LISTENING', 'CLOSING'],
  // Assistant utterance playing. Utterance completes → WAITING (R2.5). A barge-in
  // during playback returns to LISTENING; a closing turn → CLOSING.
  SPEAKING: ['WAITING', 'LISTENING', 'CLOSING'],
  // Short silence after an utterance. Returns to LISTENING automatically (R2.5), or a
  // closing turn ends the session.
  WAITING: ['LISTENING', 'CLOSING', 'WAITING'],
  // Terminal. The session is ending warmly; no transitions out.
  CLOSING: [],
};

/** The state a freshly-armed session sits in before any binding (R2.1). */
export const INITIAL_STATE: AssistantState = 'IDLE';

/** Default short-silence window before WAITING auto-advances to LISTENING (R2.5). */
export const DEFAULT_WAITING_SILENCE_MS = 400;

export interface StateMachineOptions {
  /** Announce an entered state to the client (server → client `assistant_state`). */
  emit(state: AssistantState): void;
  /** Persist an entered state onto the session's mode_transitions (R2.7). */
  record(state: AssistantState): void;
  /** Short-silence window before WAITING → LISTENING (R2.5). */
  waitingSilenceMs?: number;
  /** Timer seams (injectable for deterministic tests). Default to Node timers. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * A single session's conversation state machine. One instance per SessionChannel.
 */
export class ConversationStateMachine {
  private currentState: AssistantState = INITIAL_STATE;
  private waitingTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private readonly emit: (state: AssistantState) => void;
  private readonly record: (state: AssistantState) => void;
  private readonly waitingSilenceMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  constructor(options: StateMachineOptions) {
    this.emit = options.emit;
    this.record = options.record;
    this.waitingSilenceMs = options.waitingSilenceMs ?? DEFAULT_WAITING_SILENCE_MS;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
  }

  /** The current assistant state. */
  get state(): AssistantState {
    return this.currentState;
  }

  /** Whether `next` is a legal transition from the current state. */
  canTransition(next: AssistantState): boolean {
    return STATE_TRANSITIONS[this.currentState].includes(next);
  }

  /**
   * Attempt a transition to `next`. On success: update state, announce it via
   * `emit`, and persist it via `record`; returns true. On an illegal transition (or
   * after disposal) nothing changes and it returns false.
   *
   * Entering WAITING arms the short-silence timer; leaving WAITING cancels it.
   */
  transition(next: AssistantState): boolean {
    if (this.disposed) return false;
    if (!this.canTransition(next)) return false;

    // Any accepted transition clears a pending WAITING timer; it is re-armed below
    // only when we are entering WAITING. This prevents a stale timer from firing
    // after we've already moved on (e.g. a closing turn that ends in CLOSING).
    this.cancelWaitingTimer();

    this.currentState = next;
    this.emit(next);
    this.record(next);

    if (next === 'WAITING') {
      this.armWaitingTimer();
    }
    return true;
  }

  /**
   * Arm LISTENING when a session binds (R2.2). Convenience wrapper around the
   * IDLE → LISTENING transition; returns false if not currently armable.
   */
  arm(): boolean {
    return this.transition('LISTENING');
  }

  /** Stop timers and freeze the machine. Called when the session channel closes. */
  dispose(): void {
    this.disposed = true;
    this.cancelWaitingTimer();
  }

  private armWaitingTimer(): void {
    this.waitingTimer = this.setTimer(() => {
      this.waitingTimer = null;
      // Short silence elapsed: return to LISTENING for the next turn (R2.5). Guard
      // against a race where we left WAITING (or disposed) before the timer fired.
      if (this.disposed || this.currentState !== 'WAITING') return;
      this.transition('LISTENING');
    }, this.waitingSilenceMs);
  }

  private cancelWaitingTimer(): void {
    if (this.waitingTimer !== null) {
      this.clearTimer(this.waitingTimer);
      this.waitingTimer = null;
    }
  }
}
