import { describe, it, expect, vi } from 'vitest';
import { CHECKIN_OPENER, modeOutputSchema, type ModeOutput } from '@turtle/shared';
import type { LlmMessage, LlmProvider, LlmStreamChunk } from '../services/llm/index.js';
import type {
  AssembledContext,
  AssembleOptions,
  MemoryService,
} from '../services/memory/index.js';
import { MODES } from './index.js';
import {
  createCheckinRunner,
  createSuggestionBudget,
  checkinOpener,
  buildSystemPrompt,
  outputOffersSuggestion,
  CHECKIN_SYSTEM,
  CHECKIN_FALLBACK_SAY,
  SUGGESTION_ALLOWED_INSTRUCTION,
  SUGGESTION_SPENT_INSTRUCTION,
  PRIOR_THEMES_PREFIX,
  type SuggestionBudget,
} from './checkin.js';

/**
 * Check-in mode (Task 20, R7.1–R7.4).
 *
 * The supportive, memory-aware default mode. Coverage:
 *   1. Session opener (R7.1) — speaks CHECKIN_OPENER, no cards, valid contract.
 *   2. Memory-aware grounding (R7.3) — prior session summaries are folded into the
 *      system prompt sent to the LLM (asserted via a fake LLM that captures messages).
 *   3. At most one coping suggestion per session (R7.2) — the budget gates the prompt
 *      across turns and is marked once a suggestion is emitted; the second turn's
 *      prompt reflects the spent budget.
 *   4. Zero-key degradation (R16.4 spirit) — a non-live (canned) provider yields a
 *      warm, valid fallback without throwing and without consulting the model.
 *   5. Contract — every produced output validates against modeOutputSchema.
 *
 * Everything is injectable, so these run with FAKES and zero network — mirroring
 * mode-router.test.ts / guardrail.test.ts.
 */

/** An assembled context with the given prior-session summaries (R7.3 seed). */
function contextWith(recentSummaries: string[] = [], recall: string[] = []): AssembledContext {
  return { profileFacts: {}, recentSummaries, recall };
}

/**
 * A fake MemoryService that returns a fixed context and records how it was called.
 * Mirrors the fake-provider style of the sibling tests (no store, no network).
 */
function fakeMemory(context: AssembledContext): {
  memory: MemoryService;
  calls: Array<{ caregiverId: string; opts?: AssembleOptions }>;
} {
  const calls: Array<{ caregiverId: string; opts?: AssembleOptions }> = [];
  const memory: MemoryService = {
    async assemble(caregiverId: string, opts?: AssembleOptions): Promise<AssembledContext> {
      calls.push({ caregiverId, opts });
      return context;
    },
    async apply(): Promise<void> {
      /* no-op for check-in tests */
    },
  };
  return { memory, calls };
}

/**
 * A fake LlmProvider that returns a canned ModeOutput and CAPTURES the messages it was
 * given, so tests can assert what was folded into the system prompt (R7.2/R7.3).
 */
function capturingLlm(
  reply: ModeOutput,
  opts: { live?: boolean } = {},
): { llm: LlmProvider; messages: LlmMessage[][] } {
  const messages: LlmMessage[][] = [];
  const llm: LlmProvider = {
    id: 'fake',
    live: opts.live ?? true,
    async complete(msgs: LlmMessage[]): Promise<ModeOutput> {
      messages.push(msgs);
      return reply;
    },
    stream(msgs: LlmMessage[]): AsyncIterable<LlmStreamChunk> {
      messages.push(msgs);
      return (async function* () {
        yield { text: reply.say, done: true };
      })();
    },
  };
  return { llm, messages };
}

/** Convenience: a valid plain check-in ModeOutput (no suggestion, no cards). */
function plainReply(say = 'That sounds really heavy. I hear you.'): ModeOutput {
  return { say, cards: [], memory_ops: [], flags: ['none'] };
}

/** The system prompt from the most recent captured LLM call. */
function lastSystemPrompt(messages: LlmMessage[][]): string {
  const last = messages[messages.length - 1]!;
  return last.find((m) => m.role === 'system')!.content;
}

describe('checkinOpener — session opener (R7.1)', () => {
  it('speaks the check-in opener with no cards and a valid contract', () => {
    const output = checkinOpener();
    expect(output.say).toBe(CHECKIN_OPENER);
    expect(output.cards).toEqual([]);
    expect(output.memory_ops).toEqual([]);
    expect(output.flags).toEqual(['none']);
    // Must conform to the mode-output contract.
    expect(() => modeOutputSchema.parse(output)).not.toThrow();
  });
});

describe('buildSystemPrompt — prompt assembly (R7.2/R7.3/R7.4)', () => {
  it('always includes the base check-in system prompt', () => {
    const prompt = buildSystemPrompt(contextWith(), false);
    expect(prompt).toContain(CHECKIN_SYSTEM);
  });

  it('permits a suggestion when the budget is available', () => {
    const prompt = buildSystemPrompt(contextWith(), false);
    expect(prompt).toContain(SUGGESTION_ALLOWED_INSTRUCTION);
    expect(prompt).not.toContain(SUGGESTION_SPENT_INSTRUCTION);
  });

  it('forbids a further suggestion when the budget is spent', () => {
    const prompt = buildSystemPrompt(contextWith(), true);
    expect(prompt).toContain(SUGGESTION_SPENT_INSTRUCTION);
    expect(prompt).not.toContain(SUGGESTION_ALLOWED_INSTRUCTION);
  });

  it('folds prior-session themes into the prompt when they exist (R7.3)', () => {
    const summaries = ['Talked about the nausea getting worse.', 'Felt exhausted and alone.'];
    const prompt = buildSystemPrompt(contextWith(summaries), false);
    expect(prompt).toContain(PRIOR_THEMES_PREFIX);
    for (const s of summaries) expect(prompt).toContain(s);
  });

  it('omits the prior-themes block when there are no summaries', () => {
    const prompt = buildSystemPrompt(contextWith([]), false);
    expect(prompt).not.toContain(PRIOR_THEMES_PREFIX);
  });
});

describe('createCheckinRunner — memory-aware conversation (R7.3)', () => {
  it('assembles memory context with recall for the caregiver', async () => {
    const { memory, calls } = fakeMemory(contextWith(['Prior theme.']));
    const { llm } = capturingLlm(plainReply());
    const runner = createCheckinRunner({
      llm,
      memory,
      suggestionBudget: createSuggestionBudget(),
      caregiverId: 'cg-1',
    });

    await runner.run('It was a hard day.');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.caregiverId).toBe('cg-1');
    expect(calls[0]!.opts?.includeRecall).toBe(true);
  });

  it('folds prior session summaries into the prompt sent to the LLM (R7.3)', async () => {
    const summaries = ['Last time: the nausea seemed worse.'];
    const { memory } = fakeMemory(contextWith(summaries));
    const { llm, messages } = capturingLlm(plainReply());
    const runner = createCheckinRunner({
      llm,
      memory,
      suggestionBudget: createSuggestionBudget(),
      caregiverId: 'cg-1',
    });

    await runner.run("I'm worried about him.");

    const system = lastSystemPrompt(messages);
    expect(system).toContain(PRIOR_THEMES_PREFIX);
    expect(system).toContain(summaries[0]!);
  });

  it('has mode "checkin"', () => {
    const { memory } = fakeMemory(contextWith());
    const { llm } = capturingLlm(plainReply());
    const runner = createCheckinRunner({
      llm,
      memory,
      suggestionBudget: createSuggestionBudget(),
      caregiverId: 'cg-1',
    });
    expect(runner.mode).toBe('checkin');
    expect(MODES).toContain(runner.mode);
  });
});

describe('outputOffersSuggestion — suggestion detection heuristic (R7.2)', () => {
  it('detects suggestion phrasing', () => {
    expect(outputOffersSuggestion(plainReply('You could try taking a short walk.'))).toBe(true);
    expect(outputOffersSuggestion(plainReply('It might help to step outside for a moment.'))).toBe(
      true,
    );
    expect(outputOffersSuggestion(plainReply('Maybe you could ask a friend to sit with him.'))).toBe(
      true,
    );
  });

  it('does not flag pure validation', () => {
    expect(outputOffersSuggestion(plainReply('That sounds so hard. I hear you.'))).toBe(false);
    expect(outputOffersSuggestion(plainReply("You're doing your best, and that matters."))).toBe(
      false,
    );
  });
});

describe('createCheckinRunner — at most one coping suggestion per session (R7.2)', () => {
  it('permits the suggestion on the first turn, then forbids it on the second', async () => {
    const { memory } = fakeMemory(contextWith());
    // The model offers a suggestion on turn one.
    const { llm, messages } = capturingLlm(plainReply('You could try taking a short break today.'));
    const budget = createSuggestionBudget();
    const runner = createCheckinRunner({ llm, memory, suggestionBudget: budget, caregiverId: 'cg-1' });

    // Turn 1: budget available → prompt permits a suggestion.
    await runner.run("I'm exhausted.");
    expect(lastSystemPrompt(messages)).toContain(SUGGESTION_ALLOWED_INSTRUCTION);
    // The turn offered a suggestion, so the budget is now spent.
    expect(budget.hasSuggestedThisSession()).toBe(true);

    // Turn 2: budget spent → prompt forbids a further suggestion.
    await runner.run('Still feeling low.');
    expect(lastSystemPrompt(messages)).toContain(SUGGESTION_SPENT_INSTRUCTION);
  });

  it('marks the budget used only when a suggestion is actually offered', async () => {
    const { memory } = fakeMemory(contextWith());
    const { llm } = capturingLlm(plainReply('That is a lot to carry. I hear you.'));
    const budget = createSuggestionBudget();
    const runner = createCheckinRunner({ llm, memory, suggestionBudget: budget, caregiverId: 'cg-1' });

    await runner.run('It was a hard day.');
    // Pure validation → budget remains available.
    expect(budget.hasSuggestedThisSession()).toBe(false);
  });

  it('respects a fake budget that reports already-spent', async () => {
    const { memory } = fakeMemory(contextWith());
    const { llm, messages } = capturingLlm(plainReply());
    const marked = vi.fn();
    const spentBudget: SuggestionBudget = {
      hasSuggestedThisSession: () => true,
      markSuggested: marked,
    };
    const runner = createCheckinRunner({
      llm,
      memory,
      suggestionBudget: spentBudget,
      caregiverId: 'cg-1',
    });

    await runner.run('I need a moment.');
    // Prompt must forbid a further suggestion, and we never re-mark an already-spent budget.
    expect(lastSystemPrompt(messages)).toContain(SUGGESTION_SPENT_INSTRUCTION);
    expect(marked).not.toHaveBeenCalled();
  });
});

describe('createCheckinRunner — zero-key graceful degradation (R16.4 spirit)', () => {
  it('returns a warm, valid fallback with a non-live provider and never consults it', async () => {
    const { memory } = fakeMemory(contextWith(['Prior theme.']));
    const { llm } = capturingLlm(plainReply(), { live: false });
    const spy = vi.spyOn(llm, 'complete');
    const runner = createCheckinRunner({
      llm,
      memory,
      suggestionBudget: createSuggestionBudget(),
      caregiverId: 'cg-1',
    });

    const output = await runner.run('Hi.');
    expect(output.say).toBe(CHECKIN_FALLBACK_SAY);
    expect(output.cards).toEqual([]);
    expect(() => modeOutputSchema.parse(output)).not.toThrow();
    // A non-live provider only echoes; it must not be consulted for a check-in turn.
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('createCheckinRunner — output always validates against the contract', () => {
  it('produces a schema-valid ModeOutput for a live turn', async () => {
    const { memory } = fakeMemory(contextWith(['Prior theme.']));
    const { llm } = capturingLlm(plainReply());
    const runner = createCheckinRunner({
      llm,
      memory,
      suggestionBudget: createSuggestionBudget(),
      caregiverId: 'cg-1',
    });

    const output = await runner.run('Tell me it will be okay.');
    expect(() => modeOutputSchema.parse(output)).not.toThrow();
    expect(output.say.length).toBeGreaterThan(0);
  });
});
