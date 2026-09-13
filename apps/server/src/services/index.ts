/**
 * Services module (design.md §Module boundaries).
 *
 * Home of the cross-cutting services the Orchestrator composes: persistence
 * (store), memory & context assembly, RAG retrieval, the card service, and the
 * LLM provider adapter. This is one logical half of the "single Node service"
 * split — kept separable so it can be lifted into its own process later without
 * reshaping call sites.
 *
 * Phase 0 status: the store is real (Task 4) and re-exported here so callers can
 * depend on `services/` as the boundary rather than reaching into `store/`
 * directly. The service seams (LLM, memory, RAG, cards) are filled in Phase 2+
 * (Tasks 14, 15, 19, 21, 23).
 */

// ---- Store (Task 4, complete) ----
// Re-exported so the store lives under `services/` conceptually without moving
// files or churning existing imports (index.ts / routes.ts still import from
// '../store/index.js' and keep working).
export { createStore } from '../store/index.js';
export type { Store, Repositories } from '../store/index.js';

// ---- LLM provider adapter (Task 14, complete) ----
export {
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
} from './llm/index.js';
export type {
  LlmProvider,
  LlmMessage,
  LlmStreamChunk,
  ChatStreamFactory,
  LlmRunOptions,
} from './llm/index.js';

// ---- Memory & context assembly (Task 19, complete) ----
export {
  createMemoryService,
  assembleProfileFacts,
  assembleRecentSummaries,
  assembleRecall,
  recallLine,
  relativeWhen,
  MAX_RECENT_SUMMARIES,
  RECALL_LOOKBACK_DAYS,
  MAX_RECALL_LINES,
} from './memory/index.js';
export type {
  MemoryService,
  AssembledContext,
  AssembleOptions,
  MemoryServiceDeps,
} from './memory/index.js';

// ---- RAG retrieval (Task 21, complete) ----
export {
  createRagService,
  cosineSimilarity,
  cosineRetrieve,
  lexicalRetrieve,
  lexicalScore,
  lexicalTokens,
  createEmbeddingProvider,
  createRemoteEmbeddingProvider,
  createLexicalFallbackProvider,
  chunkKbFile,
  chunkMarkdownBody,
  parseFrontMatter,
  estimateTokens,
  chunkId,
  TARGET_CHUNK_TOKENS,
  DEFAULT_K,
} from './rag/index.js';
export type {
  RagService,
  RetrievedChunk,
  RagServiceDeps,
  EmbeddingProvider,
  EmbedFactory,
  KbFrontMatter,
  ParsedKbFile,
} from './rag/index.js';
export { createEmbeddingProviderFromConfig } from './rag/embeddings-sdk.js';

// ---- Card service & lifecycle (Task 23, complete) ----
export {
  createCardService,
  isArchivedStatus,
  ARCHIVED_STATUS,
  ARCHIVE_STATUSES,
  SUPERSEDED_STATUS,
} from './cards/index.js';
export type {
  CardService,
  CardServiceDeps,
  CardListStatus,
  ArchivedStatus,
} from './cards/index.js';
