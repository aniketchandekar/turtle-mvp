import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { KbChunk } from '@turtle/shared';
import { SCHEMA_SQL } from '../../store/schema.js';
import { createCipher } from '../../store/crypto.js';
import { createRepositories, type Repositories } from '../../store/repositories.js';
import { loadConfig, type EnvSource } from '../../config.js';
import {
  chunkKbFile,
  chunkMarkdownBody,
  parseFrontMatter,
  estimateTokens,
  TARGET_CHUNK_TOKENS,
} from './chunk.js';
import {
  cosineSimilarity,
  cosineRetrieve,
  lexicalRetrieve,
  lexicalScore,
  DEFAULT_K,
} from './retrieve.js';
import {
  createEmbeddingProvider,
  createLexicalFallbackProvider,
  type EmbedFactory,
} from './embeddings.js';
import { createRagService } from './index.js';

/**
 * RAG subsystem (Task 21, R8.1).
 *
 * All coverage is pure/in-memory — a :memory: SQLite store and fake embedding
 * factories, no network:
 *   - Chunking: ~300-token sizing + `{ diagnosis, source_url, title }` metadata.
 *   - Cosine retrieval: diagnosis filter + top-k (k=4) ranking by similarity.
 *   - Lexical fallback: keyword retrieval when no embedding key is present.
 */

function makeRepos(): Repositories {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return createRepositories(db, createCipher('test-key'));
}

/** Build a KbChunk with a given embedding, for retrieval tests. */
function chunkWith(
  id: string,
  diagnosis: KbChunk['diagnosis'],
  content: string,
  embedding: number[] | null,
): KbChunk {
  return { id, diagnosis, source_url: null, title: null, content_md: content, embedding };
}

// ---------------------------------------------------------------------------
// Chunking (~300 tokens + metadata)
// ---------------------------------------------------------------------------

describe('chunking (~300 tokens + metadata)', () => {
  it('parses front-matter into diagnosis/title/source_url metadata', () => {
    const raw = [
      '---',
      'diagnosis: metastatic_cancer',
      'title: What "metastatic" means',
      'source_url: https://example.org/meta',
      '---',
      '',
      'Body paragraph one.',
      '',
      'Body paragraph two.',
    ].join('\n');

    const parsed = parseFrontMatter(raw);
    expect(parsed.meta.diagnosis).toBe('metastatic_cancer');
    expect(parsed.meta.title).toBe('What "metastatic" means');
    expect(parsed.meta.source_url).toBe('https://example.org/meta');
    expect(parsed.body.startsWith('Body paragraph one.')).toBe(true);
  });

  it('throws when the required diagnosis key is missing', () => {
    const raw = ['---', 'title: No diagnosis here', '---', '', 'Body.'].join('\n');
    expect(() => parseFrontMatter(raw)).toThrow(/diagnosis/);
  });

  it('keeps chunks at or near the ~300-token target', () => {
    // Build a body of many short paragraphs (~30 tokens each) so packing must split.
    const para = Array.from({ length: 22 }, () => 'word').join(' '); // ~22 words ≈ 30 tokens
    const body = Array.from({ length: 30 }, () => para).join('\n\n');

    const chunks = chunkMarkdownBody(body);
    expect(chunks.length).toBeGreaterThan(1);
    // Each packed chunk must not exceed the target once it holds >1 paragraph.
    for (const chunk of chunks) {
      // Allow a single-paragraph overshoot only; multi-paragraph chunks stay <= target.
      const paras = chunk.split('\n\n');
      if (paras.length > 1) {
        expect(estimateTokens(chunk)).toBeLessThanOrEqual(TARGET_CHUNK_TOKENS);
      }
    }
  });

  it('a single over-target paragraph becomes its own chunk (not cut mid-paragraph)', () => {
    const huge = Array.from({ length: 400 }, () => 'word').join(' '); // > 300 tokens
    const chunks = chunkMarkdownBody(huge);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(huge);
  });

  it('attaches file metadata to every chunk and assigns stable ids', () => {
    const raw = [
      '---',
      'diagnosis: metastatic_cancer',
      'title: Symptoms',
      'source_url: https://example.org/symptoms',
      '---',
      '',
      Array.from({ length: 250 }, () => 'alpha').join(' '),
      '',
      Array.from({ length: 250 }, () => 'beta').join(' '),
    ].join('\n');

    const parsed = parseFrontMatter(raw);
    const chunks = chunkKbFile(parsed, 'metastatic-cancer/symptoms.md');

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.diagnosis).toBe('metastatic_cancer');
      expect(chunk.title).toBe('Symptoms');
      expect(chunk.source_url).toBe('https://example.org/symptoms');
      expect(chunk.embedding).toBeNull();
      expect(chunk.id).toMatch(/^[0-9a-f]{24}$/);
    }
    // Deterministic + unique ids per chunk index.
    const ids = new Set(chunks.map((c) => c.id));
    expect(ids.size).toBe(chunks.length);
    const rebuilt = chunkKbFile(parsed, 'metastatic-cancer/symptoms.md');
    expect(rebuilt.map((c) => c.id)).toEqual(chunks.map((c) => c.id));
  });
});

// ---------------------------------------------------------------------------
// Cosine retrieval (diagnosis filter + top-k)
// ---------------------------------------------------------------------------

describe('cosine retrieval (diagnosis filter, k=4)', () => {
  it('cosineSimilarity is 1 for identical, 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('ranks by similarity and returns at most k=4', () => {
    const q = [1, 0, 0];
    const chunks: KbChunk[] = [
      chunkWith('a', 'metastatic_cancer', 'a', [1, 0, 0]), // best
      chunkWith('b', 'metastatic_cancer', 'b', [0.9, 0.1, 0]),
      chunkWith('c', 'metastatic_cancer', 'c', [0.5, 0.5, 0]),
      chunkWith('d', 'metastatic_cancer', 'd', [0.2, 0.8, 0]),
      chunkWith('e', 'metastatic_cancer', 'e', [0, 1, 0]), // worst — should be dropped at k=4
    ];
    const hits = cosineRetrieve(q, chunks, DEFAULT_K);
    expect(hits).toHaveLength(4);
    expect(hits.map((h) => h.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
  });

  it('service filters by diagnosis and returns k=4 via cosine when embeddings live', async () => {
    const repos = makeRepos();
    // Target diagnosis chunks, each embedding "closer" to the query as index grows.
    for (let i = 0; i < 6; i++) {
      repos.kbChunk.upsert(
        chunkWith(`mc-${i}`, 'metastatic_cancer', `mc chunk ${i}`, [i, 6 - i, 0]),
      );
    }
    // A chunk under a different (hypothetical) diagnosis must NOT be returned.
    repos.kbChunk.upsert({
      id: 'other-1',
      diagnosis: 'other_diagnosis' as KbChunk['diagnosis'],
      source_url: null,
      title: null,
      content_md: 'unrelated',
      embedding: [100, 0, 0],
    });

    // Fake embedding provider: query embeds to [1,0,0], so higher-index chunks win.
    const fakeEmbed: EmbedFactory = async ({ texts }) => texts.map(() => [1, 0, 0]);
    const embeddings = createEmbeddingProvider(
      loadConfig({ GEMINI_API_KEY: 'k' } as EnvSource),
      fakeEmbed,
    );
    expect(embeddings.live).toBe(true);

    const rag = createRagService({ repos, embeddings });
    const hits = await rag.retrieve('what is metastatic cancer', 'metastatic_cancer', DEFAULT_K);

    expect(hits).toHaveLength(4);
    // All returned chunks belong to the requested diagnosis (filter honored).
    expect(hits.every((h) => h.diagnosis === 'metastatic_cancer')).toBe(true);
    expect(hits.some((h) => h.id === 'other-1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lexical fallback (no embedding key)
// ---------------------------------------------------------------------------

describe('lexical fallback (no embedding key)', () => {
  it('config reports embeddings degraded with zero keys', () => {
    const cfg = loadConfig({} as EnvSource);
    expect(cfg.capabilities.embeddings.live).toBe(false);
    const provider = createEmbeddingProvider(cfg); // no embed factory
    expect(provider.live).toBe(false);
    expect(provider.id).toBe('none');
  });

  it('lexical fallback provider refuses to embed', async () => {
    const provider = createLexicalFallbackProvider();
    await expect(provider.embed(['x'])).rejects.toThrow(/lexical/i);
  });

  it('lexicalScore rewards keyword overlap and is zero without it', () => {
    const chunk = chunkWith('a', 'metastatic_cancer', 'fatigue and nausea are common', null);
    expect(lexicalScore(['fatigue', 'nausea'], chunk)).toBeGreaterThan(0);
    expect(lexicalScore(['helicopter'], chunk)).toBe(0);
  });

  it('lexicalRetrieve ranks by overlap and caps at k=4', () => {
    const chunks: KbChunk[] = [
      chunkWith('a', 'metastatic_cancer', 'pain pain pain management options', null),
      chunkWith('b', 'metastatic_cancer', 'pain management for patients', null),
      chunkWith('c', 'metastatic_cancer', 'appetite and sleep changes', null),
      chunkWith('d', 'metastatic_cancer', 'fatigue is common', null),
      chunkWith('e', 'metastatic_cancer', 'pain relief and comfort care', null),
    ];
    const hits = lexicalRetrieve('pain management', chunks, DEFAULT_K);
    expect(hits.length).toBeLessThanOrEqual(4);
    expect(hits.length).toBeGreaterThan(0);
    // 'a' and 'b' both mention pain + management → outrank 'c'/'d' which have neither.
    expect(hits[0]!.id === 'a' || hits[0]!.id === 'b').toBe(true);
    expect(hits.some((h) => h.id === 'c')).toBe(false);
  });

  it('service uses lexical retrieval and honors diagnosis filter with no embedding key', async () => {
    const repos = makeRepos();
    repos.kbChunk.upsert(chunkWith('a', 'metastatic_cancer', 'preparing questions for appointments', null));
    repos.kbChunk.upsert(chunkWith('b', 'metastatic_cancer', 'common symptoms like fatigue', null));
    repos.kbChunk.upsert({
      id: 'other',
      diagnosis: 'other_diagnosis' as KbChunk['diagnosis'],
      source_url: null,
      title: null,
      content_md: 'appointments appointments appointments',
      embedding: null,
    });

    const cfg = loadConfig({} as EnvSource);
    const embeddings = createEmbeddingProvider(cfg); // fallback
    const rag = createRagService({ repos, embeddings });
    expect(rag.embeddingsLive).toBe(false);

    const hits = await rag.retrieve('appointments and questions', 'metastatic_cancer', DEFAULT_K);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.diagnosis === 'metastatic_cancer')).toBe(true);
    expect(hits.some((h) => h.id === 'other')).toBe(false);
    expect(hits[0]!.id).toBe('a'); // strongest keyword overlap
  });

  it('returns empty when the diagnosis has no chunks', async () => {
    const repos = makeRepos();
    const rag = createRagService({ repos, embeddings: createLexicalFallbackProvider() });
    const hits = await rag.retrieve('anything', 'metastatic_cancer');
    expect(hits).toEqual([]);
  });
});
