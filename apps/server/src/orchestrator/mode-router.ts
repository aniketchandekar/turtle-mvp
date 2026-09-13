import type { LlmMessage, LlmProvider } from '../services/llm/index.js';
import type { Repositories } from '../store/index.js';
import { MODES, type Mode, type ModeRouter } from './index.js';

/**
 * Mode router (Task 18, R6.1).
 *
 * The router runs AFTER the safety classifier (Task 16). Crisis and medical flags
 * bypass normal routing entirely — crisis → crisis protocol, medical →
 * `guardrail.refusal` — so this module only handles the `none` (non-safety) case and
 * NEVER re-implements safety classification. It picks which small routed prompt
 * (design.md §Orchestrator: small routed prompts) should own the turn:
 *
 *   checkin — supportive, memory-aware conversation (the default).
 *   qa      — grounded diagnosis questions.
 *   log     — care-log dictation (utterance → structured entries).
 *   prep    — appointment retrieval / prep briefings.
 *
 * ROUTING STRATEGY (design.md §Mode router):
 *   1. Cheap DETERMINISTIC RULES first, to catch obvious cases before spending an
 *      LLM call:
 *        - log retrieval   ("what happened yesterday", "when did the cough start") → log
 *        - log dictation   ("gave the 2pm meds", "slept badly", "new cough")   → log
 *        - appointment CREATE ("add an appointment with Dr Lee", "schedule oncology") → prep
 *        - appointment/prep ("what were the questions for Tuesday",
 *          "when is the appointment", "what did the doctor say")               → prep
 *        - diagnosis Q&A    ("what is metastatic cancer", "why is he …")       → qa
 *      Both log rules resolve to the `log` mode; the orchestrator then chooses the
 *      retrieval runner (read) vs. the extraction runner (write) via
 *      {@link isLogRetrievalQuery}. Likewise both appointment rules resolve to the
 *      `prep` mode; the orchestrator chooses the creation runner (write, Task 28) vs.
 *      the retrieval/briefing runner (read, Tasks 29/30) via
 *      {@link isAppointmentCreation}.
 *   2. For everything the rules do not confidently catch, fall back to a small intent
 *      classification via the LLM. Because the LLM adapter degrades to a canned
 *      provider when no key is present (zero-key degradation), the classifier
 *      degrades GRACEFULLY to a sensible default (`checkin`) whenever no live LLM is
 *      available or the classification is unusable.
 *   3. Route to exactly one of checkin / qa / log / prep.
 *
 * RECORDING THE CHOSEN MODE (R6.1, "record the chosen mode in mode_transitions").
 * The session stores `mode_transitions` (see the `session` data model and
 * `repos.session.appendTransition`, already used by the state machine to record
 * assistant-state transitions). The chosen mode is appended there through the same
 * repository seam rather than a new persistence path — see {@link recordMode} and the
 * optional `record` hook wired into {@link createModeRouter}.
 *
 * Like the sibling orchestrator modules (contract-validator, guardrail), everything
 * here is injectable: the LLM provider and the record hook are supplied by the
 * caller, so the whole surface — rules hits, classifier fallback, zero-key default,
 * and mode_transitions recording — is unit-testable with fakes and zero network.
 */

/** A deterministic routing rule: a test over lowercased user text → a mode. */
interface RoutingRule {
  readonly mode: Mode;
  readonly test: (lowerText: string) => boolean;
}

/**
 * Log-RETRIEVAL phrasing (Task 27, R11.4): the caregiver is ASKING ABOUT a past care
 * event they logged ("what happened yesterday?", "when did the cough start?", "what
 * did I log on Monday?"). These are questions, but they are questions about the CARE
 * LOG, so they route to `log` (the retrieval runner), NOT to Q&A (diagnosis facts).
 * Evaluated BEFORE the diagnosis-Q&A rules so a log question about a symptom
 * ("when did the cough start") is answered from the log rather than the KB.
 *
 * Kept narrow around the two hero shapes — "what happened / what did I log …" over a
 * time window, and "when did … start" onset — plus explicit "in the (care) log"
 * mentions, so it does not swallow genuine diagnosis questions.
 */
const LOG_RETRIEVAL_PATTERNS: RegExp[] = [
  // "what happened yesterday / on monday / last week"
  /\bwhat (happened|went on)\b/,
  // "what did I log / note / record …", "what have I logged …"
  /\bwhat (did|have) (i|we)\b.*\b(log|logged|note|noted|record|recorded)\b/,
  // onset — "when did the cough start", "when did the nausea begin"
  /\bwhen did\b.*\b(start|started|begin|began|first)\b/,
  /\bwhen (was|were)\b.*\b(the )?(first|start)\b/,
  // explicit references to the care log
  /\b(in|from|check|look at|pull up|show me)\b.*\b(care )?log\b/,
  /\bcare log\b/,
];

/**
 * Log-dictation phrasing: the caregiver is RECORDING something that happened
 * (medication given, a symptom, sleep, food, an event). These are statements about
 * the patient's state/care, not questions. Kept deliberately narrow so genuine
 * questions ("did he take his meds?") fall through to Q&A / classification.
 */
const LOG_PATTERNS: RegExp[] = [
  // medication_given — "gave the 2pm meds", "took his morning pills", "gave her the dose"
  /\b(gave|took|had|administered)\b.*\b(med|meds|medication|medications|pill|pills|dose|doses|tablet|tablets)\b/,
  /\b(meds|medication|pills?|dose)\b.*\b(given|taken|done)\b/,
  // sleep — "slept badly", "didn't sleep", "was up all night"
  /\b(slept|sleeping)\b/,
  /\b(did ?n['’]?t|didnt|barely|hardly)\b.*\bsleep\b/,
  /\bup all night\b/,
  // food/appetite — "barely ate", "wouldn't eat", "ate a little"
  /\b(ate|eating)\b/,
  /\b(did ?n['’]?t|didnt|would ?n['’]?t|wouldnt|barely|hardly)\b.*\beat\b/,
  // symptom report — "new cough", "the nausea is worse", "more pain today"
  /\bnew (cough|pain|rash|symptom|fever|swelling)\b/,
  /\b(cough|nausea|pain|fever|vomit|vomited|threw up|temperature|swelling)\b.*\b(worse|started|again|today|this morning|tonight)\b/,
  // generic dictation lead-ins — "just to note", "log that", "note that"
  /\b(log|note|noting|record) that\b/,
  /^just (to )?(note|log|record)\b/,
];

/**
 * Appointment-CREATION phrasing (Task 28, R12.1): the caregiver is DICTATING a new
 * appointment to add ("add an appointment with Dr. Lee on Tuesday", "schedule oncology
 * next Friday", "book a follow-up with Dr. Chen", "set up a scan appointment"). These
 * are imperative ADD statements, distinct from the RETRIEVAL questions in
 * {@link PREP_PATTERNS} ("when is the appointment"). Both families route to the `prep`
 * mode; the orchestrator then picks the creation runner vs. the retrieval/briefing
 * runner via {@link isAppointmentCreation}, mirroring how {@link isLogRetrievalQuery}
 * splits the `log` family.
 *
 * Kept narrow around the ADD verbs (add / schedule / book / set up / make) paired with
 * an appointment/visit noun (or a clinician), so genuine diagnosis/checkin turns and
 * retrieval questions are NOT swallowed. The patterns deliberately do not match bare
 * questions ("when …", "what …"), which fall through to the retrieval PREP rule.
 */
const APPOINTMENT_CREATE_PATTERNS: RegExp[] = [
  // "add an appointment", "add a visit", "add an appt with Dr Lee"
  /\badd (an?|another) (appointment|appt|visit|checkup|check-up)\b/,
  // "schedule oncology", "schedule an appointment", "schedule a follow-up with Dr Lee".
  // The verb sense requires a following object (an appointment noun or a clinician), so
  // a bare noun-sense "the schedule" does not match — retrieval questions fall through
  // to the PREP retrieval rule instead.
  /\bschedule (an?|the|a)?\s*(appointment|appt|visit|checkup|check-up|oncology|oncologist|scan|labs|bloodwork|follow-?up|dr\.?|doctor)\b/,
  // "book a follow-up", "book an appointment with Dr Chen"
  /\bbook (an?|the|a)?\b.*\b(appointment|appt|visit|checkup|check-up|scan|labs|bloodwork|follow-?up|dr\.?|doctor|oncolog)/,
  // "set up a scan appointment", "set up an appointment with the nurse"
  /\bset up (an?|the|a)?\b.*\b(appointment|appt|visit|checkup|check-up|scan|labs|bloodwork|follow-?up|dr\.?|doctor|oncolog)/,
  // "make an appointment", "make a follow-up appointment"
  /\bmake (an?|the|a)?\b.*\b(appointment|appt|visit|checkup|check-up)\b/,
  // "new appointment with Dr Lee on Tuesday" — a bare ADD without an explicit verb
  /\bnew (appointment|appt|visit)\b.*\b(with|on|for|at)\b/,
];

/**
 * Visit-summary DICTATION phrasing (Task 30, R12.4): after a visit the caregiver is
 * TELLING Turtle what happened so it can be structured and kept ("The doctor said the
 * scan was stable and to keep the same dose", "What the doctor said today: labs look
 * good, come back in two weeks", "Here's what happened at the appointment…"). These are
 * dictation STATEMENTS to record, distinct from the RETRIEVAL questions in
 * {@link SUMMARY_RETRIEVAL_PATTERNS} ("what did the doctor say?"). Both families route to
 * `prep`; the orchestrator then picks the visit-summary runner (write, Task 30) via
 * {@link isVisitSummaryDictation}, mirroring how {@link isAppointmentCreation} splits
 * creation from retrieval.
 *
 * The two families overlap on the words "doctor said", so the split is by GRAMMAR, not
 * keyword: a dictation carries the SUBSTANCE the clinician conveyed (a "said/told …
 * <content>" clause, or an explicit "what the doctor said:" lead-in with a body), while
 * a retrieval is a bare question. To avoid swallowing questions, the dictation patterns
 * deliberately do NOT match a turn ending in a question mark or opening with the
 * interrogative "what did …".
 */
const VISIT_SUMMARY_DICTATION_PATTERNS: RegExp[] = [
  // "the doctor said <content>", "the oncologist told me <content>" — a report clause
  // with substance after the verb (at least a few words), not a bare question.
  /\b(the )?(doctor|oncologist|nurse|clinician|dr\.?|they|she|he)\b.*\b(said|told me|explained|mentioned|recommended|wants|said to|told us)\b\s+\S+/,
  // explicit dictation lead-ins — "what the doctor said today:", "here's what happened
  // at the appointment", "at the appointment …". A bare "visit summary" NOUN phrase is
  // deliberately NOT a dictation cue (it is far more often a RETRIEVAL ask, e.g. "read
  // me the visit summary"); dictation is recognized by a report clause or a lead-in
  // followed by a body/separator, not by the noun alone.
  /\bwhat (the )?(doctor|oncologist|nurse|clinician|dr\.?) said\b.*[:,-]/,
  /\bhere'?s what (happened|the doctor said)\b/,
  /^(at|after) (the|today'?s|yesterday'?s)? ?(visit|appointment|checkup|check-up)\b/,
];

/**
 * Prep/visit-summary RETRIEVAL phrasing (Task 30, R12.5): the caregiver is ASKING to
 * pull BACK prep or summary content by voice ("What were the questions for Tuesday?",
 * "What did the doctor say?", "Read me the visit summary"). Routes to `prep`; the
 * orchestrator selects the summary-retrieval runner via {@link isSummaryRetrievalQuery}.
 * These are questions, evaluated AFTER dictation so a report statement wins over a
 * retrieval match on the shared "doctor said" words.
 */
const SUMMARY_RETRIEVAL_PATTERNS: RegExp[] = [
  // retrieval of prep questions — "what were the questions for Tuesday"
  /\bquestions?\b.*\b(for|about|before|from)\b.*\b(appointment|visit|tuesday|monday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|yesterday)\b/,
  // visit summary retrieval — "what did the doctor say", "what the doctor said?"
  /\bwhat (did|do)\b.*\b(the )?(doctor|oncologist|nurse|clinician|dr\.?)\b.*\bsay\b/,
  // "read me / pull up / show me the (visit) summary / prep / questions"
  /\b(read|read me|pull up|show me|give me|what were|what was)\b.*\b(visit )?(summary|summaries|recap|prep|questions?|notes?)\b/,
];

/**
 * Appointment retrieval / prep phrasing: the caregiver is asking about an
 * appointment, its prep questions, or what a clinician said (a stored visit summary).
 * Routes to `prep`, which owns both the briefing and the retrieval of prep/summary
 * content by voice (design.md §Mode router; Task 29/30). Evaluated AFTER
 * {@link APPOINTMENT_CREATE_PATTERNS} so an ADD statement wins over a retrieval match.
 */
const PREP_PATTERNS: RegExp[] = [
  // retrieval of prep questions — "what were the questions for Tuesday"
  /\bquestions?\b.*\b(for|about|before)\b.*\b(appointment|visit|tuesday|monday|wednesday|thursday|friday|saturday|sunday|tomorrow)\b/,
  /\bwhat (should|do) i ask\b/,
  // appointment timing/details — "when is the appointment", "the next appointment"
  /\bwhen('?s| is| are)\b.*\b(the )?(appointment|visit|checkup|check-up|oncologist|doctor)\b/,
  /\b(next|upcoming) (appointment|visit|checkup|check-up)\b/,
  /\bprep(are)?\b.*\b(appointment|visit)\b/,
  // visit summary retrieval — "what did the doctor say", "what the doctor said"
  /\bwhat (did|do)\b.*\b(the )?(doctor|oncologist|nurse|clinician|dr\.?)\b.*\bsay\b/,
  /\bwhat (the )?(doctor|oncologist|nurse|clinician|dr\.?)\b.*\bsaid\b/,
];

/**
 * Diagnosis-question phrasing: the caregiver is asking to understand the illness or
 * its symptoms/treatment in general terms. Routes to `qa` (grounded answerer). This
 * is intentionally about UNDERSTANDING ("what is / why does / what causes"), never a
 * clinical DECISION — those are caught earlier by the safety classifier as `medical`
 * and never reach the router.
 */
const QA_PATTERNS: RegExp[] = [
  /\bwhat (is|are|does|causes)\b/,
  /\bwhy (is|are|does|do|would)\b/,
  /\bhow (does|do|long|come)\b/,
  /\b(metasta|diagnosis|prognosis|chemo|chemotherapy|radiation|tumor|tumour|cancer|treatment)\b.*\?/,
  /\bwhat (should|can) i expect\b/,
  /\bmean(s)?\b.*\?/,
];

/**
 * Deterministic rules, evaluated in priority order (first match wins).
 *
 * Log-RETRIEVAL is tested before log-dictation and Q&A: a care-log question ("when did
 * the cough start", "what happened yesterday") must reach the `log` retrieval runner
 * rather than the diagnosis Q&A grounder. Both log dictation and log retrieval route to
 * the `log` mode — the orchestrator selects the extraction vs. retrieval runner via
 * {@link isLogRetrievalQuery}.
 */
const RULES: RoutingRule[] = [
  { mode: 'log', test: (t) => LOG_RETRIEVAL_PATTERNS.some((re) => re.test(t)) },
  { mode: 'log', test: (t) => LOG_PATTERNS.some((re) => re.test(t)) },
  // Appointment CREATION and RETRIEVAL both route to `prep`; the orchestrator selects
  // the creation vs. retrieval runner via {@link isAppointmentCreation}. Creation is
  // tested first so an ADD statement ("schedule oncology") wins over a retrieval match.
  { mode: 'prep', test: (t) => APPOINTMENT_CREATE_PATTERNS.some((re) => re.test(t)) },
  // Visit-summary DICTATION (write, Task 30) is tested before the RETRIEVAL/prep rules
  // so a report statement ("the doctor said the scan was stable") wins over a bare
  // "doctor said" retrieval match; the orchestrator selects the visit-summary runner
  // via {@link isVisitSummaryDictation}. Retrieval questions fall through to PREP.
  { mode: 'prep', test: (t) => isVisitSummaryDictationText(t) },
  { mode: 'prep', test: (t) => PREP_PATTERNS.some((re) => re.test(t)) },
  { mode: 'qa', test: (t) => QA_PATTERNS.some((re) => re.test(t)) },
];

/**
 * Distinguish a care-log RETRIEVAL question from a log DICTATION statement WITHIN the
 * `log` mode (Task 27, R11.4). The mode router routes both to `log`; the orchestrator
 * calls this to pick the retrieval runner (read) vs. the extraction runner (write).
 * Rules-only and LLM-free so it works with zero keys, mirroring the router's rules.
 * Exported so callers/tests can select the runner without re-deriving the intent.
 */
export function isLogRetrievalQuery(userText: string): boolean {
  return LOG_RETRIEVAL_PATTERNS.some((re) => re.test(userText.toLowerCase()));
}

/**
 * Distinguish an appointment-CREATION statement from an appointment-RETRIEVAL / prep
 * question WITHIN the `prep` mode (Task 28, R12.1). The mode router routes both to
 * `prep`; the orchestrator calls this to pick the creation runner (write —
 * {@link import('./appointment.js').createAppointmentRunner}) vs. the retrieval/
 * briefing runner (read — Tasks 29/30). Rules-only and LLM-free so it works with zero
 * keys, mirroring {@link isLogRetrievalQuery}. Exported so callers/tests can select the
 * runner without re-deriving the intent.
 */
export function isAppointmentCreation(userText: string): boolean {
  return APPOINTMENT_CREATE_PATTERNS.some((re) => re.test(userText.toLowerCase()));
}

/**
 * Rules-only check for visit-summary DICTATION on lowercased text (Task 30, R12.4). A
 * dictation is a REPORT of what the clinician conveyed, never a bare question — so a
 * turn that ends in a question mark or opens with the interrogative "what did …" is
 * excluded even if it mentions "doctor said". Kept as a private text-level helper so
 * both the routing rule and the exported {@link isVisitSummaryDictation} share one
 * definition.
 */
function isVisitSummaryDictationText(lower: string): boolean {
  // A trailing "?" or an interrogative "what did the doctor say" opener is retrieval,
  // not dictation — let it fall through to the retrieval rules.
  if (/\?\s*$/.test(lower)) return false;
  if (/^\s*what (did|do)\b/.test(lower)) return false;
  return VISIT_SUMMARY_DICTATION_PATTERNS.some((re) => re.test(lower));
}

/**
 * Distinguish a visit-summary DICTATION statement (write — structure "what the doctor
 * said" into a shareable summary card) from a prep/summary RETRIEVAL question WITHIN
 * the `prep` mode (Task 30, R12.4/R12.5). The mode router routes both to `prep`; the
 * orchestrator calls this to pick the visit-summary runner
 * ({@link import('./visit-summary.js').createVisitSummaryRunner}) vs. the
 * summary-retrieval runner ({@link import('./summary-retrieval.js').createSummaryRetrievalRunner}).
 * Rules-only and LLM-independent so the SELECTION works with zero keys, mirroring
 * {@link isAppointmentCreation} / {@link isLogRetrievalQuery}. Exported so callers/tests
 * can select the runner without re-deriving the intent.
 */
export function isVisitSummaryDictation(userText: string): boolean {
  return isVisitSummaryDictationText(userText.toLowerCase());
}

/**
 * True when the caregiver is ASKING to retrieve prep or summary content by voice (Task
 * 30, R12.5): "What were the questions for Tuesday?", "What did the doctor say?", "Read
 * me the visit summary". A dictation statement is NOT a retrieval, so this returns false
 * whenever {@link isVisitSummaryDictation} is true (the write path wins), keeping the two
 * `prep` sub-intents mutually exclusive. Rules-only and LLM-free. Exported so callers/
 * tests can select the summary-retrieval runner without re-deriving the intent.
 */
export function isSummaryRetrievalQuery(userText: string): boolean {
  const lower = userText.toLowerCase();
  if (isVisitSummaryDictationText(lower)) return false;
  return SUMMARY_RETRIEVAL_PATTERNS.some((re) => re.test(lower));
}

/** The default mode when nothing else confidently matches (design.md §Mode router). */
export const DEFAULT_MODE: Mode = 'checkin';

/**
 * Apply the cheap deterministic rules to user text. Returns the matched mode, or
 * `null` when no rule fires confidently (the caller then falls back to the LLM intent
 * classifier). Exported so the rules are unit-testable in isolation.
 */
export function routeByRules(userText: string): Mode | null {
  const lower = userText.toLowerCase();
  for (const rule of RULES) {
    if (rule.test(lower)) return rule.mode;
  }
  return null;
}

/** System prompt for the small intent classifier (used only when rules miss). */
const CLASSIFIER_SYSTEM =
  'You are an intent classifier for a caregiver voice assistant. The user text is NOT a ' +
  'safety concern (crisis and medical requests are handled elsewhere). Classify the turn into ' +
  'exactly one intent and reply with ONLY that single lowercase word, no punctuation:\n' +
  '- checkin: emotional support, venting, or general conversation.\n' +
  '- qa: a question about the illness, its symptoms, or treatment in general.\n' +
  '- log: recording something that happened (medication given, a symptom, sleep, food, an event).\n' +
  '- prep: anything about an appointment, prep questions, or what a clinician said.';

/**
 * Map a raw classifier reply onto a valid {@link Mode}. Tolerates surrounding prose /
 * punctuation by scanning for the first mode word. Returns `null` when the reply
 * contains no recognizable mode (so the caller uses the safe default).
 */
export function parseClassifiedMode(raw: string): Mode | null {
  const lower = raw.toLowerCase();
  for (const mode of MODES) {
    // Word-boundary match so "checkin" isn't found inside an unrelated token.
    if (new RegExp(`\\b${mode}\\b`).test(lower)) return mode;
  }
  return null;
}

/** Dependencies for the mode router (DI style, mirroring the sibling modules). */
export interface ModeRouterDeps {
  /**
   * The resolved LLM provider used for the small intent classification fallback. When
   * omitted, or when the provider is the canned (non-live) fallback, the router skips
   * the classifier and returns the safe default — zero-key graceful degradation.
   */
  llm?: LlmProvider;
  /**
   * Optional hook to record the chosen mode in the session's mode_transitions (R6.1).
   * Supplied by the orchestrator/gateway as `(mode) => repos.session.appendTransition(
   * sessionId, mode)`. When omitted the router still routes; recording is a side
   * effect the caller opts into. See {@link recordMode} for the store-backed builder.
   */
  record?: (mode: Mode) => void;
}

/**
 * Build a session-scoped `record` hook that appends the chosen mode to the session's
 * `mode_transitions` through the existing repository seam (the same one the state
 * machine uses for assistant-state transitions). The mode is prefixed `mode:` so the
 * routed mode is distinguishable from state names in the shared transition list.
 */
export function recordMode(repos: Repositories, sessionId: string): (mode: Mode) => void {
  return (mode: Mode) => repos.session.appendTransition(sessionId, `mode:${mode}`);
}

/**
 * Create a {@link ModeRouter}: rules-first, then a small LLM intent classification for
 * the rest, degrading gracefully to `checkin` with no live LLM. Every routed turn's
 * mode is recorded via the optional `record` hook (R6.1).
 *
 * @param deps - injectable LLM provider + mode-recording hook.
 */
export function createModeRouter(deps: ModeRouterDeps = {}): ModeRouter {
  return {
    async route(userText: string): Promise<Mode> {
      const mode = await resolveMode(userText, deps.llm);
      deps.record?.(mode);
      return mode;
    },
  };
}

/**
 * Resolve the routed mode WITHOUT recording it: deterministic rules first, then the
 * LLM intent classifier, then the safe default. Exported so callers/tests can inspect
 * the routing decision independently of the mode_transitions side effect.
 */
export async function resolveMode(userText: string, llm?: LlmProvider): Promise<Mode> {
  // 1) Cheap deterministic rules catch obvious cases before spending an LLM call.
  const ruled = routeByRules(userText);
  if (ruled) return ruled;

  // 2) Fall back to a small intent classification — but only with a LIVE provider.
  //    With no key the adapter is the canned/echo provider (live === false); running
  //    it would just echo the user text, which is not a usable classification. So we
  //    skip it and degrade gracefully to the default (zero-key degradation, R16.4).
  if (llm && llm.live) {
    const classified = await classifyIntent(userText, llm);
    if (classified) return classified;
  }

  // 3) Nothing confident matched → the safe, supportive default.
  return DEFAULT_MODE;
}

/**
 * Run the small intent classifier over the user text and map its reply onto a valid
 * mode. Returns `null` when the provider errors or the reply is unusable, so the
 * caller falls back to the default rather than throwing mid-turn.
 */
async function classifyIntent(userText: string, llm: LlmProvider): Promise<Mode | null> {
  const messages: LlmMessage[] = [
    { role: 'system', content: CLASSIFIER_SYSTEM },
    { role: 'user', content: userText },
  ];
  try {
    // The classifier prompt asks for a bare word; the provider's `complete` returns a
    // ModeOutput whose `say` carries that word. We read the mode out of `say`.
    const output = await llm.complete(messages);
    return parseClassifiedMode(output.say);
  } catch {
    return null;
  }
}
