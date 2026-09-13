import type { ModeOutput, TurnContract, TurnFlag } from '@turtle/shared';

/**
 * Orchestrator module (design.md §Module boundaries).
 *
 * The turn brain: safety classifier → mode router → per-mode prompt runner →
 * LLM → contract validation → memory ops → card events. Per the PRD there is NO
 * god-prompt; each mode and each safety step is a small, individually testable
 * prompt.
 *
 * Order of operations every turn (safety rules, BINDING):
 *   1. Safety classifier runs FIRST on raw user text, before any mode routing.
 *      crisis / medical → bypass normal routing.
 *   2. Output validation against the mode's JSON contract (one repair, else safe fallback).
 *   3. Post-hoc grounding check (Q&A only): drop ungrounded factual sentences.
 *   4. Flagged turns land in the owner review queue.
 *
 * Phase 0 status: boundary + interfaces only. Real classifier, router, prompt
 * runners, and validator land in Phase 2 (Tasks 15–22).
 */

/** Routable conversation modes (design.md §Orchestrator: small routed prompts). */
export const MODES = ['checkin', 'qa', 'log', 'prep'] as const;
export type Mode = (typeof MODES)[number];

/** Safety classifier verdict. Bias uncertain cases toward flagging. */
export type SafetyVerdict = 'crisis' | 'medical' | 'none';

export interface SafetyClassifier {
  /** Classify raw user text BEFORE any routing. */
  classify(userText: string): Promise<SafetyVerdict>;
}

export interface ModeRouter {
  /** Rules-first routing, then a small intent classifier for the rest. */
  route(userText: string): Promise<Mode>;
}

/** A per-mode prompt runner. Each mode owns its own small prompt + output contract. */
export interface ModeRunner {
  readonly mode: Mode;
  run(userText: string): Promise<ModeOutput>;
}

export interface ContractValidator {
  /**
   * Validate a raw mode output against the Zod contract. On failure the
   * orchestrator regenerates once with a repair instruction, else emits a safe
   * fallback line with no cards.
   */
  validate(sessionId: string, turnId: string, raw: unknown): TurnContract;
}

/** The public entrypoint the gateway calls once it has final user text. */
export interface Orchestrator {
  /** Process one user turn end-to-end, returning a validated turn contract. */
  handleTurn(input: {
    sessionId: string;
    turnId: string;
    userText: string;
  }): Promise<TurnContract>;
}

export type { TurnFlag };

/**
 * Contract validation + repair + persistence (Task 15). The validator gate that
 * enforces "validate before speaking", regenerates once on failure, falls back
 * safely, and applies memory_ops / persists the turn + cards off the spine.
 */
export {
  validateOrRepair,
  applyMemoryOps,
  persistTurn,
  finalizeTurn,
  type TurnMeta,
  type RepairFn,
  type FactSink,
  type ContractValidatorDeps,
  type ValidationResult,
  type PersistResult,
  type PersistOptions,
} from './contract-validator.js';

/**
 * Medical guardrail refusal composer (Task 17). Deterministic `guardrail.refusal`:
 * acknowledge → state the limit → redirect to the care-team contact, with an
 * actionable card and the `medical_refusal` flag. Medical-flagged turns bypass
 * normal routing and are composed here; the spoken-AND-shown rule is enforced in code.
 */
export {
  composeMedicalRefusal,
  assertSpokenAndShown,
  pickCareTeamContact,
  contactToAction,
  composeRefusalSay,
  toTelTarget,
  type ResolvedContact,
} from './guardrail.js';

/**
 * Crisis protocol composer (Task 31, R13.1–R13.5 / R5.5). Deterministic crisis handler:
 * on a `crisis` safety flag the turn BYPASSES normal routing and lands here. Responds
 * gently and validates without continuing normal conversation (R13.1), speaks the 988
 * Suicide & Crisis Lifeline and encourages contacting the care team / a trusted person
 * (R13.2), emits a `safety` card carrying the same resources so they are BOTH spoken
 * AND shown (R13.3 / R13.5), and flags the turn `crisis` for owner review (R13.4 / R5.5).
 * The spoken-AND-shown rule is enforced IN CODE: {@link assertCrisisSpokenAndShown}
 * rejects a card-only or spoken-only crisis response and {@link enforceCrisisSpokenAndShown}
 * repairs one back to the canonical protocol. Like the medical refusal, the output
 * conforms to the response contract and flows through the same validate-before-speaking
 * gate (Task 15).
 */
export {
  composeCrisisResponse,
  assertCrisisSpokenAndShown,
  enforceCrisisSpokenAndShown,
} from './crisis.js';

/**
 * Safety classifier — the seed implementation (Task 16, R5.1–R5.3; hardened by the eval
 * harness in Task 34, R5.6/R15.1/R15.3). The FIRST step of every turn: runs on the raw user
 * text BEFORE any routing (safety.md §Order of operations) and returns a {@link SafetyVerdict}
 * — `crisis` (suicidal ideation / self-harm / abuse), `medical` (a request for a CLINICAL
 * DECISION: medication selection/dosing/timing/interactions, prognosis/life-expectancy,
 * symptom triage), or `none` (everything else, INCLUDING benign medically-adjacent caregiver
 * observation and venting). Crisis and medical verdicts bypass normal routing — crisis → the
 * crisis protocol, medical → the guardrail refusal — so this module gates the whole pipeline.
 * Deterministic and LLM-free (keyword/phrase rules, in the mode-router style) so it works with
 * zero keys and its verdict is fully testable; it BIASES UNCERTAIN CASES TOWARD FLAGGING
 * (R5.2) and does NOT over-refuse benign caregiver talk (R5.6). `createSafetyClassifier`
 * returns a {@link SafetyClassifier}; `classifySafety` is the synchronous testable core.
 */
export {
  createSafetyClassifier,
  classifySafety,
  isCrisis,
  isMedical,
} from './safety.js';

/**
 * Mode router (Task 18, R6.1). Rules-first routing (log dictation, appointment/prep
 * retrieval, diagnosis Q&A) then a small LLM intent classification for the rest,
 * degrading gracefully to `checkin` with no live LLM. Runs AFTER the safety
 * classifier — crisis/medical bypass routing — so it only handles the `none` case.
 * The chosen mode is recorded in the session's `mode_transitions` via the injectable
 * `record` hook (built with {@link recordMode}).
 */
export {
  createModeRouter,
  resolveMode,
  routeByRules,
  parseClassifiedMode,
  recordMode,
  isLogRetrievalQuery,
  isAppointmentCreation,
  isVisitSummaryDictation,
  isSummaryRetrievalQuery,
  DEFAULT_MODE,
  type ModeRouterDeps,
} from './mode-router.js';

/**
 * Check-in mode (Task 20, R7.1–R7.4). The supportive, memory-aware default mode — one
 * of the small routed prompts. Opens sessions with the check-in opener (R7.1;
 * {@link checkinOpener}), grounds follow-ups in prior session themes assembled by the
 * memory service (R7.3), keeps turns short (R7.4), and offers at most one coping
 * suggestion per session via an injectable session-scoped budget (R7.2). Degrades to a
 * warm fallback with no live LLM. `createCheckinRunner` returns a {@link ModeRunner}
 * with `mode: 'checkin'`.
 */
export {
  createCheckinRunner,
  createSuggestionBudget,
  checkinOpener,
  buildSystemPrompt,
  outputOffersSuggestion,
  CHECKIN_SYSTEM,
  CHECKIN_FALLBACK_SAY,
  SUGGESTION_ALLOWED_INSTRUCTION,
  SUGGESTION_SPENT_INSTRUCTION,
  PRIOR_THEMES_PREFIX,
  type SuggestionBudget,
  type CheckinDeps,
} from './checkin.js';

/**
 * Q&A mode with grounding (Task 22, R8.1–R8.4, R15.2). The grounded-answerer routed
 * prompt: retrieve the top-k (k=4) diagnosis-filtered KB chunks (RAG subsystem, Task
 * 21), answer using ONLY those chunks and ending with a source reference or care-team
 * redirect (R8.2), and enforce grounding IN CODE via a post-hoc check that drops
 * ungrounded factual sentences and replaces a fully-ungrounded answer with the decline
 * line "I don't know — this is one for your care team" (R8.3/R8.4). No retrieved chunk
 * (or a non-live LLM) → decline rather than guess. The retrieved chunk ids are surfaced
 * for turn persistence (R8.1). `createQaRunner` returns a {@link ModeRunner} with
 * `mode: 'qa'`; `runQa` is the testable core returning output + chunk ids together.
 */
export {
  createQaRunner,
  runQa,
  qaDecline,
  groundAnswer,
  buildSourcesBlock,
  isFactualSentence,
  splitSentences,
  contentTokens,
  QA_SYSTEM,
  GROUNDING_OVERLAP_THRESHOLD,
  type QaDeps,
  type QaRunResult,
  type QaRunner,
} from './qa.js';

/**
 * Care-log extraction mode — `log.prompt` (Task 26, R11.1–R11.3). One of the small
 * routed prompts: extracts a dictated utterance ("Gave the 2pm meds… slept badly… new
 * cough") into one or more structured {@link LogCategory} entries with a timestamp
 * (R11.1), emits one `append_log` memory op per entry so the log flows only through
 * the validated contract, confirms with PASSIVE phrasing composed in code ("Noted —
 * … logged") (R11.2), and creates a single RETAINED log card summarizing what was
 * filed (R11.2). The zero-interpretation rule (R11.3) is enforced in code: the spoken
 * confirmation and card are built from the neutral extracted entries, never from model
 * prose, so no advice/comparison/triage can leak into the output. Degrades to a
 * deterministic single-`note` extraction with no live LLM. `createLogRunner` returns a
 * {@link ModeRunner} with `mode: 'log'`; `runLog` is the testable core.
 */
export {
  createLogRunner,
  runLog,
  extractEntries,
  parseEntriesJson,
  isLogCategory,
  fallbackEntry,
  buildConfirmation,
  buildLogCard,
  LOG_SYSTEM,
  LOG_CARD_TITLE,
  type LogDeps,
  type LogExtraction,
} from './log.js';

/**
 * Care-log voice retrieval — the READ counterpart to `log.prompt` (Task 27, R11.4).
 * Answers a caregiver's question about a past logged event ("what happened
 * yesterday?", "when did the cough start?") by querying the stored `log_entry` rows
 * DETERMINISTICALLY (date-range / keyword / category filtering, no KB vectors and no
 * LLM — works with zero keys). Composes a plain-language recall `say` in code (recall
 * only, zero interpretation — never compares/advises/triages) and, when the caregiver
 * asks to list them, emits a single RETAINED card (≤3-line body, no action, max one
 * active card). No match → says so plainly with no card. Both this and the extraction
 * runner carry `mode: 'log'`; the orchestrator selects between them via
 * {@link isLogRetrievalQuery}. `createLogRetrievalRunner` returns a {@link ModeRunner};
 * `runLogRetrieval` is the testable core.
 */
export {
  createLogRetrievalRunner,
  runLogRetrieval,
  parseQuery,
  parseDateWindow,
  extractKeywords,
  queryEntries,
  isOnsetQuery,
  isListRequest,
  buildNoMatchSay,
  buildOnsetSay,
  buildRecallSay,
  buildRetrievalCard,
  relativeWhen as retrievalRelativeWhen,
  MAX_SPOKEN_ENTRIES,
  MAX_CARD_ENTRIES,
  RETRIEVAL_CARD_TITLE,
  type LogQuery,
  type LogRetrievalDeps,
} from './log-retrieval.js';

/**
 * Appointment-creation mode — the ADD-by-voice path (Task 28, R12.1). The direct
 * analog of the care-log extraction mode (`log.prompt`, Task 26): extracts a dictated
 * appointment ("Add an appointment with Dr. Lee on Tuesday at 2pm for a follow-up",
 * "Schedule oncology next Friday") into a structured record (title / at / with_whom /
 * purpose), emits ONE `add_appointment` memory op so the appointment flows only through
 * the validated contract (persisted via `repos.appointment.create` in the
 * contract-validator write path), confirms with PASSIVE phrasing composed in code
 * ("Added — appointment with Dr. Lee, Tuesday at 2pm"), and creates a single RETAINED
 * appointment card. Degrades to a deterministic single-field extraction (title = the
 * verbatim utterance) with no live LLM (R16.4 spirit). Appointment CREATION shares the
 * `prep` mode tag with retrieval/briefings (Tasks 29/30); the orchestrator selects
 * between them via {@link isAppointmentCreation}. `createAppointmentRunner` returns a
 * {@link ModeRunner} with `mode: 'prep'`; `runAppointment` is the testable core.
 */
export {
  createAppointmentRunner,
  runAppointment,
  extractAppointment,
  parseAppointmentJson,
  fallbackAppointment,
  buildConfirmation as buildAppointmentConfirmation,
  buildAppointmentCard,
  APPOINTMENT_SYSTEM,
  APPOINTMENT_CARD_TITLE,
  type AppointmentDeps,
  type AppointmentExtraction,
} from './appointment.js';

/**
 * Appointment prep-briefing mode — `prep.prompt` (Task 29, R12.2/R12.3). The read/
 * briefing sibling of the appointment-CREATION mode (Task 28): when a session occurs
 * within a configurable look-ahead window (default 48h, from `config.prepWindowHours`)
 * before an upcoming appointment whose time can be placed on a clock, it OFFERS a prep
 * briefing (purpose / what to report / suggested questions) and emits ONE retained card
 * for the nearest such appointment carrying the name, date, and a "what to ask" list.
 * In-window selection is deterministic over the store (`repos.appointment.listUpcoming`)
 * and works with zero keys; the suggested-question list is generated with a live LLM and
 * degrades to a neutral deterministic set otherwise (every provider has a fallback). No
 * appointment in window → says so plainly with no card. Briefings carry the `prep` mode
 * tag shared with creation; the orchestrator selects creation vs. briefing via
 * {@link isAppointmentCreation}. `createPrepRunner` returns a {@link ModeRunner} with
 * `mode: 'prep'`; `runPrep` is the testable core.
 */
export {
  createPrepRunner,
  runPrep,
  selectInWindow,
  parseAppointmentAt,
  suggestQuestions,
  parseQuestionList,
  fallbackQuestions,
  buildNoUpcomingSay,
  buildBriefingSay,
  buildBriefingCard,
  PREP_SYSTEM,
  DEFAULT_PREP_WINDOW_HOURS,
  MAX_BRIEFING_QUESTIONS,
  type PrepDeps,
  type AppointmentBriefing,
} from './prep.js';

/**
 * Visit-summary dictation mode — the "what the doctor said" write path (Task 30,
 * R12.4). The analog of the appointment-creation / care-log extraction modes: STRUCTURES
 * a dictated visit report ("The doctor said the scan was stable, come back in two
 * weeks") into a visit summary (headline / points / optional follow-up) and emits ONE
 * RETAINED card that is SHAREABLE VIA LINK — persisted with a stable id (stamped onto
 * the contract by the gateway) and carrying a `share` action pointing at the
 * shareable-link route (`GET /cards/:id`, base {@link SHARE_ROUTE_BASE}). Structuring
 * uses a live LLM and degrades to a deterministic structuring (the verbatim dictation as
 * a single point) with no key (R16.4 spirit). Best-effort anchors the summary to the
 * patient's obvious appointment so the card names it. "Structure, never interpret" is
 * enforced in code (say/card composed from neutral fields). Shares the `prep` mode tag;
 * the orchestrator selects this runner via {@link isVisitSummaryDictation}.
 * `createVisitSummaryRunner` returns a {@link ModeRunner} with `mode: 'prep'`;
 * `runVisitSummary` is the testable core.
 */
export {
  createVisitSummaryRunner,
  runVisitSummary,
  structureSummary,
  parseSummaryJson,
  fallbackSummary,
  pickAnchorAppointment,
  buildConfirmation as buildVisitSummaryConfirmation,
  buildVisitSummaryCard,
  VISIT_SUMMARY_SYSTEM,
  VISIT_SUMMARY_CARD_TITLE,
  SHARE_ROUTE_BASE,
  MAX_SUMMARY_POINTS,
  type VisitSummaryDeps,
  type VisitSummary,
} from './visit-summary.js';

/**
 * Prep/visit-summary voice retrieval mode — the "read it back" path (Task 30, R12.5).
 * The READ counterpart to the prep-briefing (Task 29) and visit-summary (Task 30) write
 * paths: answers a caregiver's request to pull BACK prep or summary content by voice
 * ("What were the questions for Tuesday?", "What did the doctor say?", "Read me the
 * visit summary") by querying the stored `card` rows DETERMINISTICALLY (kind + keyword /
 * day filtering across active + archived; no KB vectors, no LLM — works with zero keys).
 * On a hit it SPEAKS the matched card's content and RE-SURFACES the card (retained,
 * preserving its share action) so it can be shown/re-shared; no match → says so plainly
 * with no card. Recall only, zero interpretation. Shares the `prep` mode tag; the
 * orchestrator selects this runner via {@link isSummaryRetrievalQuery}.
 * `createSummaryRetrievalRunner` returns a {@link ModeRunner} with `mode: 'prep'`;
 * `runSummaryRetrieval` is the testable core.
 */
export {
  createSummaryRetrievalRunner,
  runSummaryRetrieval,
  parseSummaryQuery,
  extractKeywords as extractSummaryKeywords,
  matchCard,
  buildNoMatchSay as buildSummaryNoMatchSay,
  buildRecallSay as buildSummaryRecallSay,
  reSurfaceCard,
  type SummaryRetrievalDeps,
  type SummaryQuery,
  type SummaryKind,
} from './summary-retrieval.js';

/**
 * Recap & session close — `recap.prompt` (Task 32, R2.6 / R7.5 / R14.1–R14.3). The
 * session-closing composer: a closing phrase ("I have to go") routes the session to
 * CLOSING (deterministic {@link isClosingPhrase}) and this composer speaks a BRIEF,
 * warm recap of what was covered (R14.1) AND emits a single retained recap card
 * summarizing the session (R7.5/R14.2) — so the close is both spoken and shown. The
 * covered topics are INJECTED (the composer only sees the closing turn), phrased warmly
 * with a live LLM and degrading to a deterministic recap with zero keys so the close
 * still lands within R2.6's 20s budget. The recap card carries a stable title
 * ({@link RECAP_CARD_TITLE}); the gateway recognizes it via {@link isRecapCard} to
 * persist it as the session's long-term artifact (`session.recap_card_id`, R14.3).
 * `createRecapRunner` returns a {@link ModeRunner}; `runRecap` is the testable core.
 */
export {
  createRecapRunner,
  runRecap,
  isClosingPhrase,
  isRecapCard,
  composeRecapSay,
  buildRecapPrompt,
  buildDeterministicRecap,
  buildRecapCard,
  RECAP_SYSTEM,
  RECAP_TOPICS_PREFIX,
  RECAP_CARD_TITLE,
  RECAP_CLOSING_LINE,
  RECAP_EMPTY_SAY,
  MAX_RECAP_TOPICS,
  type RecapDeps,
} from './recap.js';

/**
 * Zero-key deterministic orchestrator wiring for end-to-end tests (Task 38). Assembles
 * the safety-first turn spine — classifier → crisis/medical bypass → CLOSING recap →
 * mode routing — from the already-deterministic composers, so the FULL conversation
 * spine runs end-to-end over the real gateway with no API keys. `createE2eProcessor`
 * returns an {@link Orchestrator} that satisfies the gateway's `TurnProcessor` seam.
 * This is NOT the production orchestrator, but its safety/CLOSING behavior is identical
 * because it calls the exact same composers.
 */
export { createE2eProcessor, type E2eProcessorDeps } from './e2e-processor.js';
