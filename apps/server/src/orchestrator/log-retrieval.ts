import {
  LOG_CATEGORIES,
  modeOutputSchema,
  type Card,
  type LogCategory,
  type LogEntry,
  type ModeOutput,
} from '@turtle/shared';
import type { Repositories } from '../store/index.js';
import type { Mode, ModeRunner } from './index.js';

/**
 * Care-log voice retrieval mode — the READ counterpart to `log.prompt` (Task 27, R11.4).
 *
 * One of the small routed prompts (design.md §Orchestrator). Task 26 turns a dictated
 * utterance into structured `log_entry` rows; this mode reads them back BY VOICE when
 * the caregiver asks about a past event:
 *
 *   "What happened yesterday?"          → recall the entries from that day.
 *   "When did the cough start?"         → recall the EARLIEST matching entry (onset).
 *   "Did anything happen on Monday?"    → recall the entries from that weekday.
 *
 * DESIGN NOTES (why it looks the way it does):
 *
 *   - DETERMINISTIC OVER THE STORE, not the KB. Unlike Q&A (which retrieves KB vectors),
 *     log retrieval queries the STORED structured entries directly by date range /
 *     category / keyword. That query is fully deterministic and works with ZERO keys —
 *     there is no LLM in the query path at all (design.md provider-degradation:
 *     "log retrieval must work with rules-based date/keyword parsing even without an
 *     LLM key"). The natural `say` is composed IN CODE from the matched entries; an LLM
 *     is never required to answer, so this mode has no `llm` dependency.
 *
 *   - RECALL, NEVER INTERPRET (BINDING, product.md / safety.md). The spoken answer and
 *     the optional card echo the caregiver's own logged words with a neutral
 *     when-frame ("On Monday, you noted a new cough."). It NEVER compares ("worse
 *     than…"), rates severity, advises ("you should…"), or triages. The zero-
 *     interpretation guarantee is enforced in code by composing say/card from the
 *     stored `text` + a fixed frame, exactly like the memory service's recall lines.
 *
 *   - CARDS FLOW ONLY FROM THE CONTRACT. When the caregiver asks to LIST the matches
 *     (or the query is naturally a listing question) a single RETAINED card is emitted
 *     with the matching entries (title, ≤3-line body respecting the 280-char cap, no
 *     action — a recalled log is kept, not acted on). Max one active card.
 *
 *   - NO MATCH → SAY SO PLAINLY. If nothing matches the window/keyword, the mode says
 *     so in one plain sentence and emits no card.
 *
 * Everything is injectable (store repos + a clock) so the whole surface — date parsing,
 * keyword/category filtering, onset selection, say/card composition, no-match — is
 * unit-testable with an in-memory store and zero network.
 */

/** This runner's mode tag. Retrieval is part of the `log` mode family. */
const LOG_MODE: Mode = 'log';

/** How many entries to name in the spoken answer before summarizing the remainder. */
export const MAX_SPOKEN_ENTRIES = 3;

/** How many entries to list in the retained card body (kept to the ≤3-line rule). */
export const MAX_CARD_ENTRIES = 3;

/** Title for the retrieval-listing card (R11.4). */
export const RETRIEVAL_CARD_TITLE = 'Care log';

/** The shape of a parsed retrieval query (deterministic, no LLM). */
export interface LogQuery {
  /** Inclusive lower bound (ISO) for `at`, or null for "no lower bound". */
  sinceIso: string | null;
  /** Exclusive upper bound (ISO) for `at`, or null for "no upper bound". */
  untilIso: string | null;
  /** Human label for the window used in the spoken frame ("yesterday", "on Monday"). */
  windowLabel: string | null;
  /** Content keywords the entry text must contain (all lowercased), e.g. ["cough"]. */
  keywords: string[];
  /** A specific category filter inferred from the query, or null. */
  category: LogCategory | null;
  /** True for onset queries ("when did … start") — return the EARLIEST match. */
  onset: boolean;
  /** True when the caregiver asked to LIST/show the entries (emit a card). */
  wantsList: boolean;
}

/** Dependencies for the log-retrieval runner (DI style, mirroring the sibling modes). */
export interface LogRetrievalDeps {
  /** Store repositories — the `log_entry` rows are the only source of truth here. */
  repos: Repositories;
  /** The patient whose care log is being queried. */
  patientId: string;
  /** Clock for resolving relative dates ("yesterday") + framing. Defaults to now. */
  now?: () => Date;
}

/**
 * Run the care-log retrieval mode end-to-end and return the contract-valid output: a
 * plain-language recall `say` and, when the caregiver asked to list them, a single
 * retained card. This is the testable core; {@link createLogRetrievalRunner} wraps it
 * as a {@link ModeRunner}.
 *
 * @param userText - the caregiver's question about a past event.
 * @param deps     - injectable store repos, patient id, clock.
 */
export function runLogRetrieval(userText: string, deps: LogRetrievalDeps): ModeOutput {
  const { repos, patientId } = deps;
  const now = (deps.now ?? (() => new Date()))();

  const query = parseQuery(userText, now);
  const matches = queryEntries(repos, patientId, query, now);

  // No match → say so plainly, no card (R11.4).
  if (matches.length === 0) {
    return modeOutputSchema.parse({
      say: buildNoMatchSay(query),
      cards: [],
      memory_ops: [],
      flags: ['none'],
    });
  }

  // Onset queries ("when did the cough start") → answer with the EARLIEST match only.
  if (query.onset) {
    const earliest = matches[matches.length - 1]!; // matches are newest-first
    const say = buildOnsetSay(earliest, query, now);
    const cards = query.wantsList ? [buildRetrievalCard([earliest], query, now)] : [];
    return modeOutputSchema.parse({ say, cards, memory_ops: [], flags: ['none'] });
  }

  // General recall → plain summary of the matches, optionally listed as a card.
  const say = buildRecallSay(matches, query, now);
  const cards = query.wantsList ? [buildRetrievalCard(matches, query, now)] : [];
  return modeOutputSchema.parse({ say, cards, memory_ops: [], flags: ['none'] });
}

/**
 * Create the care-log retrieval {@link ModeRunner} (Task 27). `run(userText)` returns
 * the contract-valid {@link ModeOutput}: a plain-language recall answer and, on a list
 * request, a single retained card. Retrieval is deterministic over the store, so there
 * is no LLM dependency and no async work — `run` resolves synchronously wrapped in a
 * promise to satisfy the {@link ModeRunner} interface.
 *
 * @param deps - injectable store repos, patient id, clock.
 */
export function createLogRetrievalRunner(deps: LogRetrievalDeps): ModeRunner {
  return {
    mode: LOG_MODE,
    async run(userText: string): Promise<ModeOutput> {
      return runLogRetrieval(userText, deps);
    },
  };
}

// ---------------------------------------------------------------------------
// Query parsing (deterministic; no LLM) — dates + keywords + intent.
// ---------------------------------------------------------------------------

/** Lowercased weekday names, index 0 = Sunday to match `Date.getUTCDay()`. */
const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

/** Category cue words → the {@link LogCategory} they imply, for keyword filtering. */
const CATEGORY_CUES: Array<{ category: LogCategory; words: RegExp }> = [
  { category: 'medication_given', words: /\b(med|meds|medication|medications|pill|pills|dose|doses)\b/ },
  { category: 'sleep', words: /\b(sleep|slept|sleeping|nap|napped|rest)\b/ },
  { category: 'food', words: /\b(eat|ate|eating|food|appetite|drink|drank|meal|meals)\b/ },
];

/** One UTC day in milliseconds. */
const DAY_MS = 86_400_000;

/**
 * Parse a caregiver question into a deterministic {@link LogQuery}: a date window, any
 * content keywords / category cue, whether it is an onset question, and whether the
 * caregiver wants the matches listed as a card. Pure and exported for direct testing.
 */
export function parseQuery(userText: string, now: Date): LogQuery {
  const lower = userText.toLowerCase();

  const { sinceIso, untilIso, windowLabel } = parseDateWindow(lower, now);
  const onset = isOnsetQuery(lower);
  const wantsList = isListRequest(lower);
  const category = inferCategory(lower);
  const keywords = extractKeywords(lower);

  return { sinceIso, untilIso, windowLabel, keywords, category, onset, wantsList };
}

/** Start-of-UTC-day epoch ms for a date (drops the time component). */
function startOfUtcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Resolve a relative/explicit date window from the query. Supports "today",
 * "yesterday", weekday names ("on Monday" → the most recent past Monday), "this week"
 * / "last week", "last N days", and explicit ISO dates (YYYY-MM-DD). Returns null
 * bounds (an unbounded search) when no date phrase is present — an onset/keyword query
 * like "when did the cough start" searches the whole log. Exported for testing.
 */
export function parseDateWindow(
  lower: string,
  now: Date,
): { sinceIso: string | null; untilIso: string | null; windowLabel: string | null } {
  const todayStart = startOfUtcDay(now);

  // Explicit ISO date: "on 2024-03-02" / "2024-03-02".
  const iso = lower.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const dayStart = Date.parse(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00.000Z`);
    if (!Number.isNaN(dayStart)) {
      return {
        sinceIso: new Date(dayStart).toISOString(),
        untilIso: new Date(dayStart + DAY_MS).toISOString(),
        windowLabel: `on ${iso[1]}-${iso[2]}-${iso[3]}`,
      };
    }
  }

  if (/\btoday\b/.test(lower)) {
    return dayWindow(todayStart, 'today');
  }

  if (/\byesterday\b/.test(lower)) {
    return dayWindow(todayStart - DAY_MS, 'yesterday');
  }

  if (/\blast week\b/.test(lower)) {
    return {
      sinceIso: new Date(todayStart - 7 * DAY_MS).toISOString(),
      untilIso: new Date(todayStart).toISOString(),
      windowLabel: 'last week',
    };
  }

  if (/\b(this week|past week|last (\d+) days|past (\d+) days|recently|lately)\b/.test(lower)) {
    const nMatch = lower.match(/\b(?:last|past) (\d+) days\b/);
    const days = nMatch ? Math.max(1, Number(nMatch[1])) : 7;
    return {
      sinceIso: new Date(todayStart - (days - 1) * DAY_MS).toISOString(),
      untilIso: new Date(todayStart + DAY_MS).toISOString(),
      windowLabel: nMatch ? `in the last ${days} days` : 'recently',
    };
  }

  // Weekday name → the most recent occurrence of that weekday on or before today.
  for (let i = 0; i < WEEKDAYS.length; i++) {
    const name = WEEKDAYS[i]!;
    if (new RegExp(`\\b${name}\\b`).test(lower)) {
      const dayStart = mostRecentWeekday(now, i);
      return dayWindow(dayStart, `on ${capitalize(name)}`);
    }
  }

  return { sinceIso: null, untilIso: null, windowLabel: null };
}

/** A single-day [start, start+1day) window with a spoken label. */
function dayWindow(
  dayStart: number,
  windowLabel: string,
): { sinceIso: string; untilIso: string; windowLabel: string } {
  return {
    sinceIso: new Date(dayStart).toISOString(),
    untilIso: new Date(dayStart + DAY_MS).toISOString(),
    windowLabel,
  };
}

/**
 * Epoch-ms start-of-day of the most recent occurrence of `targetDay` (0=Sun..6=Sat)
 * on or before `now`. "on Monday" asked on a Wednesday resolves to this week's Monday;
 * asked on a Monday it resolves to today.
 */
function mostRecentWeekday(now: Date, targetDay: number): number {
  const todayStart = startOfUtcDay(now);
  const currentDay = new Date(todayStart).getUTCDay();
  const back = (currentDay - targetDay + 7) % 7;
  return todayStart - back * DAY_MS;
}

/** True when the query asks about onset — the FIRST time something happened. */
export function isOnsetQuery(lower: string): boolean {
  return (
    /\bwhen did\b/.test(lower) ||
    /\bwhen (was|were)\b/.test(lower) ||
    /\b(start|started|starting|begin|began|first)\b/.test(lower)
  );
}

/** True when the caregiver asked to LIST / show the matching entries (emit a card). */
export function isListRequest(lower: string): boolean {
  return /\b(list|show|show me|pull up|display|give me|write (it|them) (down|up)|make a (card|list)|as a (card|list))\b/.test(
    lower,
  );
}

/** Infer a category filter from cue words, or null when the query is category-agnostic. */
function inferCategory(lower: string): LogCategory | null {
  for (const cue of CATEGORY_CUES) {
    if (cue.words.test(lower)) return cue.category;
  }
  return null;
}

/**
 * Extract meaningful content keywords the entry text must contain. Drops the
 * interrogative/temporal glue ("what", "happened", "yesterday", weekday names, "when",
 * "did", "start", etc.) so an onset query like "when did the cough start" reduces to
 * ["cough"]. A purely temporal question ("what happened yesterday") reduces to no
 * keywords, so the date window alone selects the entries. Exported for testing.
 */
export function extractKeywords(lower: string): string[] {
  return (
    lower
      // Drop explicit ISO dates first so their digit-runs don't become keywords.
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
      .split(/[^a-z0-9]+/)
      // Drop bare number tokens (e.g. the "3" in "last 3 days") — they are never
      // log subjects, only window sizes handled by the date parser.
      .filter((t) => t.length > 2 && !/^\d+$/.test(t) && !QUERY_STOP_WORDS.has(t) && !isWeekday(t))
  );
}

/** True when a token is a weekday name (already handled by the date window). */
function isWeekday(token: string): boolean {
  return (WEEKDAYS as readonly string[]).includes(token);
}

// ---------------------------------------------------------------------------
// Store query — deterministic filtering over log_entry rows.
// ---------------------------------------------------------------------------

/**
 * Query the `log_entry` store for entries matching the parsed window + keyword +
 * category filters. Returns matches NEWEST-FIRST (the store's order), so callers take
 * the last element for the earliest/onset entry. Deterministic and LLM-free — this is
 * the whole retrieval path (design.md provider-degradation). Exported for testing.
 */
export function queryEntries(
  repos: Repositories,
  patientId: string,
  query: LogQuery,
  now: Date,
): LogEntry[] {
  // Pull the candidate window from the store. `list(patientId, sinceIso)` already
  // filters `at >= sinceIso`; the exclusive upper bound (and unbounded onset search)
  // are applied in code so a single store method serves every window shape.
  const sinceForStore = query.sinceIso ?? undefined;
  const candidates = repos.logEntry.list(patientId, sinceForStore);

  return candidates.filter((entry) => {
    if (query.untilIso && entry.at >= query.untilIso) return false;
    if (query.category && entry.category !== query.category) return false;
    if (query.keywords.length > 0 && !entryMatchesKeywords(entry, query.keywords)) return false;
    return true;
  });
}

/**
 * True when the entry's text contains ALL query keywords (case-insensitive substring).
 * Substring (not token) matching so "cough" matches "coughing" and "a new cough".
 */
function entryMatchesKeywords(entry: LogEntry, keywords: string[]): boolean {
  const text = entry.text.toLowerCase();
  return keywords.every((kw) => text.includes(kw));
}

// ---------------------------------------------------------------------------
// Say + card composition (recall only, zero interpretation) — built in code.
// ---------------------------------------------------------------------------

/**
 * Build the plain no-match answer (R11.4). One neutral sentence, no card. Names the
 * window/keyword the caregiver asked about so the "nothing found" is concrete.
 */
export function buildNoMatchSay(query: LogQuery): string {
  const scope = describeScope(query);
  return `I don't have anything logged ${scope}.`;
}

/**
 * Build the ONSET answer for "when did the <thing> start" (R11.4). Reports the earliest
 * matching entry with a neutral when-frame — pure recall, never interpretation. Falls
 * back to a plain "no earlier note" style only when there is genuinely nothing (handled
 * by the no-match path before this is called).
 */
export function buildOnsetSay(earliest: LogEntry, query: LogQuery, now: Date): string {
  const subject = query.keywords.length > 0 ? query.keywords.join(' ') : 'that';
  const when = relativeWhen(earliest.at, now);
  // Echo the caregiver's own words for the entry, framed as recall.
  return `The first time you noted ${subject} was ${when}: "${trimText(earliest.text)}".`;
}

/**
 * Build the general recall answer (R11.4). Summarizes the matches with neutral
 * when-frames, naming up to {@link MAX_SPOKEN_ENTRIES} and counting the rest. Pure
 * recall — echoes stored text, never advises/compares/triages.
 */
export function buildRecallSay(matches: LogEntry[], query: LogQuery, now: Date): string {
  const scope = describeScope(query);
  const named = matches.slice(0, MAX_SPOKEN_ENTRIES);
  const phrases = named.map((e) => `${relativeWhen(e.at, now)}, "${trimText(e.text)}"`);
  const remainder = matches.length - named.length;

  const lead =
    matches.length === 1
      ? `Here's what you logged ${scope}:`
      : `Here's what you logged ${scope}:`;

  let body = joinList(phrases);
  if (remainder > 0) {
    body += `, and ${remainder} more ${remainder === 1 ? 'note' : 'notes'}`;
  }
  return `${lead} ${body}.`;
}

/**
 * Build the single RETAINED retrieval card listing the matching entries (R11.4). Body
 * lists up to {@link MAX_CARD_ENTRIES} entries as neutral "When — text" lines (≤3
 * lines, 280-char cap), summarizing any remainder; no action (a recalled log is kept,
 * not acted on) and zero interpretation. Exported for direct testing.
 */
export function buildRetrievalCard(matches: LogEntry[], query: LogQuery, now: Date): Card {
  const listed = matches.slice(0, MAX_CARD_ENTRIES);
  const lines = listed.map((e) => `${capitalize(relativeWhen(e.at, now))} — ${trimText(e.text)}`);
  const remainder = matches.length - listed.length;
  if (remainder > 0) lines.push(`+${remainder} more`);

  return {
    type: 'retained',
    title: RETRIEVAL_CARD_TITLE,
    body: truncate(lines.join('\n'), 280),
  };
}

/** Describe the query scope for a spoken frame ("yesterday", "for cough", "yet"). */
function describeScope(query: LogQuery): string {
  const parts: string[] = [];
  if (query.windowLabel) parts.push(query.windowLabel);
  if (query.keywords.length > 0) parts.push(`about ${query.keywords.join(' ')}`);
  if (parts.length === 0) return 'yet';
  return parts.join(' ');
}

/**
 * Non-interpretive relative-day phrasing for a retrieval timestamp — the SAME
 * philosophy as the memory service's recall frame: report WHEN, never what it means.
 * Older-than-a-week falls back to the ISO date. Exported for direct testing.
 */
export function relativeWhen(atIso: string, now: Date): string {
  const at = new Date(atIso);
  if (Number.isNaN(at.getTime())) return 'recently';

  const dayDiff = Math.round((startOfUtcDay(now) - startOfUtcDay(at)) / DAY_MS);
  if (dayDiff <= 0) return 'today';
  if (dayDiff === 1) return 'yesterday';
  if (dayDiff < 7) return `on ${capitalize(WEEKDAYS[at.getUTCDay()]!)}`;
  return `on ${atIso.slice(0, 10)}`;
}

/** Trim an entry's text and drop trailing sentence punctuation so it quotes cleanly. */
function trimText(text: string): string {
  return text.trim().replace(/[.!?]+$/, '');
}

/** Capitalize the first letter of a word/phrase. */
function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

/**
 * Join a list of phrases with commas and a trailing "and", Oxford-style for 3+.
 * ["a"] → "a"; ["a","b"] → "a, and b"; ["a","b","c"] → "a, b, and c".
 */
function joinList(items: string[]): string {
  if (items.length === 0) return 'nothing';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]}, and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** Truncate to at most `max` chars, adding an ellipsis when clipped. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Query glue words dropped from keyword extraction: interrogatives, temporal words,
 * and generic "log/note/happened" verbs. Kept narrow so real subjects ("cough",
 * "nausea", "fall") survive. Weekday names are handled separately by the date window.
 */
const QUERY_STOP_WORDS = new Set([
  'what', 'when', 'where', 'which', 'who', 'why', 'how', 'did', 'was', 'were', 'has',
  'have', 'had', 'the', 'and', 'for', 'you', 'your', 'about', 'that', 'this', 'these',
  'those', 'happen', 'happened', 'happening', 'anything', 'something', 'note', 'noted',
  'log', 'logged', 'logs', 'record', 'recorded', 'entry', 'entries', 'show', 'list',
  'tell', 'give', 'pull', 'display', 'start', 'started', 'starting', 'begin', 'began',
  'first', 'today', 'yesterday', 'week', 'day', 'days', 'last', 'past', 'recently',
  'lately', 'ago', 'any', 'all', 'some', 'there', 'been', 'get', 'got', 'find', 'care',
  'from', 'with', 'went', 'everything', 'anything', 'about', 'was', 'were', 'went',
]);
