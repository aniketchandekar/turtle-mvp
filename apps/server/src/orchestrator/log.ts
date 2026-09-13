import {
  LOG_CATEGORIES,
  modeOutputSchema,
  type Card,
  type LogCategory,
  type MemoryOp,
  type ModeOutput,
} from '@turtle/shared';
import type { LlmMessage, LlmProvider, LlmRunOptions } from '../services/llm/index.js';
import { runMode } from '../services/llm/index.js';
import type { Mode, ModeRunner } from './index.js';

/**
 * Care-log extraction mode — `log.prompt` (Task 26, R11.1–R11.3).
 *
 * One of the small routed prompts (design.md §Orchestrator). It owns exactly one
 * thing: turning a dictated caregiver utterance ("Gave the 2pm meds… slept badly…
 * new cough") into one or more STRUCTURED log entries, confirming with PASSIVE
 * phrasing, and creating a retained log card. It does NOTHING else — no advice, no
 * comparison, no triage. "Log, never interpret" is a BINDING product rule
 * (product.md §Behavioral principles; safety.md), so the zero-interpretation
 * constraint is enforced in code here, not merely requested in the prompt.
 *
 * The turn flow (design.md §log.prompt; R11.1–R11.3):
 *
 *   1. EXTRACT (R11.1). The utterance is split into one or more entries, each tagged
 *      with a {@link LogCategory} (medication_given | symptom | sleep | food | event |
 *      note) and a timestamp. With a LIVE LLM this is the routed extraction prompt
 *      (extraction only, zero interpretation). With a NON-LIVE provider (zero-key)
 *      the model only echoes, so the runner falls back to a deterministic single-entry
 *      extraction (category `note`, verbatim text) — the pipeline still records the
 *      log with zero keys (R16.4 spirit), just without multi-entry splitting.
 *   2. EMIT MEMORY OPS (R11.1). Each extracted entry becomes an `append_log` memory op
 *      (category + verbatim text + ISO timestamp). The contract-validator's write path
 *      (Task 15) persists these to the `log_entry` store — cards and memory flow ONLY
 *      from the validated contract (spine invariant).
 *   3. CONFIRM PASSIVELY (R11.2). The spoken `say` is a passive confirmation
 *      ("Noted — 2pm meds given"), built IN CODE from the extracted entries rather
 *      than trusting the model to phrase it, so the passive, non-interpretive tone is
 *      guaranteed. See {@link buildConfirmation}.
 *   4. CREATE A LOG CARD (R11.2). A single RETAINED card summarizes what was filed —
 *      title "Logged", body listing the entries (≤3 lines), no action. Built in code
 *      from the same entries. See {@link buildLogCard}.
 *   5. STRIP INTERPRETATION (R11.3). As a code-level guarantee, the model's raw output
 *      is never spoken; the say/card are composed from the neutral extracted entries.
 *      Any flags the model might attach are discarded — a log turn is always `none`.
 *
 * The output always conforms to the response contract (validated before return), so it
 * flows through the same validate-before-speaking gate (Task 15) as every other mode.
 *
 * As with the sibling modes, the LLM provider, clock, and run options are all
 * injectable, so the whole surface — extract / confirm / card / zero-interpretation —
 * is unit-testable with fakes and zero network.
 */

/** This runner's mode tag (design.md §Orchestrator: small routed prompts). */
const LOG_MODE: Mode = 'log';

/** A single structured log entry extracted from the utterance (R11.1). */
export interface LogExtraction {
  /** The log category this entry belongs to. */
  category: LogCategory;
  /** The verbatim (or lightly trimmed) text of what happened — never interpreted. */
  text: string;
}

/**
 * Extraction-only system prompt (R11.1/R11.3). Small and routed: it does EXACTLY one
 * thing — split the utterance into structured entries with a category — and is
 * explicitly forbidden from interpreting, comparing, advising, or triaging (R11.3).
 * The model returns a bare JSON array of `{category, text}`; the passive confirmation
 * and the card are composed in code from that array, never from model prose.
 */
export const LOG_SYSTEM =
  'You are the care-log extractor for Turtle, a caregiver voice companion. The caregiver ' +
  'has dictated one or more things that happened. Your ONLY job is to extract them into ' +
  'structured log entries.\n' +
  'Strict rules:\n' +
  '- Split the utterance into ONE OR MORE entries, one per distinct thing that happened.\n' +
  '- For each entry, choose exactly one category from: ' +
  `${LOG_CATEGORIES.join(', ')}.\n` +
  '  - medication_given: a medication/dose/pill was given or taken.\n' +
  '  - symptom: an observed symptom (cough, pain, nausea, fever, swelling, etc.).\n' +
  '  - sleep: anything about sleep (slept badly, up all night, napped).\n' +
  '  - food: anything about eating/appetite/drinking.\n' +
  '  - event: a notable occurrence (a visitor, a fall, a good moment).\n' +
  '  - note: anything else worth recording that fits no other category.\n' +
  '- The "text" MUST be a faithful, verbatim record of what the caregiver said for that ' +
  'entry. Do NOT rephrase into clinical language.\n' +
  '- Do NOT interpret, compare, rate severity, advise, or triage. You are recording, not ' +
  'assessing. Never add opinions, causes, or next steps.\n' +
  'Reply ONLY with a JSON array of the form ' +
  '[{"category": "<category>", "text": "<what happened>"}, ...] and NOTHING else.';

/** Dependencies for the log runner (DI style, mirroring the sibling modes). */
export interface LogDeps {
  /**
   * The resolved LLM provider. When `provider.live === false` (canned/zero-key) the
   * runner falls back to a deterministic single-entry extraction rather than relying
   * on model output — the log is still recorded with zero keys.
   */
  llm: LlmProvider;
  /**
   * Clock for the entries' `at` timestamps. Injectable for deterministic tests.
   * Defaults to `() => new Date()`.
   */
  now?: () => Date;
  /** Optional timeout/timer knobs forwarded to {@link runMode}. Injectable for tests. */
  runOptions?: LlmRunOptions;
}

/**
 * Run the care-log extraction mode end-to-end and return the contract-valid output
 * (passive confirmation + append_log ops + a retained log card). This is the testable
 * core; {@link createLogRunner} wraps it as a {@link ModeRunner}.
 *
 * @param userText - the caregiver's dictated log utterance.
 * @param deps     - injectable LLM, clock, run options.
 */
export async function runLog(userText: string, deps: LogDeps): Promise<ModeOutput> {
  const { llm, runOptions } = deps;
  const now = deps.now ?? (() => new Date());
  const at = now().toISOString();

  const entries = await extractEntries(userText, llm, runOptions);

  // Defensive: if extraction yielded nothing usable, record the whole utterance as a
  // single `note` so the caregiver's words are never silently dropped (R11.1).
  const safeEntries = entries.length > 0 ? entries : [fallbackEntry(userText)];

  // (R11.1) One append_log op per entry — memory flows only from the contract.
  const memory_ops: MemoryOp[] = safeEntries.map((e) => ({
    op: 'append_log',
    category: e.category,
    text: e.text,
    at,
  }));

  // (R11.2) Passive confirmation + a single retained log card, both composed in code
  // from the neutral entries (R11.3: no interpretation ever reaches say/card).
  const say = buildConfirmation(safeEntries);
  const cards: Card[] = [buildLogCard(safeEntries)];

  return modeOutputSchema.parse({ say, cards, memory_ops, flags: ['none'] });
}

/**
 * Create the care-log {@link ModeRunner} (Task 26). `run(userText)` returns the
 * contract-valid {@link ModeOutput}: a passive confirmation, one `append_log` op per
 * extracted entry, and a single retained log card.
 *
 * @param deps - injectable LLM, clock, run options.
 */
export function createLogRunner(deps: LogDeps): ModeRunner {
  return {
    mode: LOG_MODE,
    async run(userText: string): Promise<ModeOutput> {
      return runLog(userText, deps);
    },
  };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extract structured entries from the utterance. With a LIVE LLM this runs the
 * extraction-only prompt and parses the JSON array; with a non-live provider (or on
 * any parse/model failure) it falls back to a deterministic single-entry extraction so
 * the log is still recorded (zero-key degradation, R16.4 spirit). Exported for testing.
 */
export async function extractEntries(
  userText: string,
  llm: LlmProvider,
  runOptions?: LlmRunOptions,
): Promise<LogExtraction[]> {
  // Zero-key degradation: a non-live provider only echoes, which is not a usable
  // extraction. Record the utterance verbatim as a single note instead.
  if (!llm.live) return [fallbackEntry(userText)];

  const messages: LlmMessage[] = [
    { role: 'system', content: LOG_SYSTEM },
    { role: 'user', content: userText },
  ];

  // The extraction prompt asks for a bare JSON array, but runMode returns a ModeOutput
  // (say/cards/memory_ops/flags) and parks the turn safely on timeout/error. The most
  // robust place to find the array is the model's memory_ops (append_log) if it emitted
  // them, then the `say` text. We normalize whatever we get into LogExtraction[].
  const raw = await runMode(llm, messages, runOptions);

  const fromOps = entriesFromMemoryOps(raw.memory_ops);
  if (fromOps.length > 0) return fromOps;

  const fromSay = parseEntriesJson(raw.say);
  if (fromSay.length > 0) return fromSay;

  // The model produced nothing structured we can trust → deterministic fallback.
  return [fallbackEntry(userText)];
}

/**
 * Pull entries out of any `append_log` memory ops the model happened to emit. Some
 * providers, given the JSON-contract habit, answer with append_log ops directly; we
 * accept those as long as they carry a valid category and non-empty text.
 */
function entriesFromMemoryOps(ops: MemoryOp[]): LogExtraction[] {
  const entries: LogExtraction[] = [];
  for (const op of ops) {
    if (op.op !== 'append_log') continue;
    const text = op.text.trim();
    if (text.length === 0) continue;
    entries.push({ category: op.category, text });
  }
  return entries;
}

/**
 * Parse the model's `say` text as the requested JSON array of `{category, text}`.
 * Tolerates surrounding prose/fences by extracting the first `[...]` block. Entries
 * with an unrecognized category or empty text are dropped. Returns `[]` when nothing
 * usable is found (the caller then falls back). Exported for direct testing.
 */
export function parseEntriesJson(raw: string): LogExtraction[] {
  const arr = extractJsonArray(raw);
  if (arr === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(arr);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const entries: LogExtraction[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const category = record.category;
    const text = record.text;
    if (typeof text !== 'string') continue;
    const trimmed = text.trim();
    if (trimmed.length === 0) continue;
    if (typeof category !== 'string' || !isLogCategory(category)) continue;
    entries.push({ category, text: trimmed });
  }
  return entries;
}

/** Extract the first balanced top-level JSON array substring, or null. */
function extractJsonArray(raw: string): string | null {
  const start = raw.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/** Type guard: is `value` one of the known {@link LogCategory} values? */
export function isLogCategory(value: string): value is LogCategory {
  return (LOG_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The deterministic single-entry fallback: the whole utterance recorded verbatim as a
 * `note`. Used with a non-live provider or when the model produced nothing structured,
 * so a dictated log is never silently dropped (R11.1). Empty input degrades to a
 * neutral placeholder so the entry text is always non-empty (contract requires it).
 */
export function fallbackEntry(userText: string): LogExtraction {
  const text = userText.trim();
  return { category: 'note', text: text.length > 0 ? text : 'note' };
}

// ---------------------------------------------------------------------------
// Passive confirmation + log card (R11.2/R11.3) — composed in code, never model prose.
// ---------------------------------------------------------------------------

/**
 * Build the passive spoken confirmation (R11.2). Deliberately dumb and neutral: it
 * reports WHAT was filed in passive voice ("Noted — 2pm meds given"), never what it
 * means. Multiple entries are joined into one confirmation. No adjectives, no severity,
 * no advice, no "you should" (R11.3). Exported for direct testing.
 *
 * Example: [{medication_given, "the 2pm meds"}, {sleep, "slept badly"}] →
 *   "Noted — the 2pm meds logged, and slept badly logged."
 */
export function buildConfirmation(entries: LogExtraction[]): string {
  const phrases = entries.map(entryPhrase);
  const joined = joinList(phrases);
  return `Noted — ${joined}.`;
}

/**
 * A single entry's passive phrase for the spoken confirmation. Echoes the caregiver's
 * verbatim text with a neutral passive tail ("logged") — no interpretation. Trailing
 * punctuation is trimmed so the phrases join cleanly.
 */
function entryPhrase(entry: LogExtraction): string {
  const text = entry.text.trim().replace(/[.!?]+$/, '');
  return `${text} logged`;
}

/**
 * Join a list of phrases with commas and a trailing "and", Oxford-style for 3+.
 * ["a"] → "a"; ["a","b"] → "a, and b"; ["a","b","c"] → "a, b, and c".
 */
function joinList(items: string[]): string {
  if (items.length === 0) return 'that';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]}, and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** Title for the retained log card (R11.2). */
export const LOG_CARD_TITLE = 'Logged';

/**
 * Build the single RETAINED log card summarizing what was filed (R11.2). Body lists
 * the entries (kept to ≤3 lines / the contract's soft length cap), each as a neutral
 * "category: verbatim text" line — no action (a log is kept, not acted on), no
 * interpretation (R11.3). Exported for direct testing.
 */
export function buildLogCard(entries: LogExtraction[]): Card {
  const body = entries.map((e) => `${categoryLabel(e.category)}: ${e.text.trim()}`).join('\n');
  return {
    type: 'retained',
    title: LOG_CARD_TITLE,
    // Guard the contract's 280-char body cap so a very long dictation still validates.
    body: truncate(body, 280),
  };
}

/** Human-readable label for a category in the card body (neutral, non-clinical). */
function categoryLabel(category: LogCategory): string {
  switch (category) {
    case 'medication_given':
      return 'Medication';
    case 'symptom':
      return 'Symptom';
    case 'sleep':
      return 'Sleep';
    case 'food':
      return 'Food';
    case 'event':
      return 'Event';
    case 'note':
      return 'Note';
  }
}

/** Truncate to at most `max` chars, adding an ellipsis when clipped. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
