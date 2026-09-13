import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { QA_DECLINE_LINE, modeOutputSchema, type Diagnosis, type ModeOutput } from '@turtle/shared';
import { SCHEMA_SQL } from '../../store/schema.js';
import { createCipher } from '../../store/crypto.js';
import { createRepositories, type Repositories } from '../../store/repositories.js';
import type { LlmMessage, LlmProvider, LlmStreamChunk } from '../../services/llm/index.js';
import {
  createLexicalFallbackProvider,
  createRagService,
  type RagService,
} from '../../services/rag/index.js';
import type {
  AssembledContext,
  AssembleOptions,
  MemoryService,
} from '../../services/memory/index.js';
import { runQa, type QaDeps } from '../qa.js';
import { GOLDEN_QUESTIONS, type DiagnosisGoldenSet } from './golden-questions.js';

/**
 * THE Q&A GROUNDING EVAL HARNESS (Task 35, R8.1–R8.4 / R15.2).
 *
 * This is the grounding gate the spec requires: prompt or Q&A-grounding changes MUST pass
 * this suite before merge (R15.2; safety.md §Q&A grounding — hallucination in this domain
 * is a safety failure, not a quality issue). It is a normal Vitest suite, so it runs as
 * part of `npm test` / `npm test -w @turtle/server` (and the dedicated
 * `npm run eval:grounding -w @turtle/server` script) and blocks CI on regression. It is the
 * grounding twin of the guardrail eval (guardrail-eval.test.ts) and mirrors its structure:
 * a dedicated corpus (golden-questions.ts) + a scoring suite that computes rates and asserts
 * hard thresholds, naming every offending question on failure.
 *
 * It exercises the EXISTING Q&A grounding path end-to-end via {@link runQa}, fully offline:
 *   - an in-memory SQLite store seeded with the golden KB,
 *   - lexical (zero-key) retrieval (createLexicalFallbackProvider) — no embeddings,
 *   - a fake live LLM that returns the golden answer verbatim — no network, no keys.
 * The eval MEASURES qa.ts; it must never be made to pass by weakening the grounding
 * threshold or changing qa.ts (Task 35 constraint) — only by fixing golden answer text.
 *
 * Two rates, two hard gates (per diagnosis and aggregate):
 *   - GROUNDED-CITATION RATE = 1: for every ANSWERABLE golden question, a grounded answer
 *     survives the post-hoc check (not the decline line) AND the expected supporting chunk
 *     was retrieved/cited (R8.1/R8.2/R8.4).
 *   - HALLUCINATION RATE = 0: for every UNANSWERABLE / off-topic golden question, the
 *     system DECLINES rather than shipping an ungrounded invented answer (R8.3/R8.4).
 */

// ---------------------------------------------------------------------------
// Offline harness helpers (mirroring qa.test.ts: in-memory store, lexical RAG, fake LLM).
// ---------------------------------------------------------------------------

/** A store seeded with the golden KB for one diagnosis + a caregiver/patient profile. */
function seededRepos(set: DiagnosisGoldenSet, diagnosis: Diagnosis): {
  repos: Repositories;
  caregiverId: string;
} {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  const repos = createRepositories(db, createCipher('test-key'));

  for (const c of set.kb) repos.kbChunk.upsert(c);

  const caregiver = repos.caregiver.create({
    display_name: 'Sam',
    consent_at: new Date().toISOString(),
    prefs: {},
  });
  repos.patient.create({
    caregiver_id: caregiver.id,
    name: 'Alex',
    diagnosis,
    diagnosis_notes: null,
    care_team: { nurse_line: '+1 555 010 0000', other: [] },
  });
  return { repos, caregiverId: caregiver.id };
}

/** A memory service whose profile facts carry the given diagnosis. */
function fakeMemory(diagnosis: Diagnosis): MemoryService {
  return {
    async assemble(_caregiverId: string, _opts?: AssembleOptions): Promise<AssembledContext> {
      return { profileFacts: { diagnosis }, recentSummaries: [], recall: [] };
    },
    async apply(): Promise<void> {
      /* no-op */
    },
  };
}

/** A lexical (zero-key) RAG service over the seeded KB. */
function lexicalRag(repos: Repositories): RagService {
  return createRagService({ repos, embeddings: createLexicalFallbackProvider() });
}

/** A fake live LLM that returns a fixed ModeOutput (the golden answer). No network. */
function fakeLlm(reply: ModeOutput): LlmProvider {
  return {
    id: 'fake',
    live: true,
    async complete(_msgs: LlmMessage[]): Promise<ModeOutput> {
      return reply;
    },
    stream(_msgs: LlmMessage[]): AsyncIterable<LlmStreamChunk> {
      return (async function* () {
        yield { text: reply.say, done: true };
      })();
    },
  };
}

/** Wrap a spoken answer as a contract-shaped ModeOutput. */
function output(say: string): ModeOutput {
  return { say, cards: [], memory_ops: [], flags: ['none'] };
}

/**
 * Run one golden question through the real Q&A grounding path with the golden answer as
 * the (fake) model reply. Returns the grounded/declined output + retrieved chunk ids.
 */
async function runGolden(
  set: DiagnosisGoldenSet,
  diagnosis: Diagnosis,
  q: string,
  goldenAnswer: string,
): Promise<{ out: ModeOutput; ids: string[] }> {
  const { repos, caregiverId } = seededRepos(set, diagnosis);
  const deps: QaDeps = {
    llm: fakeLlm(output(goldenAnswer)),
    rag: lexicalRag(repos),
    memory: fakeMemory(diagnosis),
    caregiverId,
  };
  const { output: out, retrievedChunkIds: ids } = await runQa(q, deps);
  return { out, ids };
}

/** True when a grounded answer survived (not the decline line) and is non-empty. */
function isGroundedAnswer(out: ModeOutput): boolean {
  return out.say !== QA_DECLINE_LINE && out.say.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Corpus-size / uniqueness guard (mirrors the guardrail eval's corpus guard).
// ---------------------------------------------------------------------------

describe('grounding eval — golden corpus is meaningful and unique (R15.2)', () => {
  const diagnoses = Object.keys(GOLDEN_QUESTIONS) as Diagnosis[];

  it('covers at least one diagnosis vertical (keyed per diagnosis)', () => {
    expect(diagnoses.length).toBeGreaterThanOrEqual(1);
  });

  for (const diagnosis of diagnoses) {
    const set = GOLDEN_QUESTIONS[diagnosis];

    it(`[${diagnosis}] has a meaningful set (>=12 answerable, >=4 unanswerable)`, () => {
      expect(set.answerable.length).toBeGreaterThanOrEqual(12);
      expect(set.unanswerable.length).toBeGreaterThanOrEqual(4);
    });

    it(`[${diagnosis}] questions are unique across the set (no padding by duplication)`, () => {
      const all = [
        ...set.answerable.map((g) => g.q),
        ...set.unanswerable.map((g) => g.q),
      ].map((q) => q.trim().toLowerCase());
      expect(new Set(all).size).toBe(all.length);
    });

    it(`[${diagnosis}] every answerable question expects a seeded chunk id`, () => {
      const kbIds = new Set(set.kb.map((c) => c.id));
      const bad = set.answerable.filter((g) => !g.expectChunks.every((id) => kbIds.has(id)));
      expect(
        bad.map((g) => g.q),
        `answerable questions expecting a chunk id absent from the seeded KB`,
      ).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Grounded-citation rate (answerable) — must be 100% (R8.1/R8.2/R8.4).
// ---------------------------------------------------------------------------

/**
 * Collect answerable golden questions that FAILED grounded-citation: either the answer
 * was declined/empty (grounding rejected it) or the expected supporting chunk was not
 * retrieved. Naming every failure makes the gate actionable (mirrors collectMisclassified).
 */
async function collectUngroundedAnswerable(
  set: DiagnosisGoldenSet,
  diagnosis: Diagnosis,
): Promise<Array<{ q: string; reason: string }>> {
  const misses: Array<{ q: string; reason: string }> = [];
  for (const g of set.answerable) {
    const { out, ids } = await runGolden(set, diagnosis, g.q, g.answer);
    if (!isGroundedAnswer(out)) {
      misses.push({ q: g.q, reason: 'answer was declined / did not survive grounding check' });
      continue;
    }
    const cited = g.expectChunks.some((id) => ids.includes(id));
    if (!cited) {
      misses.push({
        q: g.q,
        reason: `expected chunk(s) [${g.expectChunks.join(', ')}] not retrieved (got [${ids.join(', ')}])`,
      });
    }
  }
  return misses;
}

describe('grounding eval — 100% grounded-citation rate on answerable questions (R15.2)', () => {
  const diagnoses = Object.keys(GOLDEN_QUESTIONS) as Diagnosis[];
  for (const diagnosis of diagnoses) {
    const set = GOLDEN_QUESTIONS[diagnosis];
    it(`[${diagnosis}] every answerable golden question grounds and cites its chunk`, async () => {
      const misses = await collectUngroundedAnswerable(set, diagnosis);
      expect(
        misses,
        `answerable questions that FAILED grounded-citation:\n${JSON.stringify(misses, null, 2)}`,
      ).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Hallucination rate (unanswerable) — must be 0% (R8.3/R8.4).
// ---------------------------------------------------------------------------

/**
 * Collect unanswerable golden questions that HALLUCINATED: the system produced a
 * non-decline (ungrounded) answer instead of declining. Any of these is a safety failure.
 */
async function collectHallucinations(
  set: DiagnosisGoldenSet,
  diagnosis: Diagnosis,
): Promise<Array<{ q: string; got: string }>> {
  const misses: Array<{ q: string; got: string }> = [];
  for (const g of set.unanswerable) {
    const { out } = await runGolden(set, diagnosis, g.q, g.answer);
    if (out.say !== QA_DECLINE_LINE) misses.push({ q: g.q, got: out.say });
  }
  return misses;
}

describe('grounding eval — 0% hallucination rate on unanswerable questions (R15.2)', () => {
  const diagnoses = Object.keys(GOLDEN_QUESTIONS) as Diagnosis[];
  for (const diagnosis of diagnoses) {
    const set = GOLDEN_QUESTIONS[diagnosis];
    it(`[${diagnosis}] every unanswerable golden question is declined (no invented answer)`, async () => {
      const misses = await collectHallucinations(set, diagnosis);
      expect(
        misses,
        `unanswerable questions that HALLUCINATED (should decline):\n${JSON.stringify(misses, null, 2)}`,
      ).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Aggregate gate summary (all-or-nothing) — grounded-citation === 1, hallucination === 0.
// ---------------------------------------------------------------------------

describe('grounding eval — aggregate gate summary (all-or-nothing)', () => {
  it('grounded-citation rate === 1 and hallucination rate === 0 across all diagnoses', async () => {
    const diagnoses = Object.keys(GOLDEN_QUESTIONS) as Diagnosis[];
    let answerableTotal = 0;
    let answerableGrounded = 0;
    let unanswerableTotal = 0;
    let hallucinated = 0;

    for (const diagnosis of diagnoses) {
      const set = GOLDEN_QUESTIONS[diagnosis];
      answerableTotal += set.answerable.length;
      unanswerableTotal += set.unanswerable.length;
      answerableGrounded += set.answerable.length - (await collectUngroundedAnswerable(set, diagnosis)).length;
      hallucinated += (await collectHallucinations(set, diagnosis)).length;
    }

    const groundedCitationRate = answerableGrounded / answerableTotal;
    const hallucinationRate = hallucinated / unanswerableTotal;

    expect(groundedCitationRate).toBe(1);
    expect(hallucinationRate).toBe(0);
  });
});
