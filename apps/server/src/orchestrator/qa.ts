import { QA_DECLINE_LINE, modeOutputSchema, type Diagnosis, type ModeOutput } from '@turtle/shared';
import type { LlmMessage, LlmProvider, LlmRunOptions } from '../services/llm/index.js';
import { runMode } from '../services/llm/index.js';
import type { MemoryService } from '../services/memory/index.js';
import type { RagService, RetrievedChunk } from '../services/rag/index.js';
import { DEFAULT_K } from '../services/rag/index.js';
import type { Mode, ModeRunner } from './index.js';

/**
 * Q&A mode with grounding — `qa.prompt` (Task 22, R8.1–R8.4, R15.2).
 *
 * One of the small routed prompts (design.md §Orchestrator). It owns exactly one
 * thing: answering a caregiver's question ABOUT THE DIAGNOSIS in plain language,
 * grounded ONLY in retrieved knowledge-base chunks — never guessing. Hallucination in
 * this domain is a safety failure, not a quality issue (safety.md §Q&A grounding), so
 * grounding is enforced in code, not merely requested in the prompt.
 *
 * The turn flow (design.md §RAG subsystem & qa.prompt):
 *
 *   1. RETRIEVE (R8.1). Assemble the caregiver's bounded context (memory service) to
 *      learn the patient's diagnosis, then retrieve the top-k (k=4) KB chunks filtered
 *      by that diagnosis via the RAG service (cosine when embeddings are live, lexical
 *      otherwise — retrieval works with zero keys).
 *   2. NO CHUNKS → DECLINE (R8.3). If nothing is retrieved (no diagnosis on file, or no
 *      chunk matched), there is nothing to ground an answer in, so Turtle says the
 *      decline line rather than guessing. No LLM call is made.
 *   3. ANSWER, GROUNDED (R8.2). With a LIVE LLM, run the grounded-answerer prompt: the
 *      retrieved chunks (each tagged with its id) are the ONLY allowed source material,
 *      and the model must end with a source reference or a care-team redirect. With a
 *      NON-LIVE provider (zero-key) the model only echoes, which cannot be grounded, so
 *      the runner declines (honest degradation) rather than shipping an ungrounded line.
 *   4. POST-HOC GROUNDING CHECK (R8.4). Every factual sentence in the produced answer
 *      is verified against the retrieved chunks; ungrounded sentences are DROPPED. If
 *      nothing survives (the answer was fully ungrounded), the whole answer is replaced
 *      with the decline line. See {@link groundAnswer}.
 *
 * The retrieved chunk ids are surfaced on the run result so the orchestrator/gateway
 * can persist them on the turn (`turn.retrieved_chunk_ids`, design.md turn model). The
 * output always conforms to the response contract (validated before return), so it
 * flows through the same validate-before-speaking gate (Task 15) as every other mode.
 *
 * As with the sibling modes, the LLM provider, RAG service, memory service, caregiver
 * id, retrieval depth, and run options are all injectable, so the whole surface —
 * retrieve/decline/answer/ground — is unit-testable with fakes and zero network.
 */

/** This runner's mode tag (design.md §Orchestrator: small routed prompts). */
const QA_MODE: Mode = 'qa';

/** The profile-facts key the memory service uses for the patient's diagnosis. */
const DIAGNOSIS_FACT_KEY = 'diagnosis';

/**
 * Grounded-answerer system prompt (R8.2/R8.3). Small and routed: it permits ONLY the
 * retrieved chunks as source material, forbids outside knowledge, requires a citation
 * of the chunk ids that support the answer, and requires ending with a source
 * reference or a care-team redirect. When the chunks do not answer the question the
 * model is told to reply with the exact decline line so the post-hoc check treats it
 * uniformly.
 */
export const QA_SYSTEM =
  'You are Turtle, a warm voice companion for a caregiver of someone with a serious ' +
  'illness. The caregiver has asked a question about the diagnosis. Answer ONLY using ' +
  'the SOURCES provided below.\n' +
  'Strict rules:\n' +
  '- Use ONLY the information in the SOURCES. Do NOT use any outside knowledge. Do NOT ' +
  'guess, infer, or fill gaps.\n' +
  '- If the SOURCES do not contain the answer, reply with EXACTLY: ' +
  `"${QA_DECLINE_LINE}" and nothing else.\n` +
  '- You are not a clinician. Never give medical, dosing, prognosis, or triage advice; ' +
  'redirect those to the care team.\n' +
  '- Be warm, brief, and plain-spoken — a sentence or two, the way a caring friend ' +
  'speaks. This is a spoken conversation, not an essay.\n' +
  '- End your answer with a short source reference naming the chunk ids you used ' +
  '(e.g. "(source: chunk-a)") OR, if it is better handled by a person, a gentle ' +
  'redirect to the care team.\n' +
  'Reply ONLY with a JSON object of the form ' +
  '{"say": string, "cards": [], "memory_ops": [], "flags": ["none"]}. ' +
  'Put your spoken answer in "say" and leave the other fields empty.';

/** Result of running the Q&A mode: the validated output plus the retrieved chunk ids. */
export interface QaRunResult {
  /** The grounded (or declined) mode output, contract-valid. */
  output: ModeOutput;
  /** Ids of the chunks retrieved this turn, for `turn.retrieved_chunk_ids` (R8.1). */
  retrievedChunkIds: string[];
}

/** Dependencies for the Q&A runner (DI style, mirroring the sibling modes). */
export interface QaDeps {
  /**
   * The resolved LLM provider. When `provider.live === false` (canned/zero-key) the
   * runner declines rather than shipping an ungrounded echo (honest degradation).
   */
  llm: LlmProvider;
  /** RAG retrieval service (Task 21): cosine/lexical, diagnosis-filtered, top-k. */
  rag: RagService;
  /** Memory & context assembly (Task 19), used here only to learn the diagnosis. */
  memory: MemoryService;
  /** The caregiver whose patient's diagnosis scopes retrieval. */
  caregiverId: string;
  /** Retrieval depth. Defaults to {@link DEFAULT_K} (k=4, R8.1). */
  k?: number;
  /** Optional timeout/timer knobs forwarded to {@link runMode}. Injectable for tests. */
  runOptions?: LlmRunOptions;
}

/** A contract-valid decline output: the decline line, no cards, no ops, no flags. */
export function qaDecline(): ModeOutput {
  return modeOutputSchema.parse({
    say: QA_DECLINE_LINE,
    cards: [],
    memory_ops: [],
    flags: ['none'],
  });
}

/**
 * Render the retrieved chunks as the SOURCES block for the grounded-answerer prompt.
 * Each chunk is tagged with its id so the model can cite it and the post-hoc check can
 * confirm grounding. Kept pure and exported for direct testing.
 */
export function buildSourcesBlock(chunks: RetrievedChunk[]): string {
  const rendered = chunks.map((c) => `[${c.id}]\n${c.text.trim()}`).join('\n\n');
  return `SOURCES:\n${rendered}`;
}

/**
 * Read the patient's diagnosis from the assembled profile facts. Returns `null` when
 * no patient/diagnosis is on file, in which case the caller declines (nothing to
 * retrieve against).
 */
function diagnosisFrom(profileFacts: Record<string, string>): Diagnosis | null {
  const value = profileFacts[DIAGNOSIS_FACT_KEY];
  return value && value.trim().length > 0 ? (value.trim() as Diagnosis) : null;
}

/**
 * Run the Q&A mode end-to-end and return the grounded/declined output plus the
 * retrieved chunk ids. This is the testable core; {@link createQaRunner} wraps it as a
 * {@link ModeRunner}.
 *
 * @param userText - the caregiver's diagnosis question.
 * @param deps     - injectable LLM, RAG, memory, caregiver id, depth, run options.
 */
export async function runQa(userText: string, deps: QaDeps): Promise<QaRunResult> {
  const { llm, rag, memory, caregiverId, k = DEFAULT_K, runOptions } = deps;

  // (R8.1) Learn the diagnosis from the bounded profile facts, then retrieve.
  const context = await memory.assemble(caregiverId);
  const diagnosis = diagnosisFrom(context.profileFacts);
  if (!diagnosis) return { output: qaDecline(), retrievedChunkIds: [] };

  const chunks = await rag.retrieve(userText, diagnosis, k);
  const retrievedChunkIds = chunks.map((c) => c.id);

  // (R8.3) Nothing retrieved → nothing to ground an answer in → decline, no LLM call.
  if (chunks.length === 0) return { output: qaDecline(), retrievedChunkIds };

  // Zero-key degradation: a non-live provider only echoes, which cannot be grounded.
  // Decline honestly rather than shipping an ungrounded line.
  if (!llm.live) return { output: qaDecline(), retrievedChunkIds };

  // (R8.2) Grounded answer: the retrieved chunks are the ONLY allowed source material.
  const messages: LlmMessage[] = [
    { role: 'system', content: QA_SYSTEM },
    { role: 'user', content: `${buildSourcesBlock(chunks)}\n\nQUESTION: ${userText}` },
  ];
  const raw = await runMode(llm, messages, runOptions);

  // (R8.4) Post-hoc grounding check: drop ungrounded sentences; fully ungrounded →
  // decline line. Then validate before speaking.
  const grounded = groundAnswer(raw.say, chunks);
  const output = modeOutputSchema.parse({
    say: grounded,
    cards: [],
    memory_ops: [],
    flags: ['none'],
  });
  return { output, retrievedChunkIds };
}

/**
 * Create the Q&A {@link ModeRunner} (Task 22). `run(userText)` returns the grounded (or
 * declined) {@link ModeOutput}. Because `ModeRunner.run` yields only a `ModeOutput`,
 * the retrieved chunk ids from the most recent run are also exposed on the returned
 * object as {@link QaRunner.lastRetrievedChunkIds} so the orchestrator/gateway can
 * persist them on the turn (`turn.retrieved_chunk_ids`, R8.1) without a second
 * retrieval. Callers that want both in one value can use {@link runQa} directly.
 *
 * @param deps - injectable LLM, RAG, memory, caregiver id, depth, run options.
 */
export interface QaRunner extends ModeRunner {
  /** The chunk ids retrieved on the most recent `run`, for turn persistence (R8.1). */
  readonly lastRetrievedChunkIds: string[];
}

export function createQaRunner(deps: QaDeps): QaRunner {
  let lastRetrievedChunkIds: string[] = [];
  return {
    mode: QA_MODE,
    get lastRetrievedChunkIds() {
      return lastRetrievedChunkIds;
    },
    async run(userText: string): Promise<ModeOutput> {
      const { output, retrievedChunkIds } = await runQa(userText, deps);
      lastRetrievedChunkIds = retrievedChunkIds;
      return output;
    },
  };
}

// ---------------------------------------------------------------------------
// Post-hoc grounding check (R8.4) — the code-level enforcement of "no guessing".
// ---------------------------------------------------------------------------

/**
 * Post-hoc grounding check (R8.4; safety.md §Q&A grounding).
 *
 * Splits the model's answer into sentences and keeps only those that are GROUNDED in
 * the retrieved chunks. A sentence is grounded when it either:
 *   - is a non-factual connective/framing sentence (no real content to ground — e.g.
 *     the closing source reference or a gentle redirect), or
 *   - shares enough content-word overlap with at least one retrieved chunk that its
 *     claim is supported by the source material.
 *
 * Ungrounded factual sentences are DROPPED. If the model already emitted the exact
 * decline line, or if nothing survives the check (the answer was fully ungrounded),
 * the entire answer is replaced with {@link QA_DECLINE_LINE} rather than speaking a
 * partial or unsupported claim.
 *
 * The check is deliberately conservative on the "is this factual?" question so it does
 * not strip the natural framing/citation sentences the prompt asks for, but strict on
 * factual claims so an unsupported sentence cannot survive. Exported for direct testing.
 *
 * @param answer - the model's raw `say` text.
 * @param chunks - the chunks retrieved this turn (the only permitted source material).
 */
export function groundAnswer(answer: string, chunks: RetrievedChunk[]): string {
  const trimmed = answer.trim();
  if (trimmed.length === 0) return QA_DECLINE_LINE;
  // The model was told to reply with the exact decline line when the sources do not
  // answer; honor that verbatim without running the sentence check.
  if (isDeclineLine(trimmed)) return QA_DECLINE_LINE;

  const chunkVocab = buildChunkVocabulary(chunks);
  const sentences = splitSentences(trimmed);

  const kept: string[] = [];
  // Track whether any sentence with real substance survived. A sentence "counts" as
  // grounded substance when its content words overlap the sources — a bare citation or
  // care-team redirect is framing and is kept for readability but never, on its own,
  // satisfies the "we actually answered from the sources" bar.
  let keptGroundedSubstance = false;
  for (const sentence of sentences) {
    // A pure source citation ("(source: chunk-a)") is framing: keep it for the source
    // reference the prompt asks for, but it never counts as an answer on its own.
    if (isPureCitation(sentence)) {
      kept.push(sentence);
      continue;
    }
    if (sentenceIsGrounded(sentence, chunkVocab)) {
      // Grounded in the sources → keep it, and it counts as real answered substance
      // (even if it also mentions the care team — a supported claim is a claim).
      kept.push(sentence);
      keptGroundedSubstance = true;
      continue;
    }
    // Ungrounded. Keep only a care-team redirect (framing the prompt may add); drop an
    // ungrounded factual claim (R8.4).
    if (isCareTeamRedirect(sentence)) kept.push(sentence);
  }

  // Nothing with grounded substance survived → decline rather than ship framing
  // sentences with no supported claim behind them (R8.3/R8.4).
  if (!keptGroundedSubstance) return QA_DECLINE_LINE;

  return kept.join(' ').replace(/\s+/g, ' ').trim();
}

/** True when the text is the decline line (case/whitespace-insensitive). */
function isDeclineLine(text: string): boolean {
  return normalize(text) === normalize(QA_DECLINE_LINE);
}

/** Content-word vocabulary (a set) built from all retrieved chunk texts + titles. */
function buildChunkVocabulary(chunks: RetrievedChunk[]): Set<string> {
  const vocab = new Set<string>();
  for (const chunk of chunks) {
    for (const token of contentTokens(chunk.text)) vocab.add(token);
  }
  return vocab;
}

/**
 * Decide whether a sentence makes a FACTUAL claim (rather than pure framing). A pure
 * source citation, a care-team redirect, or a contentless sentence carries no
 * groundable claim and is treated as framing; everything else is factual. The
 * grounding check keeps framing sentences for readability but never lets them stand in
 * for an actual grounded answer. Exported for direct testing.
 */
export function isFactualSentence(sentence: string): boolean {
  if (isPureCitation(sentence)) return false;
  if (isCareTeamRedirect(sentence)) return false;
  if (contentTokens(sentence).length === 0) return false;
  return true;
}

/** A sentence that is only a source reference, e.g. "(source: chunk-a)" / "Source: …". */
function isPureCitation(sentence: string): boolean {
  const stripped = sentence.replace(/[()]/g, '').trim();
  // Starts with a source-reference marker and carries no other clause.
  return /^sources?\s*:/i.test(stripped);
}

/**
 * A care-team / clinician redirect ("this is best answered by your care team"). Framing
 * the prompt is allowed to add when a question is better handled by a person; it is not
 * a factual claim about the illness, so it is kept but never counts as answered
 * substance on its own.
 */
function isCareTeamRedirect(sentence: string): boolean {
  const lower = sentence.toLowerCase();
  return /\bcare team\b/.test(lower) || /\bclinician\b/.test(lower);
}

/**
 * A factual sentence is grounded when a sufficient share of its content words appear in
 * the retrieved-chunk vocabulary. Using a ratio (not a fixed count) keeps short and
 * long sentences on the same footing; the threshold is chosen so a sentence clearly
 * paraphrasing the sources passes while an off-topic claim (words absent from every
 * chunk) fails.
 */
function sentenceIsGrounded(sentence: string, chunkVocab: Set<string>): boolean {
  const tokens = contentTokens(sentence);
  if (tokens.length === 0) return true; // no content to contradict the sources
  let overlap = 0;
  for (const token of tokens) {
    if (chunkVocab.has(token)) overlap++;
  }
  return overlap / tokens.length >= GROUNDING_OVERLAP_THRESHOLD;
}

/**
 * Minimum share of a sentence's content words that must appear in the retrieved chunks
 * for the sentence to count as grounded. Tuned so a genuine paraphrase of the sources
 * clears it while an off-topic/invented sentence does not.
 */
export const GROUNDING_OVERLAP_THRESHOLD = 0.5;

/** Split text into sentences on sentence-final punctuation, keeping the terminator. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Extract lowercased content tokens, dropping short tokens and a small stop-word set so
 * grounding compares MEANINGFUL words rather than glue words ("the", "and", "is"). This
 * mirrors the spirit of the RAG lexical tokenizer but with a stop-list, because here we
 * are judging semantic overlap, not ranking.
 */
export function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

/** Normalize for exact-line comparison: lowercase, collapse whitespace, drop trailing punctuation. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim();
}

/** Small English stop-word set for grounding overlap (glue words carry no evidence). */
const STOP_WORDS = new Set([
  'the', 'and', 'are', 'was', 'were', 'for', 'that', 'this', 'with', 'from', 'they',
  'them', 'their', 'there', 'here', 'what', 'when', 'where', 'which', 'who', 'whom',
  'you', 'your', 'yours', 'can', 'could', 'would', 'should', 'may', 'might', 'will',
  'shall', 'have', 'has', 'had', 'not', 'but', 'about', 'into', 'onto', 'out', 'over',
  'under', 'than', 'then', 'also', 'some', 'any', 'all', 'each', 'more', 'most', 'much',
  'many', 'such', 'very', 'just', 'like', 'how', 'why', 'because', 'these', 'those',
  'its', 'his', 'her', 'him', 'she', 'himself', 'herself', 'itself', 'one', 'per',
]);
