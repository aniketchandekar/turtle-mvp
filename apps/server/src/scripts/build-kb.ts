import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { createStore } from '../store/index.js';
import { chunkKbFile, parseFrontMatter } from '../services/rag/chunk.js';
import { createEmbeddingProviderFromConfig } from '../services/rag/embeddings-sdk.js';
import type { KbChunk } from '@turtle/shared';

/**
 * KB build step (Task 21, R8.1).
 *
 * Reads the curated markdown under `kb/<diagnosis>/*.md`, chunks each file into
 * ~300-token sections with `{ diagnosis, source_url, title }` metadata, computes
 * embeddings when an embedding provider is available, and upserts the chunks into the
 * `kb_chunk` table via the existing store.
 *
 * Degradation is first-class: with NO embedding key the chunks are written with
 * `embedding = null` and retrieval falls back to lexical (keyword) search. The build
 * therefore succeeds with zero API keys.
 *
 * Run with: `npm run kb:build --workspace @turtle/server`
 */

/** Resolve the repo-root `kb/` directory from this file's location. */
function resolveKbDir(): string {
  // dist/scripts or src/scripts → repo root is four levels up (…/apps/server/{dist|src}/scripts).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..', '..', '..');
  return path.join(repoRoot, 'kb');
}

/** Recursively collect `*.md` files under a directory (excluding the top-level README). */
function collectMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const kbDir = resolveKbDir();

  if (!fs.existsSync(kbDir)) {
    console.error(`KB directory not found: ${kbDir}`);
    process.exit(1);
  }

  // Only chunk files inside diagnosis subfolders; skip the top-level README.
  const files = collectMarkdownFiles(kbDir).filter(
    (f) => path.dirname(f) !== kbDir,
  );
  if (files.length === 0) {
    console.error(`No KB markdown files found under ${kbDir}/<diagnosis>/`);
    process.exit(1);
  }

  // Parse + chunk every file first so we can embed all chunk texts in one batch.
  const allChunks: KbChunk[] = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const fileKey = path.relative(kbDir, file);
    try {
      const parsed = parseFrontMatter(raw);
      allChunks.push(...chunkKbFile(parsed, fileKey));
    } catch (err) {
      console.error(`Skipping ${fileKey}: ${(err as Error).message}`);
    }
  }

  const embeddings = createEmbeddingProviderFromConfig(cfg);
  if (embeddings.live) {
    console.log(`Embedding ${allChunks.length} chunks via ${embeddings.id}…`);
    const vectors = await embeddings.embed(allChunks.map((c) => c.content_md));
    allChunks.forEach((chunk, i) => {
      chunk.embedding = vectors[i] ?? null;
    });
  } else {
    console.log('No embedding key — writing chunks for lexical (keyword) retrieval.');
  }

  const store = createStore(cfg.dbPath, cfg.encryptionKey);
  for (const chunk of allChunks) store.repos.kbChunk.upsert(chunk);

  const mode = embeddings.live ? `embedded (${embeddings.id})` : 'lexical fallback';
  console.log(
    `KB build complete: ${allChunks.length} chunks from ${files.length} files → ${cfg.dbPath} [${mode}].`,
  );
}

main().catch((err) => {
  console.error('KB build failed:', err);
  process.exit(1);
});
