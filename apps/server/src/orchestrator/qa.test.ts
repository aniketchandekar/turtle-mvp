import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { QA_DECLINE_LINE, modeOutputSchema, type KbChunk, type ModeOutput } from '@turtle/shared';
import { SCHEMA_SQL } from '../store/schema.js';
import { createCipher } from '../store/crypto.js';
import { createRepositories, type Repositories } from '../store/repositories.js';
import type { LlmMessage, LlmProvider, LlmStreamChunk } from '../services/llm/index.js';
import { createLexicalFallbackProvider, createRagService, type RagService } from '../services/rag/index.js';
import type { AssembledContext, AssembleOptions, MemoryService } from '../services/memory/index.js';
import { finalizeTurn, type RepairFn } from './contract-validator.js';
import {
  createQaRunner,
  runQa,
  qaDecline,
  groundAnswer,
  buildSourcesBlock,
  isFactualSentence,
  splitSentences,
  QA_SYSTEM,
  type QaDeps,
} from './qa.js';

/**
 * Q&A mode with grounding (Task 22, R8.1–R8.4, R15.2).
 *
 * Coverage:
 *   1. Post-hoc grounding check (R8.4) — grounded sentences kept, ungrounded factual
 *      sentences dropped, fully-ungrounded answers replaced with the decline line.
 *   2. Golden-question grounding (R15.2) — a seeded metastatic-cancer KB + fake LLM.
 *      Answerable golden questions retrieve chunks and keep a grounded answer; an
 *      off-topic/unanswerable question produces the decline line.
 *   3. Retrieval → decline paths (R8.1/R8.3) — no diagnosis or no chunk → decline,
 *      no LLM call; retrieved chunk ids are surfaced for turn persistence.
 *   4. Zero-key degradation — a non-live provider declines rather than echo.
 *   5. End-to-end persistence — retrieved_chunk_ids land on the assistant turn.
 *
 * Everything runs with an in-memory SQLite store, lexical (zero-key) retrieval, and a
 * fake LLM — no network — mirroring rag.test.ts / checkin.test.ts / guardrail.test.ts.
 */

// ---------------------------------------------------------------------------
// Seeded metastatic-cancer KB (excerpts of the curated kb/metastatic-cancer files).
// ---------------------------------------------------------------------------

function chunk(id: string, content: string): KbChunk {
  return {
    id,
    diagnosis: 'metastatic_cancer',
    source_url: null,
    title: null,
    content_md: content,
    embedding: null,
  };
}

const KB: KbChunk[] = [
  chunk(
    'meta-means',
    'Metastatic cancer is cancer that has spread from the place where it first started to ' +
      'another part of the body. The place where it began is called the primary cancer. When ' +
      'cells break away from that primary tumor and travel through the blood or lymph system ' +
      'they can grow in a new place. Those new growths are called metastases. Metastatic cancer ' +
      'keeps the name of the place it started; breast cancer that spreads to the lungs is called ' +
      'metastatic breast cancer.',
  ),
  chunk(
    'symptoms',
    'People living with metastatic cancer often experience fatigue, a deep tiredness that rest ' +
      'does not always fix. Pain is common and there are many ways to manage it. Nausea and loss ' +
      'of appetite can happen from both the illness and from treatments like chemotherapy. Other ' +
      'things caregivers notice include shortness of breath, swelling, and trouble sleeping.',
  ),
  chunk(
    'appointments',
    'Preparing questions before an appointment helps caregivers feel less overwhelmed. Writing ' +
      'down what you want to ask, and what you have noticed at home, gives the care team real ' +
      'information to work with during the visit.',
  ),
  chunk(
    'self-care',
    'Caring for someone with a serious illness is exhausting. Resting when you can, accepting help ' +
      'from others, and taking short breaks are all ways caregivers look after themselves so they ' +
      'can keep showing up.',
  ),
];

function makeRepos(): Repositories {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return createRepositories(db, createCipher('test-key'));
}

/** A store seeded with the metastatic-cancer KB and a caregiver+patient profile. */
function seededRepos(): { repos: Repositories; caregiverId: string; sessionId: string } {
  const repos = makeRepos();
  for (const c of KB) repos.kbChunk.upsert(c);

  const caregiver = repos.caregiver.create({
    display_name: 'Sam',
    consent_at: new Date().toISOString(),
    prefs: {},
  });
  repos.patient.create({
    caregiver_id: caregiver.id,
    name: 'Alex',
    diagnosis: 'metastatic_cancer',
    diagnosis_notes: null,
    care_team: { nurse_line: '+1 555 010 0000', other: [] },
  });
  const session = repos.session.create(caregiver.id);
  return { repos, caregiverId: caregiver.id, sessionId: session.id };
}

/** A memory service whose profile facts carry the given diagnosis (or none). */
function fakeMemory(diagnosis: string | null): MemoryService {
  return {
    async assemble(_caregiverId: string, _opts?: AssembleOptions): Promise<AssembledContext> {
      const profileFacts: Record<string, string> = diagnosis ? { diagnosis } : {};
      return { profileFacts, recentSummaries: [], recall: [] };
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

/**
 * A fake live LLM that returns a fixed ModeOutput and captures the messages it saw, so
 * tests can assert the SOURCES/QUESTION prompt was assembled (R8.2).
 */
function fakeLlm(
  reply: ModeOutput,
  opts: { live?: boolean } = {},
): { llm: LlmProvider; messages: LlmMessage[][] } {
  const messages: LlmMessage[][] = [];
  const llm: LlmProvider = {
    id: 'fake',
    live: opts.live ?? true,
    async complete(msgs: LlmMessage[]): Promise<ModeOutput> {
      messages.push(msgs);
      return reply;
    },
    stream(msgs: LlmMessage[]): AsyncIterable<LlmStreamChunk> {
      messages.push(msgs);
      return (async function* () {
        yield { text: reply.say, done: true };
      })();
    },
  };
  return { llm, messages };
}

function output(say: string): ModeOutput {
  return { say, cards: [], memory_ops: [], flags: ['none'] };
}

// ---------------------------------------------------------------------------
// Post-hoc grounding check (R8.4)
// ---------------------------------------------------------------------------

describe('groundAnswer — post-hoc grounding check (R8.4)', () => {
  const chunks = [
    { id: 'symptoms', text: KB[1]!.content_md, diagnosis: 'metastatic_cancer' as const, score: 1 },
  ];

  it('keeps a grounded factual sentence', () => {
    const grounded = groundAnswer(
      'Fatigue is a common experience, a deep tiredness that rest does not always fix.',
      chunks,
    );
    expect(grounded).toContain('Fatigue');
    expect(grounded).not.toBe(QA_DECLINE_LINE);
  });

  it('drops an ungrounded factual sentence but keeps grounded ones', () => {
    const answer =
      'Fatigue and nausea are common with metastatic cancer. ' +
      'The recommended cure is a daily dose of vitamin Q from the rainforest.';
    const grounded = groundAnswer(answer, chunks);
    expect(grounded).toContain('Fatigue');
    // The invented "vitamin Q / rainforest" sentence shares no vocabulary with the
    // source and must be dropped.
    expect(grounded.toLowerCase()).not.toContain('vitamin q');
    expect(grounded.toLowerCase()).not.toContain('rainforest');
  });

  it('replaces a fully ungrounded answer with the decline line', () => {
    const answer =
      'The moon landing was filmed in a studio. Helicopters require regular blade maintenance.';
    expect(groundAnswer(answer, chunks)).toBe(QA_DECLINE_LINE);
  });

  it('honors an explicit decline line verbatim', () => {
    expect(groundAnswer(QA_DECLINE_LINE, chunks)).toBe(QA_DECLINE_LINE);
  });

  it('keeps non-factual framing (source reference / care-team redirect) sentences', () => {
    expect(isFactualSentence('(source: symptoms)')).toBe(false);
    expect(isFactualSentence('This is best answered by your care team.')).toBe(false);
    expect(isFactualSentence('Fatigue is common with this illness.')).toBe(true);
  });

  it('splits sentences on terminal punctuation', () => {
    expect(splitSentences('One thing. Two things! Three?')).toEqual([
      'One thing.',
      'Two things!',
      'Three?',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Golden-question grounding (R15.2)
// ---------------------------------------------------------------------------

describe('Q&A golden-question grounding (R15.2)', () => {
  /**
   * Golden set for the seeded metastatic-cancer vertical. Each answerable question has
   * a fake grounded answer drawn from the KB text; the unanswerable one is off-topic.
   */
  const GOLDEN = [
    {
      q: 'What does metastatic mean?',
      answer:
        'Metastatic cancer is cancer that has spread from the place where it first started to ' +
        'another part of the body. (source: meta-means)',
      expectChunk: 'meta-means',
    },
    {
      q: 'What are common symptoms to expect?',
      answer:
        'Fatigue is common, a deep tiredness that rest does not always fix, along with nausea ' +
        'and loss of appetite. (source: symptoms)',
      expectChunk: 'symptoms',
    },
    {
      q: 'How does preparing for appointments help?',
      answer:
        'Writing down questions before the appointment gives the care team real information to ' +
        'work with. (source: appointments)',
      expectChunk: 'appointments',
    },
  ] as const;

  for (const golden of GOLDEN) {
    it(`grounds a golden answer and cites a chunk: "${golden.q}"`, async () => {
      const { repos, caregiverId } = seededRepos();
      const { llm } = fakeLlm(output(golden.answer));
      const deps: QaDeps = {
        llm,
        rag: lexicalRag(repos),
        memory: fakeMemory('metastatic_cancer'),
        caregiverId,
      };

      const { out, ids } = await run(deps, golden.q);

      // Retrieval happened, and the expected supporting chunk was among the results (R8.1).
      expect(ids.length).toBeGreaterThan(0);
      expect(ids).toContain(golden.expectChunk);
      // The grounded answer survived the post-hoc check (not the decline line) and is
      // contract-valid (R8.2/R8.4).
      expect(out.say).not.toBe(QA_DECLINE_LINE);
      expect(out.say.length).toBeGreaterThan(0);
      expect(() => modeOutputSchema.parse(out)).not.toThrow();
    });
  }

  it('declines an unanswerable / off-topic golden question', async () => {
    const { repos, caregiverId } = seededRepos();
    // The model tries to answer with content absent from every chunk.
    const { llm } = fakeLlm(
      output('You should book a two-week beach vacation in Bali to feel better.'),
    );
    const deps: QaDeps = {
      llm,
      rag: lexicalRag(repos),
      memory: fakeMemory('metastatic_cancer'),
      caregiverId,
    };

    const { out } = await run(deps, 'What is the best airline for a holiday to Bali?');
    // Fully ungrounded → decline line rather than an invented answer (R8.3/R8.4).
    expect(out.say).toBe(QA_DECLINE_LINE);
  });

  it('assembles the grounded-answerer prompt with SOURCES and the question (R8.2)', async () => {
    const { repos, caregiverId } = seededRepos();
    const { llm, messages } = fakeLlm(
      output('Fatigue is common with metastatic cancer. (source: symptoms)'),
    );
    const deps: QaDeps = {
      llm,
      rag: lexicalRag(repos),
      memory: fakeMemory('metastatic_cancer'),
      caregiverId,
    };

    await run(deps, 'What symptoms are common?');

    const last = messages[messages.length - 1]!;
    const system = last.find((m) => m.role === 'system')!.content;
    const user = last.find((m) => m.role === 'user')!.content;
    expect(system).toBe(QA_SYSTEM);
    expect(user).toContain('SOURCES:');
    expect(user).toContain('QUESTION: What symptoms are common?');
  });
});

// ---------------------------------------------------------------------------
// Retrieval → decline paths (R8.1 / R8.3) and zero-key degradation
// ---------------------------------------------------------------------------

describe('runQa — retrieval and decline paths (R8.1/R8.3)', () => {
  it('declines without an LLM call when no diagnosis is on file', async () => {
    const { repos, caregiverId } = seededRepos();
    const { llm, messages } = fakeLlm(output('unused'));
    const deps: QaDeps = { llm, rag: lexicalRag(repos), memory: fakeMemory(null), caregiverId };

    const { output: out, retrievedChunkIds } = await runQa('anything?', deps);
    expect(out.say).toBe(QA_DECLINE_LINE);
    expect(retrievedChunkIds).toEqual([]);
    expect(messages).toHaveLength(0); // no LLM consulted
  });

  it('declines without an LLM call when no chunk is retrieved', async () => {
    const repos = makeRepos(); // empty KB (no chunks seeded)
    const caregiver = repos.caregiver.create({ display_name: null, consent_at: null, prefs: {} });
    const { llm, messages } = fakeLlm(output('unused'));
    const deps: QaDeps = {
      llm,
      rag: lexicalRag(repos),
      memory: fakeMemory('metastatic_cancer'),
      caregiverId: caregiver.id,
    };

    const { output: out, retrievedChunkIds } = await runQa('what is metastatic cancer?', deps);
    expect(out.say).toBe(QA_DECLINE_LINE);
    expect(retrievedChunkIds).toEqual([]);
    expect(messages).toHaveLength(0);
  });

  it('declines (no ungrounded echo) with a non-live provider', async () => {
    const { repos, caregiverId } = seededRepos();
    const { llm } = fakeLlm(output('echoed user text'), { live: false });
    const deps: QaDeps = {
      llm,
      rag: lexicalRag(repos),
      memory: fakeMemory('metastatic_cancer'),
      caregiverId,
    };

    const { output: out, retrievedChunkIds } = await runQa('what are common symptoms?', deps);
    expect(out.say).toBe(QA_DECLINE_LINE);
    // Retrieval still happened (ids surfaced) even though we decline to answer.
    expect(retrievedChunkIds.length).toBeGreaterThan(0);
  });

  it('exposes lastRetrievedChunkIds on the runner for turn persistence (R8.1)', async () => {
    const { repos, caregiverId } = seededRepos();
    const { llm } = fakeLlm(output('Fatigue is common with metastatic cancer. (source: symptoms)'));
    const runner = createQaRunner({
      llm,
      rag: lexicalRag(repos),
      memory: fakeMemory('metastatic_cancer'),
      caregiverId,
    });
    expect(runner.mode).toBe('qa');

    await runner.run('what symptoms are common?');
    expect(runner.lastRetrievedChunkIds.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end persistence: retrieved_chunk_ids land on the assistant turn (R8.1)
// ---------------------------------------------------------------------------

describe('Q&A turn persistence — retrieved_chunk_ids (R8.1)', () => {
  it('persists the retrieved chunk ids on the assistant turn', async () => {
    const { repos, caregiverId, sessionId } = seededRepos();
    const patient = repos.patient.getByCaregiver(caregiverId)!;
    const { llm } = fakeLlm(output('Fatigue is common with metastatic cancer. (source: symptoms)'));
    const deps: QaDeps = {
      llm,
      rag: lexicalRag(repos),
      memory: fakeMemory('metastatic_cancer'),
      caregiverId,
    };

    const { output: out, retrievedChunkIds } = await runQa('what symptoms are common?', deps);
    expect(retrievedChunkIds.length).toBeGreaterThan(0);

    // Finalize through the shared validate → persist path, threading the chunk ids.
    const turnId = 'turn-qa-1';
    const noRepair: RepairFn = async () => {
      throw new Error('should not repair a valid output');
    };
    await finalizeTurn(
      out,
      { sessionId, turnId },
      noRepair,
      { repos, patientId: patient.id },
      { retrievedChunkIds },
    );

    const turns = repos.turn.listBySession(sessionId);
    const assistantTurn = turns.find((t) => t.id === turnId)!;
    expect(assistantTurn.speaker).toBe('assistant');
    expect(assistantTurn.retrieved_chunk_ids).toEqual(retrievedChunkIds);
  });
});

// ---------------------------------------------------------------------------
// buildSourcesBlock + qaDecline unit checks
// ---------------------------------------------------------------------------

describe('buildSourcesBlock / qaDecline', () => {
  it('tags each source with its chunk id', () => {
    const block = buildSourcesBlock([
      { id: 'c1', text: 'first', diagnosis: 'metastatic_cancer', score: 1 },
      { id: 'c2', text: 'second', diagnosis: 'metastatic_cancer', score: 1 },
    ]);
    expect(block).toContain('SOURCES:');
    expect(block).toContain('[c1]');
    expect(block).toContain('[c2]');
    expect(block).toContain('first');
    expect(block).toContain('second');
  });

  it('qaDecline is the decline line, contract-valid, no cards', () => {
    const d = qaDecline();
    expect(d.say).toBe(QA_DECLINE_LINE);
    expect(d.cards).toEqual([]);
    expect(() => modeOutputSchema.parse(d)).not.toThrow();
  });
});

/** Convenience: run the Q&A core and return `{ out, ids }` (shorter assertions). */
async function run(deps: QaDeps, q: string): Promise<{ out: ModeOutput; ids: string[] }> {
  const { output: out, retrievedChunkIds: ids } = await runQa(q, deps);
  return { out, ids };
}
