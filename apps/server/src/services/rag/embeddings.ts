import type { Config } from '../../config.js';

/**
 * Embedding provider adapter (Task 21).
 *
 * Provider-abstracted like the LLM adapter: one small interface, a remote provider
 * bound to the resolved key/model, and a documented fallback for zero-key boots.
 * Turtle must run with NO embedding key — in that case `createEmbeddingProvider`
 * returns a provider whose `live` is false and whose `embed()` throws, signalling the
 * RAG layer to use lexical (keyword) retrieval instead. The network/SDK is reached
 * only through an injectable `embed` factory, so this module is unit-testable with
 * fakes and zero network (mirroring the ASR/TTS/LLM edges).
 */

/** A provider that turns text into embedding vectors. */
export interface EmbeddingProvider {
  /** Provider id ('gemini' | 'openai' | 'none') for logging. */
  readonly id: string;
  /** True when a real key-backed provider is available; false = lexical fallback. */
  readonly live: boolean;
  /**
   * Embed a batch of texts, returning one vector per input in order. Throws when the
   * provider is not live — callers must check `live` first and fall back to lexical
   * retrieval.
   */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Provider-neutral batch embedding function. Concrete backends (Gemini / OpenAI)
 * adapt their SDK to this shape at the composition edge; tests inject a fake.
 */
export type EmbedFactory = (
  opts: { provider: 'gemini' | 'openai'; apiKey: string; model: string; texts: string[] },
) => Promise<number[][]>;

/**
 * The lexical-fallback provider used when no embedding key is present. Always
 * reports `live: false` and refuses to embed, so the RAG layer routes to keyword
 * retrieval. The app boots and Q&A retrieval works with zero keys.
 */
export function createLexicalFallbackProvider(): EmbeddingProvider {
  return {
    id: 'none',
    live: false,
    async embed(): Promise<number[][]> {
      throw new Error('No embedding provider — use lexical retrieval instead.');
    },
  };
}

/**
 * Build a real, key-backed embedding provider. Provider-neutral: the concrete SDK is
 * injected as `embed`, so Gemini or OpenAI flow through the same code path.
 */
export function createRemoteEmbeddingProvider(
  provider: 'gemini' | 'openai',
  apiKey: string,
  model: string,
  embed: EmbedFactory,
): EmbeddingProvider {
  return {
    id: provider,
    live: true,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      return embed({ provider, apiKey, model, texts });
    },
  };
}

/**
 * Resolve the active embedding provider from config. Returns the lexical-fallback
 * provider when the embeddings capability is degraded (no key), else a remote
 * provider bound to the resolved provider/key/model. The `embed` factory is required
 * only for the remote path; the composition root supplies the real SDK adapter,
 * tests supply a fake.
 *
 * @param cfg   - loaded config (reads `embeddings.provider` / `.apiKey` / `.model`).
 * @param embed - batch embedding factory for the remote path (optional in fallback mode).
 */
export function createEmbeddingProvider(cfg: Config, embed?: EmbedFactory): EmbeddingProvider {
  const { provider, apiKey, model } = cfg.embeddings;
  if (!cfg.capabilities.embeddings.live || provider === 'none' || !apiKey || !embed) {
    return createLexicalFallbackProvider();
  }
  return createRemoteEmbeddingProvider(provider, apiKey, model, embed);
}
