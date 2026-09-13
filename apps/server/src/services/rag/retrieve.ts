import type { Diagnosis, KbChunk } from '@turtle/shared';
import type { RetrievedChunk } from './index.js';

/**
 * KB retrieval scoring (Task 21, R8.1).
 *
 * Two pure, network-free strategies over the diagnosis-filtered chunk set:
 *   - cosine similarity over embedding vectors (used when embeddings are live), and
 *   - a lexical (keyword-overlap) score over chunk content (the zero-key fallback).
 *
 * Both return the top-k chunks (k=4 by default) as `RetrievedChunk`s. The diagnosis
 * filter itself is applied by the caller via the store (`kbChunk.listByDiagnosis`),
 * so these functions score an already-filtered candidate list.
 */

/** Default retrieval depth (R8.1: "top-k (k=4)"). */
export const DEFAULT_K = 4;

/** Cosine similarity of two equal-length vectors. Returns 0 for degenerate inputs. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Map a scored chunk to the public `RetrievedChunk` shape. */
function toRetrieved(chunk: KbChunk, score: number): RetrievedChunk {
  return {
    id: chunk.id,
    text: chunk.content_md,
    diagnosis: chunk.diagnosis as Diagnosis,
    score,
  };
}

/**
 * Rank chunks by cosine similarity to a query embedding and return the top-k.
 *
 * Chunks with no stored embedding are skipped (they cannot be scored this way).
 * Ties are broken by original order for determinism.
 */
export function cosineRetrieve(
  queryEmbedding: number[],
  chunks: KbChunk[],
  k = DEFAULT_K,
): RetrievedChunk[] {
  const scored = chunks
    .map((chunk, index) => ({ chunk, index }))
    .filter(({ chunk }) => chunk.embedding != null && chunk.embedding.length > 0)
    .map(({ chunk, index }) => ({
      index,
      retrieved: toRetrieved(chunk, cosineSimilarity(queryEmbedding, chunk.embedding!)),
    }));

  return topK(scored, k);
}

/**
 * Tokenize text into lowercase word tokens for lexical scoring. Deliberately simple:
 * lowercase, split on non-alphanumerics, drop very short tokens.
 */
export function lexicalTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

/**
 * Lexical (keyword-overlap) score of a chunk against a query token multiset. Counts
 * how many query tokens appear in the chunk, weighted by frequency, normalized by
 * query length so longer queries do not dominate. Zero when there is no overlap.
 */
export function lexicalScore(queryTokens: string[], chunk: KbChunk): number {
  if (queryTokens.length === 0) return 0;
  const chunkCounts = new Map<string, number>();
  for (const t of lexicalTokens(chunk.content_md)) {
    chunkCounts.set(t, (chunkCounts.get(t) ?? 0) + 1);
  }
  let overlap = 0;
  for (const qt of queryTokens) {
    const c = chunkCounts.get(qt);
    if (c) overlap += 1 + Math.log(c); // diminishing weight for repeats
  }
  return overlap / queryTokens.length;
}

/**
 * Rank chunks by lexical keyword overlap with the query and return the top-k. Used as
 * the zero-key fallback so Q&A retrieval works with no embedding provider. Chunks
 * with a zero score are excluded (no keyword overlap → not relevant).
 */
export function lexicalRetrieve(query: string, chunks: KbChunk[], k = DEFAULT_K): RetrievedChunk[] {
  const queryTokens = lexicalTokens(query);
  const scored = chunks
    .map((chunk, index) => ({ index, retrieved: toRetrieved(chunk, lexicalScore(queryTokens, chunk)) }))
    .filter(({ retrieved }) => retrieved.score > 0);

  return topK(scored, k);
}

/** Sort by score desc (stable on original index) and take the first k. */
function topK(
  scored: Array<{ index: number; retrieved: RetrievedChunk }>,
  k: number,
): RetrievedChunk[] {
  return scored
    .sort((a, b) => b.retrieved.score - a.retrieved.score || a.index - b.index)
    .slice(0, Math.max(0, k))
    .map((s) => s.retrieved);
}
