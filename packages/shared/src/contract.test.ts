import { describe, it, expect } from 'vitest';
import {
  turnContractSchema,
  modeOutputSchema,
  safeFallbackContract,
  SAFE_FALLBACK_SAY,
} from './contract.js';

describe('turnContractSchema', () => {
  it('accepts a minimal valid contract and applies defaults', () => {
    const parsed = turnContractSchema.parse({
      session_id: 's1',
      turn_id: 't1',
      state: 'WAITING',
      say: 'Noted — 2pm meds given.',
    });
    expect(parsed.cards).toEqual([]);
    expect(parsed.memory_ops).toEqual([]);
    expect(parsed.flags).toEqual(['none']);
  });

  it('accepts one card but rejects more than one active card', () => {
    const oneCard = {
      session_id: 's1',
      turn_id: 't1',
      state: 'SPEAKING' as const,
      say: 'Saved that for you.',
      cards: [{ type: 'retained' as const, title: 'Questions for Tuesday', body: 'Ask about nausea.' }],
    };
    expect(() => turnContractSchema.parse(oneCard)).not.toThrow();

    const twoCards = {
      ...oneCard,
      cards: [
        { type: 'retained' as const, title: 'A', body: 'x' },
        { type: 'actionable' as const, title: 'B', body: 'y' },
      ],
    };
    expect(() => turnContractSchema.parse(twoCards)).toThrow();
  });

  it('rejects an invalid state', () => {
    expect(() =>
      turnContractSchema.parse({ session_id: 's', turn_id: 't', state: 'DANCING', say: 'x' }),
    ).toThrow();
  });

  it('rejects an empty say', () => {
    expect(() =>
      turnContractSchema.parse({
        session_id: 's1',
        turn_id: 't1',
        state: 'WAITING',
        say: '',
      }),
    ).toThrow();
  });

  it('rejects an invalid flag value', () => {
    expect(() =>
      turnContractSchema.parse({
        session_id: 's1',
        turn_id: 't1',
        state: 'WAITING',
        say: 'ok',
        flags: ['definitely_not_a_flag'],
      }),
    ).toThrow();
  });

  it('validates memory ops discriminated union', () => {
    const parsed = modeOutputSchema.parse({
      say: 'ok',
      memory_ops: [
        { op: 'append_log', category: 'symptom', text: 'new cough' },
        { op: 'set_fact', key: 'recurring_theme', value: 'sleep' },
      ],
    });
    expect(parsed.memory_ops).toHaveLength(2);
  });

  it('produces a safe fallback contract', () => {
    const fb = safeFallbackContract('s1', 't1');
    expect(fb.say).toBe(SAFE_FALLBACK_SAY);
    expect(fb.cards).toEqual([]);
    expect(fb.flags).toEqual(['none']);
  });
});
