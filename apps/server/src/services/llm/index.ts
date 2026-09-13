import { modeOutputSchema, type ModeOutput } from '@turtle/shared';
import type { Config } from '../../config.js';

/**
 * LLM provider adapter (Task 14).
 *
 * Provider-abstracted (Anthropic Claude default, GPT/Gemini swappable) behind ONE
 * interface with streaming support, resolved via `config.llm.provider` so any
 * backend — or the canned fallback — can be swapped in without touching the
 * orchestrator (design.md §Module boundaries; tech.md: "Anthropic Claude default,
 * behind a provider abstraction (GPT-swappable)").
 *
 * Three behaviors are frozen here:
 *   1. Streaming: every provider exposes `stream()`, and `complete()` is defined in
 *      terms of it (drain the stream, assemble the JSON, parse into a `ModeOutput`).
 *   2. Timeout + retry + park-the-turn (R6.2/R6.3): `runMode()` wraps any provider
 *      with an 8s timeout and exactly ONE retry ("let me think for a second"); if
 *      the retry also times out or errors, it PARKS THE TURN with a safe apology
 *      line and NO cards. This mirrors the orchestrator error-handling rule:
 *      "LLM timeout (>8s) — one retry; then apologize and park the turn."
 *   3. Canned/echo fallback (R16.4): when no LLM key is present
 *      (`config.capabilities.llm.live === false`) the app still boots and the
 *      pipeline/cards can be exercised with a canned provider that echoes the user
 *      turn. The app boots with zero keys.
 *
 * As with the ASR/TTS providers, the network/SDK is reached only through an
 * injectable `chat` factory. That keeps this module free of any real SDK import or
 * socket, so the unit tests drive the whole surface (streaming, timeout, retry,
 * park-the-turn, canned) with fakes and zero network.
 */

/** A chat message in the provider-neutral shape. */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** One streamed fragment of an assistant response. */
export interface LlmStreamChunk {
  /** Incremental text delta. */
  text: string;
  /** True on the terminal fragment of the stream. */
  done: boolean;
}

export interface LlmProvider {
  /** Provider id (e.g. 'anthropic', 'openai', 'gemini', 'canned') for logging. */
  readonly id: string;
  /** True when a real key-backed provider is available; false for the canned fallback. */
  readonly live: boolean;
  /**
   * Run a routed mode prompt and produce a mode output (say/cards/memory_ops/flags).
   * The orchestrator validates the result against the Zod contract before speaking.
   */
  complete(messages: LlmMessage[]): Promise<ModeOutput>;
  /** Streaming variant used by the gateway for low-latency TTS. */
  stream(messages: LlmMessage[]): AsyncIterable<LlmStreamChunk>;
}

/**
 * Provider-neutral streaming chat function. A single call streams the assistant's
 * response as text deltas. Concrete backends (Anthropic / OpenAI / Gemini) adapt
 * their SDK to this shape at the composition edge; tests inject a fake.
 *
 * `signal` lets the timeout wrapper abort an in-flight request cleanly.
 */
export type ChatStreamFactory = (
  opts: { apiKey: string; model: string; messages: LlmMessage[]; signal: AbortSignal },
) => AsyncIterable<LlmStreamChunk>;

/** Timeout/retry knobs. Defaults match the frozen tech/error-handling rules. */
export interface LlmRunOptions {
  /** Per-attempt timeout (ms). Frozen at 8000ms (R6.2). */
  timeoutMs?: number;
  /** Injectable timers so tests don't wait on real wall-clock time. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** Frozen per-attempt LLM timeout: >8s parks the turn (design.md error handling). */
export const LLM_TIMEOUT_MS = 8000;

/**
 * The park-the-turn apology used after a timeout + one retry both fail. Warm, brief,
 * and carries NO cards (R6.3) — this is the "let me apologize and park the turn" path.
 */
export const PARK_THE_TURN_SAY =
  "Sorry — I got a little tangled up just now. Could you say that once more?";

/** A park-the-turn mode output: apology line, no cards, no memory ops, no flags. */
export function parkTheTurnOutput(): ModeOutput {
  return { say: PARK_THE_TURN_SAY, cards: [], memory_ops: [], flags: ['none'] };
}

/** Error thrown when a single attempt exceeds the per-attempt timeout. */
export class LlmTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`LLM attempt exceeded ${timeoutMs}ms`);
    this.name = 'LlmTimeoutError';
  }
}

/** Drain a stream into the full concatenated text. */
async function drain(stream: AsyncIterable<LlmStreamChunk>): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    text += chunk.text;
  }
  return text;
}

/**
 * Parse a provider's raw text into a `ModeOutput`.
 *
 * The mode prompts instruct the model to emit the JSON contract subset. We tolerate
 * models that wrap the JSON in prose/markdown fences by extracting the first {...}
 * block. Throws when no valid `ModeOutput` can be recovered so the caller can retry.
 */
export function parseModeOutput(raw: string): ModeOutput {
  const json = extractJsonObject(raw);
  if (json === null) throw new Error('LLM response did not contain a JSON object');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('LLM response JSON was not parseable');
  }
  // Zod fills defaults for cards/memory_ops/flags and rejects malformed shapes.
  return modeOutputSchema.parse(parsed);
}

/** Extract the first balanced top-level JSON object substring, or null. */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Run a routed mode prompt with the frozen resilience policy:
 *   attempt → (timeout/error) → ONE retry → (timeout/error) → park the turn.
 *
 * Returns a `ModeOutput`. On the park-the-turn path it returns {@link parkTheTurnOutput}
 * (apology, no cards) instead of throwing, so the orchestrator can always speak.
 *
 * @param provider - the resolved LLM provider (real or canned).
 * @param messages - the routed mode prompt messages.
 * @param options  - timeout + injectable timers (defaults: 8000ms, real timers).
 */
export async function runMode(
  provider: LlmProvider,
  messages: LlmMessage[],
  options: LlmRunOptions = {},
): Promise<ModeOutput> {
  const timeoutMs = options.timeoutMs ?? LLM_TIMEOUT_MS;
  const setT = options.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearT = options.clearTimeout ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));

  // Up to TWO attempts total: the initial call and one "let me think for a second"
  // retry. Any timeout OR error on an attempt is retried once, then parked.
  for (let tryIndex = 0; tryIndex < 2; tryIndex++) {
    try {
      return await withTimeout(provider.complete(messages), timeoutMs, setT, clearT);
    } catch {
      // Fall through to retry; on the second failure we park the turn below.
    }
  }
  return parkTheTurnOutput();
}

/**
 * Race a promise against a timeout. Rejects with {@link LlmTimeoutError} if the
 * timeout wins. The underlying request is best-effort abandoned (the provider's own
 * AbortSignal handling lives in the concrete `chat` factory).
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  setT: NonNullable<LlmRunOptions['setTimeout']>,
  clearT: NonNullable<LlmRunOptions['clearTimeout']>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const handle = setT(() => {
      if (settled) return;
      settled = true;
      reject(new LlmTimeoutError(timeoutMs));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearT(handle);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearT(handle);
        reject(err);
      },
    );
  });
}

// ----------------------------------------------------------------------------
// Canned/echo fallback provider (R16.4) — used when no LLM key is present.
// ----------------------------------------------------------------------------

/** Prefix the canned provider uses so its output is obviously a dev stand-in. */
export const CANNED_SAY_PREFIX = "I hear you.";

/**
 * Build a text `say` from the latest user message. Echoes the caregiver's words back
 * so the pipeline and cards can be exercised with zero keys — never invents cards,
 * memory, or safety behavior.
 */
function cannedSayFor(messages: LlmMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const echo = lastUser?.content.trim();
  return echo && echo.length > 0
    ? `${CANNED_SAY_PREFIX} You said: "${echo}".`
    : `${CANNED_SAY_PREFIX} I'm here whenever you'd like to talk.`;
}

/**
 * The canned/echo provider. Always available (`live: false`), never touches a
 * network, and yields a valid `ModeOutput` so the orchestrator + card pipeline run
 * end-to-end in dev. Streams the canned text as a single terminal chunk.
 */
export function createCannedLlmProvider(): LlmProvider {
  const streamCanned = async function* (messages: LlmMessage[]): AsyncIterable<LlmStreamChunk> {
    yield { text: cannedSayFor(messages), done: true };
  };
  return {
    id: 'canned',
    live: false,
    async complete(messages: LlmMessage[]): Promise<ModeOutput> {
      return { say: cannedSayFor(messages), cards: [], memory_ops: [], flags: ['none'] };
    },
    stream(messages: LlmMessage[]): AsyncIterable<LlmStreamChunk> {
      return streamCanned(messages);
    },
  };
}

// ----------------------------------------------------------------------------
// Remote provider (Anthropic / OpenAI / Gemini) behind the injectable chat factory.
// ----------------------------------------------------------------------------

/**
 * Build a real, key-backed LLM provider. Provider-neutral: the concrete SDK is
 * injected as `chat`, so Anthropic (default), OpenAI, or Gemini all flow through the
 * same code path. `complete()` drains the stream and parses the JSON `ModeOutput`.
 *
 * @param id      - provider id for logging ('anthropic' | 'openai' | 'gemini').
 * @param apiKey  - resolved provider key (held in the service layer, never client-side).
 * @param model   - resolved model id.
 * @param chat    - injectable streaming chat function (tests supply a fake).
 */
export function createRemoteLlmProvider(
  id: string,
  apiKey: string,
  model: string,
  chat: ChatStreamFactory,
): LlmProvider {
  const openStream = (messages: LlmMessage[]): AsyncIterable<LlmStreamChunk> => {
    const controller = new AbortController();
    return chat({ apiKey, model, messages, signal: controller.signal });
  };
  return {
    id,
    live: true,
    async complete(messages: LlmMessage[]): Promise<ModeOutput> {
      const raw = await drain(openStream(messages));
      return parseModeOutput(raw);
    },
    stream(messages: LlmMessage[]): AsyncIterable<LlmStreamChunk> {
      return openStream(messages);
    },
  };
}

/**
 * Resolve the active LLM provider from config. Returns the canned/echo provider when
 * the LLM capability is degraded (no key), else a remote provider bound to the
 * resolved key + model. The `chat` factory is required only for the remote path; the
 * caller (composition root) supplies the real SDK adapter, tests supply a fake.
 *
 * @param cfg  - loaded config (reads `llm.provider` / `llm.apiKey` / `llm.model`).
 * @param chat - streaming chat factory for the remote path (optional in canned mode).
 */
export function createLlmProvider(cfg: Config, chat?: ChatStreamFactory): LlmProvider {
  const { provider, apiKey, model } = cfg.llm;
  if (!cfg.capabilities.llm.live || provider === 'none' || !apiKey || !chat) {
    return createCannedLlmProvider();
  }
  return createRemoteLlmProvider(provider, apiKey, model, chat);
}
