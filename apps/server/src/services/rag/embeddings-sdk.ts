import type { Config } from '../../config.js';
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbedFactory,
} from './embeddings.js';

/**
 * Network edge for the embedding provider (Task 21).
 *
 * This is the ONLY module that makes a real embedding HTTP request. It adapts the
 * Gemini and OpenAI embedding endpoints to the small `EmbedFactory` shape the RAG
 * layer (and its tests) depend on, then builds the provider with that factory. The
 * API key is read from config here and never leaves the server (R16 privacy posture).
 *
 * Uses `fetch` directly to avoid adding an SDK dependency for a single endpoint.
 */

const GEMINI_HOST = 'https://generativelanguage.googleapis.com';
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

/** Embed a batch via the selected provider's HTTP endpoint. */
const httpEmbedFactory: EmbedFactory = async (opts): Promise<number[][]> => {
  if (opts.provider === 'gemini') return embedGemini(opts.apiKey, opts.model, opts.texts);
  return embedOpenAi(opts.apiKey, opts.model, opts.texts);
};

/** Gemini batch embeddings via `:batchEmbedContents`. */
async function embedGemini(apiKey: string, model: string, texts: string[]): Promise<number[][]> {
  const url = `${GEMINI_HOST}/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
      })),
    }),
  });
  if (!res.ok) throw new Error(`Gemini embeddings failed: ${res.status}`);
  const json = (await res.json()) as { embeddings?: Array<{ values: number[] }> };
  const embeddings = json.embeddings ?? [];
  if (embeddings.length !== texts.length) {
    throw new Error(`Gemini returned ${embeddings.length} embeddings for ${texts.length} inputs.`);
  }
  return embeddings.map((e) => e.values);
}

/** OpenAI batch embeddings via `/v1/embeddings`. */
async function embedOpenAi(apiKey: string, model: string, texts: string[]): Promise<number[][]> {
  const res = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) throw new Error(`OpenAI embeddings failed: ${res.status}`);
  const json = (await res.json()) as { data?: Array<{ index: number; embedding: number[] }> };
  const data = json.data ?? [];
  if (data.length !== texts.length) {
    throw new Error(`OpenAI returned ${data.length} embeddings for ${texts.length} inputs.`);
  }
  // Preserve input order regardless of response ordering.
  return [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

/**
 * Build the embedding provider using the real HTTP transport. Returns a provider
 * whose `live` flag mirrors config; when no embedding key is present it degrades to
 * the lexical-fallback provider (which the RAG layer routes to keyword retrieval).
 */
export function createEmbeddingProviderFromConfig(cfg: Config): EmbeddingProvider {
  return createEmbeddingProvider(cfg, httpEmbedFactory);
}
