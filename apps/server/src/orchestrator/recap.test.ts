import { describe, it, expect, vi } from 'vitest';
import { modeOutputSchema, type Card, type ModeOutput } from '@turtle/shared';
import type { LlmMessage, LlmProvider, LlmStreamChunk } from '../services/llm/index.js';
import { MODES } from './index.js';
import {
  createRecapRunner,
  runRecap,
  isClosingPhrase,
  isRecapCard,
  composeRecapSay,
  buildRecapPrompt,
  buildDeterministicRecap,
  buildRecapCard,
  RECAP_SYSTEM,
  RECAP_TOPICS_PREFIX,
  RECAP_CARD_TITLE,
  RECAP_CLOSING_LINE,
  RECAP_EMPTY_SAY,
  MAX_RECAP_TOPICS,
} from './recap.js';

/**
 * Recap & session close — `recap.prompt` (Task 32, R2.6 / R7.5 / R14.1–R14.3).
 *
 * Coverage:
 *   1. Closing-phrase detection (R2.6) — "I have to go" and kindred farewells close;
 *      benign mentions of leaving do NOT.
 *   2. Recap composition (R14.1) — a live LLM phrases the covered topics into the
 *      spoken recap; a non-live provider yields the deterministic recap without being
 *      consulted (zero-key close within budget).
 *   3. Recap card (R7.5/R14.2) — every recap emits exactly one retained recap card with
 *      the stable title; the topics appear in the body; recognized by isRecapCard.
 *   4. Contract — every produced output validates against modeOutputSchema.
 *
 * Everything is injectable, so these run with FAKES and zero network — mirroring
 * checkin.test.ts / log.test.ts.
 */

/**
 * A fake LlmProvider that returns a canned ModeOutput and CAPTURES the messages it was
 * given, so tests can assert the topics folded into the recap prompt (R14.1).
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

/** A valid recap-shaped ModeOutput reply from the model (no cards; composer adds them). */
function recapReply(say = 'We talked about the nausea and how tired you are. Take care.'): ModeOutput {
  return { say, cards: [], memory_ops: [], flags: ['none'] };
}

/** The system prompt from the most recent captured LLM call. */
function lastSystemPrompt(messages: LlmMessage[][]): string {
  const last = messages[messages.length - 1]!;
  return last.find((m) => m.role === 'system')!.content;
}

/** The single card off a produced recap output (there is always exactly one). */
function onlyCard(output: ModeOutput): Card {
  expect(output.cards).toHaveLength(1);
  return output.cards[0]!;
}

describe('isClosingPhrase — closing-phrase detection (R2.6)', () => {
  it('detects the canonical "I have to go" and its variants', () => {
    expect(isClosingPhrase('I have to go')).toBe(true);
    expect(isClosingPhrase("I've got to go now")).toBe(true);
    expect(isClosingPhrase('I gotta go')).toBe(true);
    expect(isClosingPhrase('we need to go')).toBe(true);
    expect(isClosingPhrase('I should get going')).toBe(true);
    expect(isClosingPhrase("I'd better get going")).toBe(true);
    expect(isClosingPhrase('I have to head out')).toBe(true);
  });

  it('detects gentle wrap-ups and farewells', () => {
    expect(isClosingPhrase("let's stop here")).toBe(true);
    expect(isClosingPhrase("let's wrap up")).toBe(true);
    expect(isClosingPhrase("that's all for now")).toBe(true);
    expect(isClosingPhrase('talk to you later')).toBe(true);
    expect(isClosingPhrase('talk soon')).toBe(true);
    expect(isClosingPhrase('Goodbye')).toBe(true);
    expect(isClosingPhrase('bye for now')).toBe(true);
    expect(isClosingPhrase('good night')).toBe(true);
  });

  it('does NOT close on benign mentions of going/leaving', () => {
    // Patient leaving, not the caregiver ending the session.
    expect(isClosingPhrase('he had to go to the hospital')).toBe(false);
    expect(isClosingPhrase('she needs to go for a scan tomorrow')).toBe(false);
    // Ordinary conversation.
    expect(isClosingPhrase('I want to talk about his medication')).toBe(false);
    expect(isClosingPhrase('the nausea is getting worse')).toBe(false);
    expect(isClosingPhrase('goodbye kisses are all he wants lately')).toBe(false);
  });
});

describe('buildRecapPrompt — prompt assembly (R14.1)', () => {
  it('always includes the base recap system prompt', () => {
    expect(buildRecapPrompt([])).toContain(RECAP_SYSTEM);
    expect(buildRecapPrompt(['the nausea'])).toContain(RECAP_SYSTEM);
  });

  it('folds covered topics into the prompt when they exist', () => {
    const topics = ['how tired you are', 'the nausea getting worse'];
    const prompt = buildRecapPrompt(topics);
    expect(prompt).toContain(RECAP_TOPICS_PREFIX);
    for (const t of topics) expect(prompt).toContain(t);
  });

  it('omits the topics block when there are none', () => {
    expect(buildRecapPrompt([])).not.toContain(RECAP_TOPICS_PREFIX);
  });
});

describe('buildDeterministicRecap — zero-key recap (R2.6/R14.1)', () => {
  it('names the covered topics and closes warmly', () => {
    const say = buildDeterministicRecap(['the nausea', 'feeling alone']);
    expect(say).toContain('the nausea');
    expect(say).toContain('feeling alone');
    expect(say).toContain(RECAP_CLOSING_LINE);
  });

  it('uses the warm empty-session close when nothing was covered', () => {
    expect(buildDeterministicRecap([])).toBe(RECAP_EMPTY_SAY);
  });
});

describe('buildRecapCard — retained recap card (R14.2)', () => {
  it('is a retained card with the stable recap title, no action', () => {
    const card = buildRecapCard(['the nausea', 'feeling alone']);
    expect(card.type).toBe('retained');
    expect(card.title).toBe(RECAP_CARD_TITLE);
    expect(card.action).toBeUndefined();
  });

  it('lists the covered topics in the body', () => {
    const card = buildRecapCard(['the nausea', 'feeling alone']);
    expect(card.body).toContain('the nausea');
    expect(card.body).toContain('feeling alone');
  });

  it('uses a gentle placeholder body for an empty session', () => {
    const card = buildRecapCard([]);
    expect(card.body.length).toBeGreaterThan(0);
  });

  it('keeps the body within the contract length cap for many/long topics', () => {
    const topics = Array.from({ length: 10 }, (_, i) => `topic ${i} `.repeat(20));
    const card = buildRecapCard(topics);
    expect(card.body.length).toBeLessThanOrEqual(280);
  });

  it('is recognized by isRecapCard, and other retained cards are not', () => {
    expect(isRecapCard(buildRecapCard(['x']))).toBe(true);
    expect(isRecapCard({ type: 'retained', title: 'Logged', body: 'x' })).toBe(false);
    expect(isRecapCard({ type: 'safety', title: RECAP_CARD_TITLE, body: 'x' })).toBe(false);
  });
});

describe('composeRecapSay — live vs zero-key (R2.6/R14.1)', () => {
  it('phrases the covered topics via the LLM prompt when live', async () => {
    const topics = ['the nausea getting worse', 'how exhausted you feel'];
    const { llm, messages } = capturingLlm(recapReply());
    const say = await composeRecapSay(topics, llm);
    expect(say).toBe(recapReply().say);
    const system = lastSystemPrompt(messages);
    expect(system).toContain(RECAP_TOPICS_PREFIX);
    for (const t of topics) expect(system).toContain(t);
  });

  it('falls back to the deterministic recap with a non-live provider and never consults it', async () => {
    const topics = ['the nausea'];
    const { llm } = capturingLlm(recapReply(), { live: false });
    const spy = vi.spyOn(llm, 'complete');
    const say = await composeRecapSay(topics, llm);
    expect(say).toBe(buildDeterministicRecap(topics));
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to the deterministic recap when the model returns an empty say', async () => {
    const topics = ['the nausea'];
    const { llm } = capturingLlm(recapReply('   '));
    const say = await composeRecapSay(topics, llm);
    expect(say).toBe(buildDeterministicRecap(topics));
  });
});

describe('runRecap — spoken recap + recap card (R7.5/R14.1/R14.2)', () => {
  it('emits a brief spoken recap and exactly one retained recap card (live)', async () => {
    const { llm } = capturingLlm(recapReply());
    const output = await runRecap({ llm, coveredTopics: ['the nausea', 'feeling alone'] });

    expect(output.say.length).toBeGreaterThan(0);
    const card = onlyCard(output);
    expect(isRecapCard(card)).toBe(true);
    expect(output.memory_ops).toEqual([]);
    expect(output.flags).toEqual(['none']);
    expect(() => modeOutputSchema.parse(output)).not.toThrow();
  });

  it('closes warmly with a recap card even on an empty session (zero-key)', async () => {
    const { llm } = capturingLlm(recapReply(), { live: false });
    const output = await runRecap({ llm, coveredTopics: [] });

    expect(output.say).toBe(RECAP_EMPTY_SAY);
    expect(isRecapCard(onlyCard(output))).toBe(true);
    expect(() => modeOutputSchema.parse(output)).not.toThrow();
  });

  it('de-duplicates and bounds covered topics in the card', async () => {
    const { llm } = capturingLlm(recapReply(), { live: false });
    const dupes = ['nausea', 'Nausea', 'sleep', 'food', 'events', 'extra'];
    const output = await runRecap({ llm, coveredTopics: dupes });
    const bulletCount = onlyCard(output).body.split('\n').length;
    // "nausea"/"Nausea" collapse to one; total capped at MAX_RECAP_TOPICS.
    expect(bulletCount).toBeLessThanOrEqual(MAX_RECAP_TOPICS);
  });
});

describe('createRecapRunner — ModeRunner shape', () => {
  it('is a valid ModeRunner and produces a contract-valid output', async () => {
    const { llm } = capturingLlm(recapReply());
    const runner = createRecapRunner({ llm, coveredTopics: ['the nausea'] });
    expect(MODES).toContain(runner.mode);
    const output = await runner.run('I have to go');
    expect(() => modeOutputSchema.parse(output)).not.toThrow();
    expect(isRecapCard(onlyCard(output))).toBe(true);
  });
});
