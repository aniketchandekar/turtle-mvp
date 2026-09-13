import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TTS_PRESET } from '@turtle/shared';

// Workspace scripts run with `apps/server` as their working directory, while this
// repository keeps its local configuration in the workspace-root `.env`. Resolve
// from this file rather than `process.cwd()` so `npm run dev` and `npm run dev:server`
// load the same values. Shell-provided environment variables still take precedence.
const sourceDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(sourceDir, '../../../.env') });

/**
 * Configuration + degradation layer.
 *
 * Turtle boots with ZERO API keys. Each external capability is optional; when its
 * key is absent the app runs in a documented fallback mode. `capabilities` reports
 * what is live vs degraded so the client and /health can surface it honestly.
 */

/** Environment source. Defaults to `process.env`; injectable for tests. */
export type EnvSource = Record<string, string | undefined>;

function readEnv(source: EnvSource, key: string): string | undefined {
  const v = source[key];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

export interface Capability {
  /** Whether the capability is fully available. */
  live: boolean;
  /** Human-readable description of the fallback when not live. */
  fallback: string;
}

export interface Capabilities {
  asr: Capability; // Deepgram
  tts: Capability; // ElevenLabs
  llm: Capability; // Gemini / Anthropic / OpenAI (provider-abstracted)
  embeddings: Capability; // Gemini / OpenAI
}

/** Which LLM backend powers the orchestrator. Provider-abstracted per tech.md. */
export type LlmProvider = 'gemini' | 'anthropic' | 'openai' | 'none';

export interface Config {
  port: number;
  dbPath: string;
  encryptionKey: string;
  encryptionKeyIsDev: boolean;

  /**
   * Short-silence window (ms) before the conversation state machine auto-advances
   * WAITING → LISTENING for the next turn (R2.5). Kept small so the mic re-arms
   * promptly after the assistant finishes speaking.
   */
  waitingSilenceMs: number;

  /**
   * Look-ahead window (hours) before an appointment within which a session offers a
   * prep briefing (Task 29, R12.2). Default 48h. Read from TURTLE_PREP_WINDOW_HOURS so
   * the window is tunable without a code change, per the config/degradation
   * conventions (R1.4).
   */
  prepWindowHours: number;

  deepgram: { apiKey?: string; model: string };
  elevenlabs: {
    apiKey?: string;
    modelId: string;
    voiceId?: string;
    outputFormat: string;
    /** Frozen Turtle voice settings (see packages/shared TTS_PRESET). */
    voiceSettings: typeof TTS_PRESET.voice_settings;
    /** Frozen streaming chunk schedule for the Turtle preset. */
    chunkLengthSchedule: readonly number[];
  };
  /**
   * LLM configuration. `provider` is resolved from LLM_PROVIDER if set, else
   * auto-detected from whichever key is present (Gemini preferred), else 'none'
   * (canned responses). `apiKey`/`model` reflect the resolved provider.
   *
   * NOTE (safety.md / spec §16): for real caregivers with real PHI, the LLM must be
   * on a BAA/HIPAA-eligible, no-training tier. This applies to every provider
   * (Gemini, Claude, OpenAI) — verify the tier before any real dogfood.
   */
  llm: {
    provider: LlmProvider;
    apiKey?: string;
    model: string;
    gemini: { apiKey?: string; model: string };
    anthropic: { apiKey?: string; model: string };
    openai: { apiKey?: string; model: string };
  };
  embeddings: { provider: 'gemini' | 'openai' | 'none'; apiKey?: string; model: string };

  capabilities: Capabilities;
}

const DEV_ENCRYPTION_KEY = 'turtle-dev-insecure-key-do-not-use-in-prod';

/**
 * Load config from environment variables with documented defaults.
 *
 * NEVER throws on missing keys — a missing secret means the capability degrades,
 * not that the process crashes. Calling this with an empty env source must succeed.
 *
 * @param source - env source (defaults to `process.env`); injectable for tests.
 */
export function loadConfig(source: EnvSource = process.env): Config {
  const env = (key: string) => readEnv(source, key);
  const envOr = (key: string, fallback: string) => env(key) ?? fallback;

  const encFromEnv = env('TURTLE_ENCRYPTION_KEY');
  const encryptionKey = encFromEnv ?? DEV_ENCRYPTION_KEY;

  const deepgramKey = env('DEEPGRAM_API_KEY');
  const elevenKey = env('ELEVENLABS_API_KEY');
  const elevenVoiceId = env('ELEVENLABS_VOICE_ID');
  const geminiKey = env('GEMINI_API_KEY');
  const anthropicKey = env('ANTHROPIC_API_KEY');
  const openaiKey = env('OPENAI_API_KEY');

  const gemini = { apiKey: geminiKey, model: envOr('GEMINI_MODEL', 'gemini-2.5-flash') };
  const anthropic = { apiKey: anthropicKey, model: envOr('ANTHROPIC_MODEL', 'claude-3-5-sonnet-latest') };
  const openai = { apiKey: openaiKey, model: envOr('OPENAI_MODEL', 'gpt-4o-mini') };

  // Resolve the active LLM provider: explicit LLM_PROVIDER wins; otherwise prefer
  // whichever key is present, in order Gemini → Anthropic → OpenAI; else 'none'.
  const requested = env('LLM_PROVIDER')?.toLowerCase() as LlmProvider | undefined;
  const llmProvider: LlmProvider =
    requested && requested !== 'none' && hasKeyFor(requested, { geminiKey, anthropicKey, openaiKey })
      ? requested
      : geminiKey
        ? 'gemini'
        : anthropicKey
          ? 'anthropic'
          : openaiKey
            ? 'openai'
            : 'none';

  const activeLlm =
    llmProvider === 'gemini'
      ? gemini
      : llmProvider === 'anthropic'
        ? anthropic
        : llmProvider === 'openai'
          ? openai
          : { apiKey: undefined, model: '' };

  // Embeddings: reuse Gemini if present, else OpenAI, else lexical fallback.
  const embeddingsProvider: 'gemini' | 'openai' | 'none' = geminiKey
    ? 'gemini'
    : openaiKey
      ? 'openai'
      : 'none';
  const embeddings = {
    provider: embeddingsProvider,
    apiKey: embeddingsProvider === 'gemini' ? geminiKey : embeddingsProvider === 'openai' ? openaiKey : undefined,
    model:
      embeddingsProvider === 'gemini'
        ? envOr('EMBEDDING_MODEL', 'text-embedding-004')
        : envOr('EMBEDDING_MODEL', 'text-embedding-3-small'),
  };

  const capabilities: Capabilities = {
    asr: {
      live: Boolean(deepgramKey),
      fallback: 'Deepgram key missing — using typed text input (text-in, voice-out).',
    },
    tts: {
      live: Boolean(elevenKey && elevenVoiceId),
      fallback: 'ElevenLabs key or voice ID missing — using text-only mode (response shown, not spoken).',
    },
    llm: {
      live: llmProvider !== 'none',
      fallback: 'No LLM key (Gemini/Anthropic/OpenAI) — using canned orchestrator responses.',
    },
    embeddings: {
      live: embeddingsProvider !== 'none',
      fallback: 'No embedding key — using lexical (keyword) retrieval over the KB.',
    },
  };

  return {
    port: Number(envOr('PORT', '8787')),
    dbPath: env('TURTLE_DB_PATH') ?? path.resolve(process.cwd(), 'data', 'turtle.sqlite'),
    encryptionKey,
    encryptionKeyIsDev: !encFromEnv,
    waitingSilenceMs: Number(envOr('TURTLE_WAITING_SILENCE_MS', '400')),
    prepWindowHours: Number(envOr('TURTLE_PREP_WINDOW_HOURS', '48')),

    deepgram: { apiKey: deepgramKey, model: envOr('DEEPGRAM_MODEL', 'nova-3') },
    elevenlabs: {
      apiKey: elevenKey,
      // Frozen preset defaults live in packages/shared; env can override the id/format only.
      modelId: envOr('ELEVENLABS_MODEL_ID', TTS_PRESET.model_id),
      voiceId: elevenVoiceId,
      outputFormat: envOr('ELEVENLABS_OUTPUT_FORMAT', TTS_PRESET.output_format),
      voiceSettings: TTS_PRESET.voice_settings,
      chunkLengthSchedule: TTS_PRESET.chunk_length_schedule,
    },
    llm: {
      provider: llmProvider,
      apiKey: activeLlm.apiKey,
      model: activeLlm.model,
      gemini,
      anthropic,
      openai,
    },
    embeddings,

    capabilities,
  };
}

/** True if the requested provider has a key available. */
function hasKeyFor(
  provider: LlmProvider,
  keys: { geminiKey?: string; anthropicKey?: string; openaiKey?: string },
): boolean {
  if (provider === 'gemini') return Boolean(keys.geminiKey);
  if (provider === 'anthropic') return Boolean(keys.anthropicKey);
  if (provider === 'openai') return Boolean(keys.openaiKey);
  return false;
}

/** Log a concise, honest startup summary of what is live vs degraded. */
export function describeCapabilities(cfg: Config): string[] {
  const lines: string[] = [];
  const mark = (name: string, cap: Capability) =>
    lines.push(`  ${cap.live ? '✓' : '○'} ${name}: ${cap.live ? 'live' : cap.fallback}`);
  mark('ASR (Deepgram)', cfg.capabilities.asr);
  mark('TTS (ElevenLabs)', cfg.capabilities.tts);
  const llmName =
    cfg.llm.provider === 'none'
      ? 'LLM'
      : `LLM (${cfg.llm.provider} ${cfg.llm.model})`;
  mark(llmName, cfg.capabilities.llm);
  mark(`Embeddings${cfg.embeddings.provider !== 'none' ? ` (${cfg.embeddings.provider})` : ''}`, cfg.capabilities.embeddings);
  if (cfg.encryptionKeyIsDev) {
    lines.push('  ! Encryption: using DEV key (set TURTLE_ENCRYPTION_KEY for real use).');
  }
  return lines;
}
