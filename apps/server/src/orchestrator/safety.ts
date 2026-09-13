import type { SafetyClassifier, SafetyVerdict } from './index.js';

/**
 * Safety classifier — the seed implementation (Task 16, R5.1/R5.2/R5.3; hardened by the
 * eval harness in Task 34, R5.6/R15.1/R15.3).
 *
 * This is the FIRST step of every turn (design.md §Orchestrator; safety.md §Order of
 * operations): it runs on the RAW user text before any mode routing. Its verdict decides
 * whether the turn bypasses normal routing:
 *
 *   crisis  → the crisis protocol (composeCrisisResponse) — suicidal ideation, self-harm, abuse.
 *   medical → the medical guardrail refusal (composeMedicalRefusal) — requests for a CLINICAL
 *             DECISION: medication selection/dosing/timing/interactions, prognosis /
 *             life-expectancy, symptom triage ("should I go to the ER?").
 *   none    → normal routing (mode router) — everything else, INCLUDING benign
 *             medically-adjacent caregiver observation and venting ("he's tired today",
 *             "she barely ate", "the nausea seems worse").
 *
 * DESIGN NOTE — why this is a deterministic keyword/rules classifier, not an LLM prompt.
 * design.md lists `safety.classifier` as a small routed prompt, but the safety guardrails
 * (safety.md) make its behavior a hard invariant that must hold with zero external keys and
 * be individually testable against an adversarial eval set. A live-model classifier cannot
 * guarantee 100% crisis/medical detection offline, and it cannot run in the zero-key
 * degradation mode the whole app must boot in. So the seed classifier is pure and
 * deterministic — keyword/phrase rules over the lowercased text, in the same style as the
 * mode router's regex rules — and it BIASES UNCERTAIN CASES TOWARD FLAGGING (R5.2 spirit):
 * a plausible clinical-decision or crisis cue wins over silence. The eval harness (Task 34)
 * is the gate: prompt/rule changes must keep 100% medical refuse+redirect, 100% crisis
 * trigger, and 0% benign over-refusal before merge.
 *
 * PRECEDENCE (safety.md §Order of operations): crisis is checked FIRST — a turn that carries
 * both self-harm language and a medical word is a crisis, never a medical refusal. Then
 * medical. Then none.
 *
 * THE OVER-REFUSAL GUARD (R5.6, the hard part). Benign caregiver talk is medically adjacent
 * by nature — the caregiver is caring for a sick person. Observation ("he's tired", "she
 * barely ate", "the nausea seems worse") and venting are NORMAL and must NOT trip the
 * guardrail. Only a request for a clinical DECISION does. So the medical rules key on
 * DECISION SHAPES — asking whether to give/change/stop a medication, asking a dose/timing/
 * interaction, asking for a prognosis, or asking a triage question ("should I…", "do I need
 * to…", "is it time to…") — not on the mere presence of a symptom or medication word.
 */

/** Normalize apostrophes/whitespace so contraction variants match one rule set. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * CRISIS cues — suicidal ideation, self-harm, and abuse (R5.2). Kept broad on purpose: the
 * cost of a missed crisis is catastrophic, so we bias toward flagging. These match the
 * substance of the utterance (wanting to die, ending it, hurting oneself, being hurt by
 * someone), tolerant of the surrounding phrasing a distressed caregiver would use.
 */
const CRISIS_PATTERNS: RegExp[] = [
  // suicidal ideation — wanting to die / not want to be alive / end it
  /\b(kill|killing|hurt|harm|harming)\s+(myself|herself|himself|themsel(f|ves))\b/,
  /\bend(ing)?\s+(my|her|his|their)\s+(own\s+)?life\b/,
  /\b(take|taking|end)\s+(my|her|his|their)\s+own\s+life\b/,
  /\b(want|wanted|wish|wished|need)\s+(to\s+)?(die|be dead|not (be|wake up)|disappear|end it|end things|end it all)\b/,
  /\b(want|wanting)\s+to\s+(die|disappear)\b/,
  /\bwish (i|it) (were|was)\b.*\bdead\b/,
  /\bi\s+(can'?t|cannot|don'?t want to)\s+(go on|keep going|do this anymore|live like this|be here)\b/,
  /\bno (reason|point)\s+(to|in)\s+(live|living|go on|going on|keep going|keep on)\b/,
  /\b(don'?t|do not|can'?t|cannot)\s+see\s+a\s+(reason|point)\s+to\s+(go on|keep going|live)\b/,
  /\bbetter off (dead|without me)\b/,
  /\b(don'?t|do not) want to (be alive|live|wake up)\b/,
  /\b(thinking about|thoughts of|planning|feel like)\s+(suicide|killing myself|ending it|ending my life|ending it all|ending things)\b/,
  /\bend(ing)? it all\b/,
  /\bsuicid(e|al)\b/,
  /\bself[-\s]?harm\b/,
  /\b(cut|cutting|hurt|hurting|harm|harming)\s+myself\b/,
  /\bwant(ed)? it (all )?to (be over|stop|end)\b/,
  // abuse — being hurt/threatened by someone, or hurting the patient
  /\b(he|she|they|my (husband|wife|partner|son|daughter|mother|father|brother|sister))\s+(hit|hits|hurt|hurts|beat|beats|threatens|threatened|abus)/,
  /\b(being|been|feel)\s+(abused|hurt|threatened|hit)\b/,
  /\bi'?m\s+(scared|afraid)\s+(of|he|she|they|for my (life|safety))\b/,
  /\b(afraid|scared)\s+(he|she|they)\s+(will|might|could)\s+(hurt|hit|kill)\b/,
  /\b(hit|hitting|hurt|hurting|shaking|shook)\s+(the patient|him|her|them)\b.*\b(too hard|by accident|because|so angry|lost)\b/,
  /\bi\s+(hit|hurt|shook)\s+(him|her|them)\b/,
  /\b(scared|afraid|worried)\b.*\bi (might|may|could|will)\b.*\b(hurt|harm|hit)\b.*\b(the patient|him|her|them)\b/,
];

/**
 * Verbs that describe a clinical CHANGE the caregiver is asking to make to medication. Used
 * with the medication nouns below to detect medication-selection / titration questions.
 */
const MED_DECISION_VERBS =
  '(give|giving|take|taking|start|starting|stop|stopping|skip|skipping|switch|switching|increase|increasing|decrease|decreasing|double|doubling|cut|cutting|reduce|reducing|raise|raising|add|adding|combine|combining|mix|mixing)';

/** Medication / drug nouns (generic + a few common palliative-context specifics). */
const MED_NOUN =
  "(med|meds|medication|medications|medicine|medicines|pill|pills|dose|doses|dosage|drug|drugs|tablet|tablets|painkiller|painkillers|opioid|opioids|morphine|oxycodone|oxycontin|fentanyl|hydrocodone|codeine|tramadol|tylenol|acetaminophen|paracetamol|ibuprofen|advil|aspirin|ativan|lorazepam|xanax|antibiotic|antibiotics|laxative|laxatives|steroid|steroids|chemo|chemotherapy|insulin|marijuana|cannabis|cbd)";

/**
 * MEDICAL cues — requests for a CLINICAL DECISION (R5.3). Grouped by decision type so the
 * intent is legible. The unifying property: the caregiver is asking Turtle to make or
 * validate a clinical judgment (what/whether/how much/when to medicate, what the prognosis
 * is, whether a symptom needs urgent care) — NOT merely mentioning a symptom or drug.
 */
const MEDICAL_PATTERNS: RegExp[] = [
  // ---- Medication selection / dosing / timing / titration ----
  // "should I give him the oxycodone", "can I take another dose", "is it okay to double the dose"
  new RegExp(
    `\\b(should|shall|can|could|may|do|is it (ok|okay|safe|fine|alright))\\b.*\\b${MED_DECISION_VERBS}\\b.*\\b${MED_NOUN}\\b`,
  ),
  // "is it safe to give ... together/with", medication interactions
  new RegExp(`\\b${MED_DECISION_VERBS}\\b.*\\b${MED_NOUN}\\b.*\\b(with|together|and|alongside|at the same time)\\b`),
  new RegExp(`\\bcan\\b.*\\b${MED_NOUN}\\b.*\\b(be (taken|given)|mix|interact)\\b`),
  new RegExp(`\\b(interact|interaction|interactions|combine|combined)\\b.*\\b${MED_NOUN}\\b`),
  new RegExp(`\\b${MED_NOUN}\\b.*\\b(interact|interaction|interactions)\\b`),
  // dose sizing — "how much morphine", "how many pills", "what dose", "correct/right dosage"
  new RegExp(`\\bhow (much|many|often)\\b.*\\b${MED_NOUN}\\b`),
  new RegExp(`\\bwhat('?s| is| would be)?\\b.*\\b(the )?(right|correct|proper|safe|maximum|max)\\b.*\\b(dose|dosage|amount|number of)\\b`),
  new RegExp(`\\bwhat (dose|dosage)\\b`),
  // timing — "when should I give the next dose", "how long between doses", "is it time for his meds"
  new RegExp(`\\bwhen\\b.*\\b(give|take|next|another|due|schedule)\\b.*\\b${MED_NOUN}\\b`),
  new RegExp(`\\bhow long\\b.*\\b(between|apart|wait|before)\\b.*\\b${MED_NOUN}\\b`),
  new RegExp(`\\bis it time\\b.*\\b(for|to give|to take)\\b.*\\b${MED_NOUN}\\b`),
  new RegExp(`\\bis it too (early|soon|late)\\b.*\\b(to (give|take)|for)\\b.*\\b${MED_NOUN}\\b`),
  new RegExp(`\\b(next|another) (dose|pill|tablet)\\b.*\\b(yet|now|already|due|ok|okay|safe)\\b`),
  // explicit selection — "which medication/painkiller should", "what should I give him for the pain"
  new RegExp(`\\b(which|what)\\b.*\\b${MED_NOUN}\\b.*\\b(should|for|best|better|give|use|take)\\b`),
  // "is X a good/right medication to give/for ...", "is the CBD good to give her"
  new RegExp(`\\bis\\b.*\\b(a )?(good|right|safe|better|best|ok|okay)\\b.*\\b${MED_NOUN}\\b.*\\b(to (give|take|use)|for)\\b`),
  new RegExp(`\\bis\\b.*\\b${MED_NOUN}\\b.*\\b(a )?(good|right|safe|better|best|ok|okay)\\b.*\\b(to (give|take|use)|for)\\b`),
  /\bwhat (should|can) (i|we)\b.*\b(give|use)\b.*\bfor\b.*\b(the )?(pain|nausea|fever|anxiety|constipation|cough|sleep|breathing)\b/,
  // "can I give him something for the pain/nausea" — asking Turtle to pick a treatment
  /\b(can|should|could)\b.*\bgive\b.*\bsomething\b.*\bfor\b.*\b(the )?(pain|nausea|fever|anxiety|constipation|cough|sleep|breathing|symptom)\b/,

  // ---- Prognosis / life expectancy ----
  /\bhow long\b.*\b(does|do|has|have|he|she|they|left|to live|until)\b.*\b(live|left|got|have|survive|last)\b/,
  /\bhow long\b.*\b(has|have|does|will)\b.*\b(he|she|they)\b.*\b(got|have|left)\b/,
  /\bhow (long|much time)\b.*\b(left|to live|does (he|she|they) have)\b/,
  /\b(life expectancy|prognosis|how much time|time (he|she|they) (has|have) left)\b/,
  /\b(is|will) (he|she|they|this) (dying|terminal|going to (die|make it|survive|recover|get better))\b/,
  /\bhow long\b.*\b(before|until)\b.*\b(the end|he (dies|passes)|she (dies|passes)|they (die|pass))\b/,
  /\bwhat (are|is)\b.*\b(the )?(odds|chances|survival)\b.*\b(of|for)\b.*\b(surviv|recover|beat|remission|living)/,
  /\b(chances|odds|likelihood) of\b.*\b(surviv|recover|beat|remission|making it|pulling through)/,
  /\bwill (he|she|they) (recover|survive|beat (it|this|the cancer)|get better|be (ok|okay|cured))\b/,
  /\bis (the|this) (cancer|tumor|tumour|disease) (curable|terminal|fatal|going to spread)\b/,
  /\b(how|what) stage\b.*\b(is|of)\b.*\b(the )?(cancer|tumor|tumour|disease)\b.*\?/,

  // ---- Symptom triage (should we act / escalate?) ----
  // "should I take him to the ER", "do we need to go to the hospital", "should I call 911"
  /\b(should|do|does|shall|is it time to|do we need to|should we|is it necessary to)\b.*\b(go to|take (him|her|them) to|call|get to)\b.*\b(the )?(er|emergency|hospital|ambulance|911|999|doctor|urgent care)\b/,
  /\b(call|calling)\s+(911|999|an ambulance|emergency)\b.*\?/,
  /\bis (this|it|that)\b.*\b(an emergency|serious|dangerous|normal|something to worry about|a problem)\b.*\?/,
  /\b(should|do) (i|we) (be )?(worry|worried|concerned)\b.*\b(about|that)\b/,
  /\b(is|are) (this|these|the) (symptom|symptoms|sign|signs)\b.*\b(dangerous|serious|normal|bad|an emergency)\b/,
  /\bdo (i|we) need to\b.*\b(worry|call|go|see (a|the) (doctor|nurse)|do anything)\b/,
  /\b(is|does)\b.*\b(this|it|that|the (pain|fever|breathing|bleeding|swelling))\b.*\b(mean|a sign of|serious|dangerous|normal)\b/,
  // "what should I do about the ..." asking for a clinical action on a symptom
  /\bwhat (should|do|can) (i|we)\b.*\b(do|give)\b.*\b(about|for)\b.*\b(the )?(fever|pain|bleeding|vomiting|breathing|seizure|fall|rash|swelling|blood|infection)\b/,
  // direct diagnosis/triage ask — "does he have an infection?", "is this a seizure?"
  /\b(does|is|are)\b.*\b(he|she|they|this|it)\b.*\b(have|having|an?)\b.*\b(infection|sepsis|stroke|heart attack|seizure|blood clot|pneumonia|reaction)\b/,
  // "should I stop feeding / give oxygen" — care escalation decisions
  /\b(should|do) (i|we)\b.*\b(give|start|stop)\b.*\b(oxygen|iv|fluids|feeding|cpr)\b/,
];

/** True when the text carries a crisis cue. Checked first (highest precedence). */
export function isCrisis(normalized: string): boolean {
  return CRISIS_PATTERNS.some((re) => re.test(normalized));
}

/** True when the text carries a clinical-decision (medical) cue. */
export function isMedical(normalized: string): boolean {
  return MEDICAL_PATTERNS.some((re) => re.test(normalized));
}

/**
 * Classify raw user text into a {@link SafetyVerdict}. Pure and synchronous under the hood;
 * exported as a plain function so the eval harness and unit tests can assert it directly
 * without awaiting. Precedence: crisis → medical → none (safety.md §Order of operations).
 */
export function classifySafety(userText: string): SafetyVerdict {
  const normalized = normalize(userText);
  if (normalized.length === 0) return 'none';
  if (isCrisis(normalized)) return 'crisis';
  if (isMedical(normalized)) return 'medical';
  return 'none';
}

/**
 * Build the seed {@link SafetyClassifier}. Deterministic and LLM-free, so it runs in the
 * zero-key degradation mode the whole app must boot in and its verdict is fully testable
 * against the adversarial eval set (Task 34). The async `classify` simply wraps
 * {@link classifySafety} to satisfy the interface (the orchestrator awaits it as the first
 * step of every turn).
 */
export function createSafetyClassifier(): SafetyClassifier {
  return {
    classify(userText: string): Promise<SafetyVerdict> {
      return Promise.resolve(classifySafety(userText));
    },
  };
}
