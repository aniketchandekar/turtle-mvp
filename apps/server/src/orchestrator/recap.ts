import { modeOutputSchema, type Card, type ModeOutput } from '@turtle/shared';
import type { LlmMessage, LlmProvider, LlmRunOptions } from '../services/llm/index.js';
import { runMode } from '../services/llm/index.js';
import type { Mode, ModeRunner } from './index.js';

/**
 * Recap & session close — `recap.prompt` (Task 32, R2.6 / R7.5 / R14.1–R14.3).
 *
 * The session-closing composer (design.md §Orchestrator: `recap.prompt` — "session
 * recap composer for CLOSING"). It is one of the small routed prompts and owns exactly
 * one thing: when a session enters CLOSING, speak a BRIEF recap of what was covered and
 * emit a single recap card summarizing the session — so the close is BOTH spoken and
 * shown. It does nothing else — no advice, no new topics, no follow-up questions.
 *
 * The behavioral contract (product.md §The medium / §Behavioral principles; the
 * requirements):
 *
 *   R2.6  — A closing phrase ("I have to go") transitions the session to CLOSING and
 *           ends WARMLY within 20 seconds. Detection is {@link isClosingPhrase}; the
 *           20s budget is met because the recap is a SINGLE short turn (no extra
 *           round-trips) and degrades to a deterministic line with no live LLM.
 *   R7.5  — When the session closes, provide a spoken recap AND a recap card.
 *   R14.1 — On entering CLOSING, speak a brief recap of what was covered.
 *   R14.2 — Emit a recap card summarizing the session alongside the spoken recap.
 *   R14.3 — The recap card is PERSISTED as a long-term artifact associated with the
 *           session (wired via `session.recap_card_id`). Persistence happens off the
 *           spine in the gateway's contract side-effects, mirroring every other card;
 *           this composer's job is to EMIT the recap card on the validated contract.
 *
 * SPOKEN-AND-SHOWN. Like the safety composers, the recap is always spoken AND shown:
 * this composer ALWAYS emits exactly one recap card next to the spoken recap, so a
 * close is never spoken-only. The recap card is a `retained` card (something kept as a
 * long-term session artifact — the card taxonomy has actionable | retained | safety,
 * and a recap is kept, not acted on). The gateway recognizes it by its stable title
 * ({@link RECAP_CARD_TITLE}) to wire `session.recap_card_id` — mirroring how the log /
 * visit-summary modes expose a stable card title.
 *
 * WHAT "COVERED" MEANS. The composer summarizes the topics the session actually
 * touched. Those topics are supplied by the caller as {@link RecapDeps.coveredTopics}
 * (e.g. the routed modes / themes recorded on the session's `mode_transitions`, or the
 * turn topics the orchestrator accumulated) rather than re-derived here — the composer
 * only sees the closing turn, so what-was-covered is threaded in, exactly as the
 * check-in suggestion budget and prior-session summaries are injected rather than
 * inferred. With a LIVE LLM the topics are phrased into a warm, brief recap; with a
 * NON-LIVE provider (zero-key) a deterministic recap is composed in code from the same
 * topics, so a session always closes warmly with zero keys (R16.4 spirit; R2.6's 20s).
 *
 * As with the sibling modules, the LLM provider, covered topics, and (for tests) the
 * run options are all injectable, so the whole surface — closing detection, recap
 * phrasing, the deterministic fallback, and the card — is unit-testable with fakes and
 * zero network.
 */

/** This runner's mode tag. The recap composer is its own routed prompt for CLOSING. */
const RECAP_MODE: Mode = 'checkin';

/**
 * Closing-phrase patterns (R2.6). The caregiver is signalling they need to end the
 * session ("I have to go", "I need to go now", "let's stop here", "talk later",
 * "goodbye"). Kept deliberately narrow around unambiguous farewells / "have to go"
 * shapes so an ordinary mention of leaving inside a sentence ("he had to go to the
 * hospital") does NOT close the session — the patterns require the caregiver as the
 * subject ("I"/"we"), or a bare farewell.
 */
const CLOSING_PATTERNS: RegExp[] = [
  // "I have to go", "I've got to go", "I gotta go", "we have to go", "I need to go".
  // The caregiver ("i"/"we", allowing a contraction like "i've") must be the subject,
  // then any "have/need/got/gotta/must … go" shape, so a benign "he had to go" (a
  // different subject) does not match.
  /\b(i|we)(?:'ve|'d)?\b[^.!?]*\b(have|need|got|gotta|must)\b[^.!?]*\bgo\b/,
  /\b(i|we)(?:'ve|'d)?\b[^.!?]*\bgotta\s+go\b/,
  // "I should get going", "I'd better get going", "I need to get going"
  /\b(i|we)(?:'ve|'d)?\b[^.!?]*\b(get|getting|be)\s+going\b/,
  // "let's stop here", "let's wrap up", "let's leave it there", "let's call it"
  /\blet'?s\s+(stop|wrap|wrap up|leave it|call it|end)\b/,
  // "I'm going to head out", "I have to head out", "heading out now"
  /\b(i|we)(?:'ve|'d|'m)?\b[^.!?]*\bhead(ing)?\s+out\b/,
  // "that's all for now", "I'm done for now"
  /\b(that'?s all|i'?m done)\b[^.!?]*\b(for now|for today)\b/,
  // "talk (to you) later", "talk soon", "catch you later"
  /\btalk (to you )?(later|soon|tomorrow)\b/,
  /\bcatch you later\b/,
  // bare farewells — "goodbye", "bye", "bye for now", "good night"
  /^\s*(good ?bye|bye( for now| now)?|good ?night|see you( later| soon| tomorrow)?)\s*[.!]*\s*$/,
];

/**
 * True when the caregiver's turn is a CLOSING phrase (R2.6). Rules-only and LLM-free so
 * it works with zero keys and the orchestrator can route to CLOSING deterministically —
 * mirroring {@link import('./mode-router.js').isLogRetrievalQuery}. Exported so the
 * orchestrator/gateway (and tests) can detect a close without re-deriving the intent.
 */
export function isClosingPhrase(userText: string): boolean {
  const lower = userText.toLowerCase().trim();
  return CLOSING_PATTERNS.some((re) => re.test(lower));
}

/** Title for the retained recap card (R14.2). Stable so the gateway can wire recap_card_id. */
export const RECAP_CARD_TITLE = 'Session recap';

/**
 * The warm closing line spoken when nothing specific was covered (an empty session) or
 * as the tail of every recap. Brief and warm — a real goodbye, not an echo (R2.6/R14.1).
 */
export const RECAP_CLOSING_LINE = 'Take care of yourself. I’m here whenever you need me.';

/**
 * The deterministic recap `say` for an empty session (no covered topics) or the zero-key
 * path with nothing to summarize. Warm and brief so the close still lands within the 20s
 * budget (R2.6). Exported so callers/tests share one definition.
 */
export const RECAP_EMPTY_SAY = `Thanks for spending a little time with me today. ${RECAP_CLOSING_LINE}`;

/**
 * Recap system prompt (R14.1). Small and routed: it phrases the covered topics into a
 * warm, BRIEF spoken recap and NOTHING else — no new advice, no follow-up question, no
 * new topics. The card is composed in code from the same topics, never from model prose,
 * so the artifact stays neutral.
 */
export const RECAP_SYSTEM =
  'You are Turtle, a warm voice companion for a caregiver of someone with a terminal ' +
  'illness. The session is ENDING. Speak a brief, warm recap of what you talked about ' +
  'today and say a gentle goodbye.\n' +
  'How to respond:\n' +
  '- Keep it SHORT — two or three sentences at most. This is a spoken goodbye, not a ' +
  'summary essay.\n' +
  '- Gently name what was covered, using the topics provided below as your guide.\n' +
  '- Warm and plain. No new advice, no new questions, no new topics — the session is ' +
  'closing.\n' +
  '- You are not a clinician. Never add medical, dosing, or prognosis content.\n' +
  'Reply ONLY with a JSON object of the form ' +
  '{"say": string, "cards": [], "memory_ops": [], "flags": ["none"]}. ' +
  'Put your spoken recap in "say" and leave the other fields empty.';

/** Prefix that introduces the covered topics in the recap prompt. */
export const RECAP_TOPICS_PREFIX =
  'Here is what this session covered. Ground your recap in these, and do not invent ' +
  'anything beyond them:';

/** Dependencies for the recap composer (DI style, mirroring the sibling modes). */
export interface RecapDeps {
  /**
   * The resolved LLM provider. When `provider.live === false` (canned/zero-key) the
   * composer does not rely on model output and returns the deterministic recap instead,
   * so a session always closes warmly with zero keys (R16.4 spirit; R2.6's 20s budget).
   */
  llm: LlmProvider;
  /**
   * The topics this session covered, supplied by the orchestrator/gateway (e.g. from the
   * session's `mode_transitions` / accumulated turn themes). The composer summarizes
   * THESE rather than re-deriving them, since a single closing turn does not reveal what
   * the whole session covered. Empty → an empty-session recap.
   */
  coveredTopics: readonly string[];
  /** Optional timeout/timer knobs forwarded to {@link runMode}. Injectable for tests. */
  runOptions?: LlmRunOptions;
}

/**
 * Run the recap/close composer end-to-end and return the contract-valid output: a brief
 * spoken recap + a single retained recap card (R7.5/R14.1/R14.2). This is the testable
 * core; {@link createRecapRunner} wraps it as a {@link ModeRunner}.
 *
 * With a LIVE LLM the covered topics are phrased into a warm recap; on a non-live
 * provider (or any model/parse failure) the deterministic recap is used. Either way the
 * recap CARD is composed in code from the topics so the artifact is neutral and stable.
 *
 * @param deps - injectable LLM + covered topics + run options.
 */
export async function runRecap(deps: RecapDeps): Promise<ModeOutput> {
  const { llm, runOptions } = deps;
  const topics = normalizeTopics(deps.coveredTopics);

  const say = await composeRecapSay(topics, llm, runOptions);
  // Always emit exactly one recap card next to the spoken recap (spoken AND shown;
  // R7.5/R14.2). Composed in code from the neutral topics, never from model prose.
  const cards: Card[] = [buildRecapCard(topics)];

  // No memory op: a recap is a retained CARD (the session artifact), persisted and wired
  // to `session.recap_card_id` off the spine. Cards flow only from the validated contract.
  return modeOutputSchema.parse({ say, cards, memory_ops: [], flags: ['none'] });
}

/**
 * Create the recap/close {@link ModeRunner} (Task 32). `run()` ignores the closing
 * utterance text (the close is already decided by {@link isClosingPhrase}) and returns
 * the contract-valid {@link ModeOutput}: a brief spoken recap and a single retained
 * recap card. The orchestrator sets the contract `state` to CLOSING around this output.
 *
 * @param deps - injectable LLM + covered topics + run options.
 */
export function createRecapRunner(deps: RecapDeps): ModeRunner {
  return {
    mode: RECAP_MODE,
    async run(): Promise<ModeOutput> {
      return runRecap(deps);
    },
  };
}

// ---------------------------------------------------------------------------
// Recap phrasing — warm with a live LLM, deterministic fallback otherwise.
// ---------------------------------------------------------------------------

/**
 * Compose the spoken recap. With a LIVE LLM this runs the small recap prompt (topics
 * folded in) and uses the model's `say`; with a non-live provider (or any timeout/park
 * result / empty output) it falls back to the deterministic recap so the close always
 * lands warmly within budget (R2.6). Exported for direct testing.
 */
export async function composeRecapSay(
  topics: string[],
  llm: LlmProvider,
  runOptions?: LlmRunOptions,
): Promise<string> {
  // Zero-key degradation: a non-live provider only echoes, which is not a warm recap.
  if (!llm.live) return buildDeterministicRecap(topics);

  const messages: LlmMessage[] = [
    { role: 'system', content: buildRecapPrompt(topics) },
    // The recap is composed from the covered topics, not from a fresh user turn; give
    // the model a neutral cue to produce the goodbye now.
    { role: 'user', content: 'The caregiver is ending the session now.' },
  ];

  const output = await runMode(llm, messages, runOptions);
  const say = output.say.trim();
  // A parked/empty turn is not a usable recap — fall back to the deterministic close so
  // the session never ends on an apology line.
  return say.length > 0 ? say : buildDeterministicRecap(topics);
}

/**
 * Build the full recap system prompt: the stable {@link RECAP_SYSTEM} base plus the
 * covered topics for grounding (R14.1). Kept pure and exported so the exact prompt
 * assembly is unit-testable in isolation.
 */
export function buildRecapPrompt(topics: string[]): string {
  if (topics.length === 0) return RECAP_SYSTEM;
  const list = topics.map((t) => `- ${t}`).join('\n');
  return `${RECAP_SYSTEM}\n\n${RECAP_TOPICS_PREFIX}\n${list}`;
}

/**
 * The deterministic spoken recap (R2.6/R14.1). Warm and brief: names the covered topics
 * in plain language then closes gently. Used with a non-live provider or when the model
 * produced nothing usable, so a session always closes warmly with zero keys. Empty
 * topics → the warm empty-session close. Exported for direct testing.
 */
export function buildDeterministicRecap(topics: string[]): string {
  if (topics.length === 0) return RECAP_EMPTY_SAY;
  return `Today we talked about ${joinList(topics)}. ${RECAP_CLOSING_LINE}`;
}

// ---------------------------------------------------------------------------
// Recap card (R14.2) — composed in code, never model prose.
// ---------------------------------------------------------------------------

/**
 * Build the single RETAINED recap card summarizing the session (R14.2/R14.3). Title is
 * the stable {@link RECAP_CARD_TITLE} (so the gateway can wire `session.recap_card_id`);
 * body lists the covered topics as neutral lines (≤ the contract's 280-char cap), or a
 * gentle placeholder for an empty session. No action — a recap is kept, not acted on.
 * Exported for direct testing.
 */
export function buildRecapCard(topics: string[]): Card {
  const body =
    topics.length === 0
      ? 'We spent a little time together today.'
      : topics.map((t) => `• ${t}`).join('\n');
  return {
    type: 'retained',
    title: RECAP_CARD_TITLE,
    body: truncate(body, 280),
  };
}

/**
 * True when `card` is a recap card (by its stable type + title). The gateway uses this
 * on a CLOSING turn to persist the emitted recap card as the session's long-term recap
 * artifact (`session.recap_card_id`, R14.3). Exported so the gateway and tests share one
 * definition rather than string-matching the title in two places.
 */
export function isRecapCard(card: Card): boolean {
  return card.type === 'retained' && card.title === RECAP_CARD_TITLE;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize the injected covered topics: trim, drop empties, de-duplicate (case-
 * insensitive, preserving first-seen order), and bound the count so the recap stays
 * brief. Kept private; callers pass whatever they accumulated and get a clean list.
 */
function normalizeTopics(topics: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of topics) {
    const t = raw.trim();
    if (t.length === 0) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_RECAP_TOPICS) break;
  }
  return out;
}

/** How many covered topics to include in the recap (kept short for a spoken goodbye). */
export const MAX_RECAP_TOPICS = 4;

/**
 * Join a list of phrases with commas and a trailing "and", Oxford-style for 3+.
 * ["a"] → "a"; ["a","b"] → "a and b"; ["a","b","c"] → "a, b, and c".
 */
function joinList(items: string[]): string {
  if (items.length === 0) return 'a few things';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** Truncate to at most `max` chars, adding an ellipsis when clipped. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
