import type { Diagnosis } from '@turtle/shared';
import type { Repositories } from '../../store/index.js';
import type { EmbeddingProvider } from './embeddings.js';
import { cosineRetrieve, lexicalRetrieve, DEFAULT_K } from './retrieve.js';

/**
 * RAG retrieval service (Tasks 21, 22).
 *
 * Curated plain-language KB chunks per diagnosis vertical, retrieved by cosine
 * similarity over in-process embeddings (k=4, diagnosis-filtered). With no embedding
 * key the service degrades to lexical (keyword) retrieval — retrieval must work with
 * zero keys (tech.md: "no embeddings → lexical retrieval"). Q&A grounding (Task 22)
 * drops any factual sentence that maps to no retrieved chunk.
 *
 * Task 21 lands the build step + cosine/lexical retrieval. Everything is injectable
 * (store repos + embedding provider) so the whole surface is unit-testable with zero
 * network, matching the sibling services.
 */

export interface RetrievedChunk {
  id: string;
  text: string;
  diagnosis: Diagnosis;
  /** Similarity or lexical score; higher is more relevant. */
  score: number;
}

export interface RagService {
  /** True when embedding-backed retrieval is available; false = lexical fallback. */
  readonly embeddingsLive: boolean;
  /** Retrieve up to k chunks relevant to the query, filtered by diagnosis. */
  retrieve(query: string, diagnosis: Diagnosis, k?: number): Promise<RetrievedChunk[]>;
}

/** Dependencies for the RAG service (DI style, mirroring the sibling services). */
export interface RagServiceDeps {
  repos: Repositories;
  /** Resolved embedding provider (real when a key is present, else lexical fallback). */
  embeddings: EmbeddingProvider;
}

/**
 * Create the RAG retrieval service.
 *
 * Retrieval always starts by loading the diagnosis-filtered candidate chunks from the
 * store, then ranks them:
 *   - embeddings live → embed the query and rank by cosine similarity;
 *   - embeddings degraded (no key) → rank by lexical keyword overlap.
 * If embedding the query fails at runtime despite a live provider, it falls back to
 * lexical retrieval rather than failing the turn.
 *
 * @param deps - store repos + embedding provider.
 */
export function createRagService(deps: RagServiceDeps): RagService {
  const { repos, embeddings } = deps;

  return {
    embeddingsLive: embeddings.live,

    async retrieve(query: string, diagnosis: Diagnosis, k = DEFAULT_K): Promise<RetrievedChunk[]> {
      const candidates = repos.kbChunk.listByDiagnosis(diagnosis);
      if (candidates.length === 0 || k <= 0) return [];

      if (embeddings.live) {
        try {
          const [queryEmbedding] = await embeddings.embed([query]);
          if (queryEmbedding && queryEmbedding.length > 0) {
            const hits = cosineRetrieve(queryEmbedding, candidates, k);
            // If none of the candidates carried embeddings (e.g. built in lexical
            // mode), fall through to lexical rather than returning nothing.
            if (hits.length > 0) return hits;
          }
        } catch {
          // Embedding call failed at runtime — degrade to lexical for this turn.
        }
      }

      return lexicalRetrieve(query, candidates, k);
    },
  };
}

export { DEFAULT_K } from './retrieve.js';
export {
  cosineSimilarity,
  cosineRetrieve,
  lexicalRetrieve,
  lexicalScore,
  lexicalTokens,
} from './retrieve.js';
export {
  createEmbeddingProvider,
  createRemoteEmbeddingProvider,
  createLexicalFallbackProvider,
} from './embeddings.js';
export type { EmbeddingProvider, EmbedFactory } from './embeddings.js';
export {
  chunkKbFile,
  chunkMarkdownBody,
  parseFrontMatter,
  estimateTokens,
  chunkId,
  TARGET_CHUNK_TOKENS,
} from './chunk.js';
export type { KbFrontMatter, ParsedKbFile } from './chunk.js';
