import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AssistantState } from '@turtle/shared';
import {
  ConversationStateMachine,
  STATE_TRANSITIONS,
  INITIAL_STATE,
  DEFAULT_WAITING_SILENCE_MS,
  type StateMachineOptions,
} from './state-machine.js';

/**
 * Conversation state machine (Task 11, Requirement 2).
 *
 * Exercises the transition graph directly — no WebSocket, no store — so the state
 * rules, the `assistant_state` emission on every transition, the mode_transitions
 * recording, and the short-silence WAITING → LISTENING behavior are all verified in
 * isolation. Timers are driven by Vitest fake timers for determinism.
 */

interface Recorder {
  emitted: AssistantState[];
  recorded: AssistantState[];
  make(overrides?: Partial<StateMachineOptions>): ConversationStateMachine;
}

function recorder(): Recorder {
  const emitted: AssistantState[] = [];
  const recorded: AssistantState[] = [];
  return {
    emitted,
    recorded,
    make(overrides?: Partial<StateMachineOptions>) {
      return new ConversationStateMachine({
        emit: (s) => emitted.push(s),
        record: (s) => recorded.push(s),
        ...overrides,
      });
    },
  };
}

/** Walk the machine through the canonical happy path up to a target state. */
function driveTo(sm: ConversationStateMachine, target: AssistantState): void {
  const path: AssistantState[] = ['LISTENING', 'THINKING', 'SPEAKING', 'WAITING'];
  for (const state of path) {
    sm.transition(state);
    if (state === target) return;
  }
}

describe('ConversationStateMachine — initial state (R2.1)', () => {
  it('starts IDLE (armed, not recording) before any transition', () => {
    const r = recorder();
    const sm = r.make();
    expect(sm.state).toBe(INITIAL_STATE);
    expect(sm.state).toBe('IDLE');
    // Construction does not announce or record anything on its own.
    expect(r.emitted).toEqual([]);
    expect(r.recorded).toEqual([]);
  });
});

describe('ConversationStateMachine — full flow IDLE → … → CLOSING (R2.1–R2.5)', () => {
  it('accepts the canonical flow and emits + records each entered state', () => {
    const r = recorder();
    const sm = r.make();

    expect(sm.transition('LISTENING')).toBe(true); // IDLE → LISTENING (R2.2)
    expect(sm.transition('THINKING')).toBe(true); // LISTENING → THINKING (R2.3)
    expect(sm.transition('SPEAKING')).toBe(true); // THINKING → SPEAKING (R2.4)
    expect(sm.transition('WAITING')).toBe(true); // SPEAKING → WAITING (R2.5)
    expect(sm.transition('LISTENING')).toBe(true); // WAITING → LISTENING (next turn)
    expect(sm.transition('THINKING')).toBe(true);
    expect(sm.transition('SPEAKING')).toBe(true);
    expect(sm.transition('WAITING')).toBe(true);
    expect(sm.transition('CLOSING')).toBe(true); // WAITING → CLOSING

    const flow: AssistantState[] = [
      'LISTENING',
      'THINKING',
      'SPEAKING',
      'WAITING',
      'LISTENING',
      'THINKING',
      'SPEAKING',
      'WAITING',
      'CLOSING',
    ];
    // assistant_state is emitted on EVERY transition, in order.
    expect(r.emitted).toEqual(flow);
    // Each entered state is recorded on mode_transitions (R2.7), same order.
    expect(r.recorded).toEqual(flow);
    expect(sm.state).toBe('CLOSING');
  });

  it('allows SPEAKING → CLOSING directly for a closing turn (R2.6)', () => {
    const r = recorder();
    const sm = r.make();
    driveTo(sm, 'SPEAKING');
    expect(sm.transition('CLOSING')).toBe(true);
    expect(sm.state).toBe('CLOSING');
    expect(r.emitted.at(-1)).toBe('CLOSING');
  });
});

describe('ConversationStateMachine — illegal transitions rejected', () => {
  it('rejects a transition not in the source allow-list without side effects', () => {
    const r = recorder();
    const sm = r.make();
    // IDLE cannot jump straight to SPEAKING.
    expect(sm.canTransition('SPEAKING')).toBe(false);
    expect(sm.transition('SPEAKING')).toBe(false);
    expect(sm.state).toBe('IDLE');
    // Nothing was emitted or recorded for the rejected transition.
    expect(r.emitted).toEqual([]);
    expect(r.recorded).toEqual([]);
  });

  it('rejects skipping THINKING (LISTENING → SPEAKING)', () => {
    const r = recorder();
    const sm = r.make();
    sm.transition('LISTENING');
    expect(sm.transition('SPEAKING')).toBe(false);
    expect(sm.state).toBe('LISTENING');
  });

  it('treats CLOSING as terminal — no transition out', () => {
    const r = recorder();
    const sm = r.make();
    sm.transition('LISTENING');
    sm.transition('CLOSING');
    for (const target of STATE_TRANSITIONS.LISTENING) {
      expect(sm.transition(target)).toBe(false);
    }
    expect(sm.state).toBe('CLOSING');
  });

  it('rejects THINKING → THINKING (no self-loop for the working state)', () => {
    const r = recorder();
    const sm = r.make();
    driveTo(sm, 'THINKING');
    const emittedBefore = r.emitted.length;
    expect(sm.transition('THINKING')).toBe(false);
    expect(r.emitted.length).toBe(emittedBefore);
    expect(sm.state).toBe('THINKING');
  });
});

describe('ConversationStateMachine — short-silence WAITING → LISTENING (R2.5)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('auto-advances WAITING → LISTENING after the silence window elapses', () => {
    const r = recorder();
    const sm = r.make({ waitingSilenceMs: 400 });
    driveTo(sm, 'WAITING');
    expect(sm.state).toBe('WAITING');

    // Before the window elapses, still WAITING.
    vi.advanceTimersByTime(399);
    expect(sm.state).toBe('WAITING');

    // After the window, the machine returns to LISTENING on its own and announces it.
    vi.advanceTimersByTime(1);
    expect(sm.state).toBe('LISTENING');
    expect(r.emitted.at(-1)).toBe('LISTENING');
    expect(r.recorded.at(-1)).toBe('LISTENING');
  });

  it('cancels the pending timer when leaving WAITING via CLOSING (no stray LISTENING)', () => {
    const r = recorder();
    const sm = r.make({ waitingSilenceMs: 400 });
    driveTo(sm, 'WAITING');
    // A closing turn lands while WAITING; this must cancel the silence timer.
    expect(sm.transition('CLOSING')).toBe(true);
    vi.advanceTimersByTime(1000);
    // The machine stayed CLOSING; the timer did not resurrect LISTENING.
    expect(sm.state).toBe('CLOSING');
    expect(r.emitted.filter((s) => s === 'LISTENING')).toHaveLength(1); // only the arm
  });

  it('does not fire the timer after disposal', () => {
    const r = recorder();
    const sm = r.make({ waitingSilenceMs: 400 });
    driveTo(sm, 'WAITING');
    sm.dispose();
    vi.advanceTimersByTime(1000);
    expect(sm.state).toBe('WAITING');
    expect(r.emitted.at(-1)).toBe('WAITING');
  });

  it('uses the default silence window when none is provided', () => {
    const r = recorder();
    const sm = r.make();
    driveTo(sm, 'WAITING');
    vi.advanceTimersByTime(DEFAULT_WAITING_SILENCE_MS - 1);
    expect(sm.state).toBe('WAITING');
    vi.advanceTimersByTime(1);
    expect(sm.state).toBe('LISTENING');
  });
});

describe('ConversationStateMachine — disposal freezes the machine', () => {
  it('ignores transitions after dispose', () => {
    const r = recorder();
    const sm = r.make();
    sm.transition('LISTENING');
    sm.dispose();
    expect(sm.transition('THINKING')).toBe(false);
    expect(sm.state).toBe('LISTENING');
  });
});

describe('ConversationStateMachine — barge-in / interrupt transitions', () => {
  it('allows SPEAKING → LISTENING (interrupt during playback, R4.3/R4.4)', () => {
    const r = recorder();
    const sm = r.make();
    driveTo(sm, 'SPEAKING');
    expect(sm.transition('LISTENING')).toBe(true);
    expect(sm.state).toBe('LISTENING');
  });

  it('allows THINKING → LISTENING (interrupt while thinking)', () => {
    const r = recorder();
    const sm = r.make();
    driveTo(sm, 'THINKING');
    expect(sm.transition('LISTENING')).toBe(true);
    expect(sm.state).toBe('LISTENING');
  });
});
