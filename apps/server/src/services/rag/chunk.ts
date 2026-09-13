import crypto from 'node:crypto';
import type { Diagnosis, KbChunk } from '@turtle/shared';

/**
 * KB markdown parsing + chunking (Task 21, R8.1).
 *
 * Turns a curated markdown file under `kb/<diagnosis>/*.md` into ~300-token chunks,
 * each carrying the file's `{ diagnosis, source_url, title }` metadata (design.md
 * §RAG subsystem). The chunker is pure and network-free so it is fully unit-testable.
 *
 * Chunking is boundary-aware: it splits on blank-line paragraph boundaries and packs
 * whole paragraphs into a chunk until adding the next one would exceed the target
 * size. A single paragraph longer than the target becomes its own (over-target)
 * chunk rather than being cut mid-sentence — plain-language KB paragraphs are short
 * enough that this stays close to the ~300-token goal.
 */

/** Target chunk size in tokens (~300 per design.md). */
export const TARGET_CHUNK_TOKENS = 300;

/**
 * Rough token estimate. We deliberately avoid a heavyweight tokenizer dependency:
 * for English prose ~0.75 words/token holds well enough for sizing, so we estimate
 * tokens as words / 0.75 (≈ words * 4 / 3). This only drives chunk packing, not
 * anything user-facing, so an approximation is fine and keeps the build dependency-free.
 */
export function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  return Math.ceil(words / 0.75);
}

/** Metadata carried from a KB file's front-matter onto every chunk it produces. */
export interface KbFrontMatter {
  diagnosis: Diagnosis;
  title: string | null;
  source_url: string | null;
}

/** A parsed KB markdown file: its front-matter plus the body below it. */
export interface ParsedKbFile {
  meta: KbFrontMatter;
  body: string;
}

/**
 * Parse a `---`-delimited front-matter block off the top of a markdown file.
 *
 * Recognizes the keys `diagnosis`, `title`, and `source_url`. `diagnosis` is
 * required (throws when missing) since it is the retrieval filter; `title` and
 * `source_url` are optional and default to null. When there is no front-matter block
 * at all this throws, because a chunk with no diagnosis cannot be retrieved.
 */
export function parseFrontMatter(raw: string): ParsedKbFile {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) {
    throw new Error('KB file is missing a front-matter block (--- ... ---).');
  }

  const fields: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) fields[key] = value;
  }

  const diagnosis = fields.diagnosis;
  if (!diagnosis) {
    throw new Error('KB front-matter is missing the required `diagnosis` key.');
  }

  return {
    meta: {
      diagnosis: diagnosis as Diagnosis,
      title: fields.title ? fields.title : null,
      source_url: fields.source_url ? fields.source_url : null,
    },
    body: normalized.slice(match[0].length).trim(),
  };
}

/**
 * Split a markdown body into ~300-token chunks at paragraph boundaries.
 *
 * Paragraphs (blank-line separated) are packed greedily into a chunk until adding
 * the next paragraph would push the running estimate past {@link TARGET_CHUNK_TOKENS};
 * the chunk is then flushed and a new one started. A lone paragraph already over the
 * target is emitted on its own. Returns the chunk texts in document order.
 */
export function chunkMarkdownBody(body: string, targetTokens = TARGET_CHUNK_TOKENS): string[] {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);
    // Flush the in-progress chunk before starting a paragraph that would overflow it,
    // unless the chunk is still empty (a single over-target paragraph stands alone).
    if (current.length > 0 && currentTokens + paraTokens > targetTokens) {
      chunks.push(current.join('\n\n'));
      current = [];
      currentTokens = 0;
    }
    current.push(para);
    currentTokens += paraTokens;
  }
  if (current.length > 0) chunks.push(current.join('\n\n'));

  return chunks;
}

/**
 * Deterministic chunk id: a stable hash of the file key + chunk index. Stable ids let
 * the build step upsert (re-running the build overwrites the same rows instead of
 * accumulating duplicates).
 */
export function chunkId(fileKey: string, index: number): string {
  return crypto.createHash('sha1').update(`${fileKey}#${index}`).digest('hex').slice(0, 24);
}

/**
 * Chunk one parsed KB file into `KbChunk` rows (without embeddings — those are added
 * by the build step). Each chunk inherits the file's `{ diagnosis, source_url, title }`.
 *
 * @param parsed  - front-matter + body from {@link parseFrontMatter}.
 * @param fileKey - a stable key for the source file (e.g. its relative path), used
 *                  only to derive deterministic chunk ids.
 */
export function chunkKbFile(parsed: ParsedKbFile, fileKey: string): KbChunk[] {
  return chunkMarkdownBody(parsed.body).map((content_md, index) => ({
    id: chunkId(fileKey, index),
    diagnosis: parsed.meta.diagnosis,
    source_url: parsed.meta.source_url,
    title: parsed.meta.title,
    content_md,
    embedding: null,
  }));
}
