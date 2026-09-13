import { describe, it, expect, vi } from 'vitest';
import { modeOutputSchema } from '@turtle/shared';
import { loadConfig, type EnvSource } from '../../config.js';
import {
  createLlmProvider,
  createCannedLlmProvider,
  createRemoteLlmProvider,
  runMode,
  parseModeOutput,
  parkTheTurnOutput,
  LlmTimeoutError,
  LLM_TIMEOUT_MS,
  PARK_THE_TURN_SAY,
  CANNED_SAY_PREFIX,
  type ChatStreamFactory,
  type LlmMessage,
  type LlmProvider,
  type LlmStreamChunk,
} from './index.js';

/**
 * LLM provider adapter (Task 14).
 *
 * All coverage runs against FAKE chat factories + injected timers — no network,
 * no real wall-clock waits:
 *   - Interface + streaming: `stream()`/`complete()` over a fake remote provider.
 *   - Timeout + one retry + park-the-turn (R6.2/R6.3) with deterministic timers.
 *   - Canned/echo fallback when no LLM key is present (R16.4).
 *   - Provider resolution from config (canned with zero keys, remote with a key).
 */

const ANTHROPIC_ENV: EnvSource = { ANTHROPIC_API_KEY: 'sk-ant-test', LLM_PROVIDER: 'anthropic' };

/** A JSON ModeOutput string the mode prompts instruct the model to emit. */
const VALID_JSON = JSON.stringify({ say: 'Hello there.', flags: ['none'] });

/** Build a fake streaming chat factory that yields `text` split into deltas. */
function fakeChat(text: string, opts: { chunks?: number } = {}): ChatStreamFactory {
  const chunks = opts.chunks ?? 3;
  const size = Math.ceil(text.length / chunks);
  return () =>
    (async function* (): AsyncIterable<LlmStreamChunk> {
      for (let i = 0; i < text.length; i += size) {
        const slice = text.slice(i, i + size);
        yield { text: slice, done: i + size >= text.length };
      }
    })();
}

/** Collect all text deltas from a stream. */
async function collect(stream: AsyncIterable<LlmStreamChunk>): Promise<string> {
  let out = '';
  for await (const c of stream) out += c.text;
  return out;
}

describe('parseModeOutput — tolerant JSON extraction', () => {
  it('parses a bare JSON ModeOutput and fills defaults', () => {
    const out = parseModeOutput(VALID_JSON);
    expect(out.say).toBe('Hello there.');
    expect(out.cards).toEqual([]);
    expect(out.memory_ops).toEqual([]);
    expect(out.flags).toEqual(['none']);
  });

  it('extracts JSON wrapped in prose / markdown fences', () => {
    const wrapped = 'Sure!\n```json\n' + VALID_JSON + '\n```\nHope that helps.';
    expect(parseModeOutput(wrapped).say).toBe('Hello there.');
  });

  it('throws when there is no JSON object', () => {
    expect(() => parseModeOutput('no json here')).toThrow();
  });

  it('throws when the JSON is not a valid ModeOutput', () => {
    // Missing required non-empty `say`.
    expect(() => parseModeOutput(JSON.stringify({ flags: ['none'] }))).toThrow();
  });
});

describe('remote provider — interface + streaming', () => {
  it('streams text deltas and completes into a parsed ModeOutput', async () => {
    const chat = fakeChat(VALID_JSON, { chunks: 4 });
    const provider = createRemoteLlmProvider('anthropic', 'sk-ant-test', 'claude-3-5-sonnet-latest', chat);

    expect(provider.id).toBe('anthropic');
    expect(provider.live).toBe(true);

    // stream() yields fragments that reassemble to the raw JSON.
    const streamed = await collect(provider.stream([{ role: 'user', content: 'hi' }]));
    expect(streamed).toBe(VALID_JSON);

    // complete() drains + parses into a valid ModeOutput.
    const out = await provider.complete([{ role: 'user', content: 'hi' }]);
    expect(modeOutputSchema.safeParse(out).success).toBe(true);
    expect(out.say).toBe('Hello there.');
  });

  it('forwards apiKey, model, and messages to the chat factory', async () => {
    const spy = vi.fn(fakeChat(VALID_JSON));
    const provider = createRemoteLlmProvider('openai', 'sk-openai', 'gpt-4o-mini', spy);
    const messages: LlmMessage[] = [
      { role: 'system', content: 'be warm' },
      { role: 'user', content: 'how are you' },
    ];
    await provider.complete(messages);
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0]![0];
    expect(arg.apiKey).toBe('sk-openai');
    expect(arg.model).toBe('gpt-4o-mini');
    expect(arg.messages).toEqual(messages);
    expect(arg.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('canned/echo provider — zero-key fallback (R16.4)', () => {
  it('is not live, never touches the network, and echoes the last user turn', async () => {
    const provider = createCannedLlmProvider();
    expect(provider.id).toBe('canned');
    expect(provider.live).toBe(false);

    const out = await provider.complete([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'The nights are hard.' },
    ]);
    expect(modeOutputSchema.safeParse(out).success).toBe(true);
    expect(out.say).toContain(CANNED_SAY_PREFIX);
    expect(out.say).toContain('The nights are hard.');
    // Never invents cards, memory, or safety behavior.
    expect(out.cards).toEqual([]);
    expect(out.memory_ops).toEqual([]);
    expect(out.flags).toEqual(['none']);
  });

  it('streams the canned say as a terminal chunk', async () => {
    const provider = createCannedLlmProvider();
    const chunks: LlmStreamChunk[] = [];
    for await (const c of provider.stream([{ role: 'user', content: 'hi' }])) chunks.push(c);
    expect(chunks.at(-1)?.done).toBe(true);
    expect(chunks.map((c) => c.text).join('')).toContain(CANNED_SAY_PREFIX);
  });

  it('produces a warm default when there is no user message', async () => {
    const provider = createCannedLlmProvider();
    const out = await provider.complete([{ role: 'system', content: 'sys' }]);
    expect(out.say).toContain(CANNED_SAY_PREFIX);
    expect(out.say.length).toBeGreaterThan(0);
  });
});

describe('runMode — 8s timeout + one retry + park-the-turn (R6.2/R6.3)', () => {
  /** Deterministic timers: capture scheduled callbacks and fire them on demand. */
  function fakeTimers() {
    const scheduled = new Map<number, () => void>();
    let id = 0;
    const cleared = new Set<number>();
    const setTimeout = (fn: () => void) => {
      const handle = ++id;
      scheduled.set(handle, fn);
      return handle;
    };
    const clearTimeout = (h: unknown) => {
      cleared.add(h as number);
      scheduled.delete(h as number);
    };
    /** Fire all currently-scheduled (not cleared) timeouts. */
    const fireAll = () => {
      for (const [h, fn] of [...scheduled]) {
        if (!cleared.has(h)) fn();
        scheduled.delete(h);
      }
    };
    return { setTimeout, clearTimeout, fireAll, scheduledCount: () => scheduled.size };
  }

  /** A provider whose complete() resolves/rejects/hangs per a queue of behaviors. */
  function scriptedProvider(behaviors: Array<'resolve' | 'reject' | 'hang'>): {
    provider: LlmProvider;
    calls: () => number;
  } {
    let call = 0;
    const provider: LlmProvider = {
      id: 'scripted',
      live: true,
      stream: () =>
        (async function* () {
          yield { text: VALID_JSON, done: true };
        })(),
      complete: () => {
        const behavior = behaviors[call] ?? 'hang';
        call++;
        if (behavior === 'resolve') {
          return Promise.resolve(modeOutputSchema.parse({ say: 'ok', flags: ['none'] }));
        }
        if (behavior === 'reject') return Promise.reject(new Error('provider boom'));
        return new Promise<never>(() => {}); // hang forever → times out
      },
    };
    return { provider, calls: () => call };
  }

  it('returns the first successful attempt without scheduling a retry', async () => {
    const timers = fakeTimers();
    const { provider, calls } = scriptedProvider(['resolve']);
    const out = await runMode(provider, [{ role: 'user', content: 'hi' }], {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    expect(out.say).toBe('ok');
    expect(calls()).toBe(1);
  });

  it('retries exactly once after a timeout, then succeeds on the retry', async () => {
    const timers = fakeTimers();
    // First attempt hangs (times out), retry resolves.
    const { provider, calls } = scriptedProvider(['hang', 'resolve']);
    const promise = runMode(provider, [{ role: 'user', content: 'hi' }], {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    // Fire the first attempt's timeout → triggers the single retry.
    await Promise.resolve();
    timers.fireAll();
    const out = await promise;
    expect(out.say).toBe('ok');
    expect(calls()).toBe(2);
  });

  it('parks the turn (apology, no cards) after a timeout + a failed retry', async () => {
    const timers = fakeTimers();
    // Both attempts hang → both time out → park the turn.
    const { provider, calls } = scriptedProvider(['hang', 'hang']);
    const promise = runMode(provider, [{ role: 'user', content: 'hi' }], {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    // Drive both attempt timeouts.
    await Promise.resolve();
    timers.fireAll();
    await Promise.resolve();
    timers.fireAll();
    const out = await promise;
    expect(out.say).toBe(PARK_THE_TURN_SAY);
    expect(out.cards).toEqual([]);
    expect(out.flags).toEqual(['none']);
    expect(calls()).toBe(2);
  });

  it('retries once on a provider ERROR (not just timeout), then parks', async () => {
    const timers = fakeTimers();
    const { provider, calls } = scriptedProvider(['reject', 'reject']);
    const out = await runMode(provider, [{ role: 'user', content: 'hi' }], {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    expect(out.say).toBe(PARK_THE_TURN_SAY);
    expect(calls()).toBe(2);
  });

  it('recovers when the first attempt errors and the retry succeeds', async () => {
    const timers = fakeTimers();
    const { provider, calls } = scriptedProvider(['reject', 'resolve']);
    const out = await runMode(provider, [{ role: 'user', content: 'hi' }], {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    expect(out.say).toBe('ok');
    expect(calls()).toBe(2);
  });

  it('defaults the per-attempt timeout to the frozen 8000ms', () => {
    expect(LLM_TIMEOUT_MS).toBe(8000);
  });

  it('parkTheTurnOutput is a valid, card-free ModeOutput', () => {
    const out = parkTheTurnOutput();
    expect(modeOutputSchema.safeParse(out).success).toBe(true);
    expect(out.cards).toEqual([]);
  });

  it('LlmTimeoutError reports the timeout it exceeded', () => {
    const err = new LlmTimeoutError(8000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LlmTimeoutError');
    expect(err.message).toContain('8000');
  });
});

describe('createLlmProvider — resolution from config', () => {
  it('falls back to the canned provider when no LLM key is present', () => {
    const cfg = loadConfig({});
    const chat = vi.fn();
    const provider = createLlmProvider(cfg, chat as unknown as ChatStreamFactory);
    expect(provider.id).toBe('canned');
    expect(provider.live).toBe(false);
    // Canned path never reaches for the chat factory.
    expect(chat).not.toHaveBeenCalled();
  });

  it('uses the canned provider when a key exists but no chat factory is supplied', () => {
    const cfg = loadConfig(ANTHROPIC_ENV);
    const provider = createLlmProvider(cfg);
    expect(provider.id).toBe('canned');
  });

  it('builds a live remote provider from the resolved key + model', async () => {
    const cfg = loadConfig(ANTHROPIC_ENV);
    const chat = vi.fn(fakeChat(VALID_JSON));
    const provider = createLlmProvider(cfg, chat);
    expect(provider.id).toBe('anthropic');
    expect(provider.live).toBe(true);

    await provider.complete([{ role: 'user', content: 'hi' }]);
    const arg = chat.mock.calls[0]![0];
    expect(arg.apiKey).toBe('sk-ant-test');
    expect(arg.model).toBe(cfg.llm.model);
  });
});
