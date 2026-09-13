/**
 * Conversation-quality rubric (Task 38; design.md §Testing "Conversation quality —
 * Rubric-scored transcripts (warmth, brevity, no advice creep)").
 *
 * A DETERMINISTIC, LLM-free scorer for Turtle's spoken lines against the product's voice
 * bar (product.md §Conversation quality bar): warm and brief, plain language, no
 * platitudes, and — critically — NO ADVICE CREEP. It is deliberately rule-based so it
 * runs with zero keys and its verdict is a stable regression signal: a prompt/composer
 * change that makes Turtle preachy, long-winded, or clinical will drop a score below its
 * threshold and fail the suite before merge.
 *
 * This is NOT a model grader. It cannot judge nuance the way a human reviewer does; it
 * catches the mechanical failure modes the voice bar names — length blowups, advice/
 * imperative creep, platitudes, and cold openings — which is what a cheap regression gate
 * should do. The three dimensions map directly to the design's rubric axes.
 *
 * SCOPE. The rubric scores ordinary CONVERSATIONAL turns (check-in, acknowledgements,
 * recaps). Safety turns are intentionally exempt from the advice-creep and some brevity
 * rules: a medical refusal MUST state a limit and redirect, and a crisis response MUST
 * name resources — that is required content, not advice creep. Callers pass
 * `{ safety: true }` for those turns; {@link scoreTurn} then applies only the warmth and
 * plain-language checks.
 */

/** The three rubric axes, each scored 0..1. */
export interface RubricScores {
  /** Warm and human: acknowledges/validates, second-person, not cold or clipped. */
  warmth: number;
  /** Brief: a spoken turn, not an essay. Penalizes long, multi-sentence monologues. */
  brevity: number;
  /**
   * No advice creep: no imperatives telling the caregiver what to DO, no clinical
   * prescriptions, no "you should". Safety redirects are exempt (see {@link scoreTurn}).
   */
  noAdviceCreep: number;
}

/** A scored turn with its per-axis scores and the reasons behind any deductions. */
export interface TurnScore extends RubricScores {
  /** The overall score: the mean of the applicable axes (0..1). */
  overall: number;
  /** Human-readable reasons for deductions, for actionable test failures. */
  reasons: string[];
}

/** Options for {@link scoreTurn}. */
export interface ScoreOptions {
  /**
   * True for a SAFETY turn (medical refusal / crisis). Safety turns carry required
   * content (a stated limit, a redirect, named resources) that would otherwise look like
   * advice or length creep, so the advice-creep axis is not applied and brevity is
   * relaxed. Warmth and plain-language checks still apply.
   */
  safety?: boolean;
  /**
   * True for a care-log CONFIRMATION turn (R11.2/R11.3). Log confirmations are
   * DELIBERATELY neutral and passive ("Noted — the 2pm meds logged") — the product rule
   * is "log, never interpret", so a confirmation must NOT editorialize or inject warmth
   * about what was logged. It is therefore exempt from the warmth axis; brevity and the
   * no-advice-creep check (a confirmation must never advise) still apply.
   */
  logConfirmation?: boolean;
}

/**
 * Passing thresholds per axis (0..1). Kept strict enough to catch the failure modes the
 * voice bar names, loose enough not to be brittle about ordinary phrasing. A turn passes
 * when every APPLICABLE axis is at or above its threshold.
 */
export const RUBRIC_THRESHOLDS = {
  warmth: 0.6,
  brevity: 0.6,
  noAdviceCreep: 1, // advice creep is a hard fail: any imperative/prescription trips it.
} as const;

// ---------------------------------------------------------------------------
// Lexicons — small, legible, and exported-free (implementation detail).
// ---------------------------------------------------------------------------

/** Warm markers: acknowledgement, validation, presence, and second-person address. */
const WARMTH_MARKERS: RegExp[] = [
  /\bi hear you\b/,
  /\bi'?m here\b/,
  /\bthank you\b/,
  /\bthat sounds\b/,
  /\bi'?m (so )?(glad|sorry)\b/,
  /\bit'?s (okay|ok|hard|a lot)\b/,
  /\btake care\b/,
  /\bholding up\b/,
  /\byou'?re not alone\b/,
  /\bwith you\b/,
  /\btell me\b/,
  /\bhow (are|was|did|has)\b/,
];

/**
 * Platitudes / cliché reassurances the voice bar rejects ("No platitudes"). These are
 * hollow comfort phrases, distinct from genuine validation.
 */
const PLATITUDES: RegExp[] = [
  /\beverything (will|happens|is going to) (be (okay|ok|fine|alright)|for a reason)\b/,
  /\bstay (strong|positive)\b/,
  /\bkeep your chin up\b/,
  /\blook on the bright side\b/,
  /\bit'?s all part of (the|god'?s) plan\b/,
  /\btime heals all\b/,
  /\bevery cloud has a silver lining\b/,
];

/**
 * Advice-creep markers: imperatives / prescriptions that tell the caregiver what to DO.
 * The voice bar forbids advice creep in conversational turns; "log, never interpret" and
 * "at most one coping suggestion" mean a normal turn should not be issuing directives.
 * We match "you should/need to/must/have to", "make sure you", and bare clinical
 * imperatives ("give him", "take her to", "increase the dose"). Question forms ("would
 * it help to…") are NOT advice — only directive statements are.
 */
const ADVICE_MARKERS: RegExp[] = [
  /\byou (should|need to|must|have to|ought to)\b/,
  /\bmake sure (you|to|that)\b/,
  /\bbe sure to\b/,
  /\btry to\b(?!\s*(rest|relax|be kind|go easy))/, // allow gentle self-care, not directives
  /\b(you'?d better|i'?d recommend|i recommend|i suggest|my advice)\b/,
  // clinical imperatives — telling the caregiver to medicate / escalate.
  /\b(give|administer)\s+(him|her|them)\b.*\b(dose|pill|med|medication|morphine|tylenol|ibuprofen)\b/,
  /\b(increase|decrease|double|cut|stop|start)\s+(the|his|her)\s+(dose|medication|meds)\b/,
  /\b(take|get)\s+(him|her|them)\s+to\s+(the )?(er|hospital|doctor)\b/,
];

/** Count sentences by terminal punctuation, tolerating trailing whitespace. */
function sentenceCount(text: string): number {
  const parts = text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return Math.max(1, parts.length);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function anyMatch(text: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// Scoring.
// ---------------------------------------------------------------------------

/**
 * Score warmth (0..1). Full marks when the line carries a warm marker and addresses the
 * caregiver in the second person; partial when only one is present; a floor otherwise.
 * A platitude is a hard deduction — hollow reassurance is not warmth.
 */
function scoreWarmth(lower: string, reasons: string[]): number {
  let score = 0.4; // a neutral, non-cold baseline
  if (anyMatch(lower, WARMTH_MARKERS)) score += 0.4;
  else reasons.push('warmth: no acknowledgement/validation marker');
  if (/\byou\b|\byour\b|\byou'?re\b/.test(lower)) score += 0.2;
  else reasons.push('warmth: not addressed to the caregiver (no second person)');
  if (anyMatch(lower, PLATITUDES)) {
    score -= 0.6;
    reasons.push('warmth: uses a platitude (hollow reassurance)');
  }
  return clamp01(score);
}

/**
 * Score brevity (0..1). A spoken turn should be short. Full marks up to ~2 sentences /
 * ~35 words; graceful decay beyond that; safety turns are given more room (a refusal /
 * crisis line carries required content). The bar: "Short turns."
 */
function scoreBrevity(text: string, safety: boolean, reasons: string[]): number {
  const sentences = sentenceCount(text);
  const words = wordCount(text);
  const sentenceCap = safety ? 5 : 3;
  const wordCap = safety ? 75 : 45;
  let score = 1;
  if (sentences > sentenceCap) {
    score -= 0.25 * (sentences - sentenceCap);
    reasons.push(`brevity: ${sentences} sentences (> ${sentenceCap})`);
  }
  if (words > wordCap) {
    // Word blowups are the dominant brevity failure (a single run-on sentence can be an
    // essay). Penalize past the cap steeply so a long monologue drops well below the
    // passing threshold regardless of sentence count.
    score -= Math.min(0.7, 0.02 * (words - wordCap));
    reasons.push(`brevity: ${words} words (> ${wordCap})`);
  }
  return clamp01(score);
}

/**
 * Score no-advice-creep (0/1). Binary and strict for conversational turns: ANY directive
 * imperative or clinical prescription trips it to 0. Safety turns are exempt (their
 * redirect/resource content is required, not advice) — the caller marks them via
 * {@link ScoreOptions.safety} and this axis is skipped for them.
 */
function scoreNoAdviceCreep(lower: string, reasons: string[]): number {
  if (anyMatch(lower, ADVICE_MARKERS)) {
    reasons.push('advice creep: contains a directive/prescriptive imperative');
    return 0;
  }
  return 1;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Score one assistant `say` line against the rubric. For a conversational turn all three
 * axes apply; for a safety turn ({@link ScoreOptions.safety}) the advice-creep axis is
 * skipped and brevity is relaxed. `overall` is the mean of the applicable axes.
 */
export function scoreTurn(say: string, options: ScoreOptions = {}): TurnScore {
  const safety = options.safety ?? false;
  const logConfirmation = options.logConfirmation ?? false;
  const text = say.trim();
  const lower = text.toLowerCase();
  const reasons: string[] = [];

  const warmth = scoreWarmth(lower, reasons);
  const brevity = scoreBrevity(text, safety, reasons);
  // Advice creep applies to every non-safety turn, including a log confirmation (a
  // confirmation must never slip into advice). Safety redirects are the only exemption.
  const noAdviceCreep = safety ? 1 : scoreNoAdviceCreep(lower, reasons);

  // Which axes count toward the overall / pass decision: safety and log-confirmation
  // turns are exempt from the warmth requirement (their content is required / neutral by
  // design); safety turns are additionally exempt from advice creep.
  const applicable: number[] = [brevity];
  if (!safety && !logConfirmation) applicable.push(warmth);
  if (!safety) applicable.push(noAdviceCreep);
  const overall = applicable.reduce((a, b) => a + b, 0) / applicable.length;

  return { warmth, brevity, noAdviceCreep, overall, reasons };
}

/**
 * True when a scored turn meets every APPLICABLE threshold. Safety turns skip warmth and
 * advice-creep (required/neutral content); log-confirmation turns skip warmth (they are
 * deliberately neutral per R11.3) but still must be brief and advice-free.
 */
export function passesRubric(
  score: TurnScore,
  opts: boolean | { safety?: boolean; logConfirmation?: boolean } = false,
): boolean {
  const safety = typeof opts === 'boolean' ? opts : (opts.safety ?? false);
  const logConfirmation = typeof opts === 'boolean' ? false : (opts.logConfirmation ?? false);
  if (!safety && !logConfirmation && score.warmth < RUBRIC_THRESHOLDS.warmth) return false;
  if (score.brevity < RUBRIC_THRESHOLDS.brevity) return false;
  if (!safety && score.noAdviceCreep < RUBRIC_THRESHOLDS.noAdviceCreep) return false;
  return true;
}
