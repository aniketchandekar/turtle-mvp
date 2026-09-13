# Knowledge Base (KB)

Curated, plain-language reference material used by Turtle's RAG subsystem (Task 21).

## Layout

```
kb/
  <diagnosis>/
    *.md
```

One folder per diagnosis vertical. The MVP seeds a single vertical:
`metastatic-cancer/` (diagnosis id `metastatic_cancer`).

## File format

Each markdown file begins with a small front-matter block delimited by `---`:

```markdown
---
diagnosis: metastatic_cancer
title: What "metastatic" means
source_url: https://www.cancer.gov/types/metastatic-cancer
---

# What "metastatic" means

Plain-language body copy...
```

Front-matter keys:

| Key | Required | Meaning |
|-----|----------|---------|
| `diagnosis` | yes | Diagnosis id (must match a value in `DIAGNOSES`). |
| `title` | yes | Human-readable section title, carried onto every chunk. |
| `source_url` | no | Attribution link, carried onto every chunk. |

The body below the front-matter is chunked into ~300-token sections at heading /
paragraph boundaries. Each chunk inherits `{ diagnosis, source_url, title }`.

## Rebuilding embeddings

After editing KB files, rebuild the `kb_chunk` table:

```bash
npm run kb:build --workspace @turtle/server
```

With an embedding key present (`GEMINI_API_KEY` or `OPENAI_API_KEY`), chunks are
stored with embedding vectors for cosine retrieval. With no key, chunks are stored
with `embedding = NULL` and retrieval degrades to lexical (keyword) search — the app
must run with zero keys.

## Content note

This copy is general, plain-language education written for caregivers. It is NOT
medical advice, dosing, prognosis, or triage guidance — those are hard-refused by the
safety layer. Attribution URLs point to reputable public sources for provenance.
