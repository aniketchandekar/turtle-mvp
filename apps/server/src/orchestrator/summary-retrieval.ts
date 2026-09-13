import { cardSchema, modeOutputSchema, type Card, type CardRecord, type ModeOutput } from '@turtle/shared';
import type { Repositories } from '../store/index.js';
import type { Mode, ModeRunner } from './index.js';

/**
 * Prep/visit-summary voice retrieval mode — the "read it back" path (Task 30, R12.5).
 *
 * One of the small routed prompts (design.md §Orchestrator). Task 29 produces prep
 * briefing cards ("Prep: <appointment>", with a "what to ask" list) and Task 30's
 * visit-summary mode produces visit-summary cards ("Visit summary…"). This mode reads
 * those cards BACK BY VOICE when the caregiver asks:
 *
 *   "What were the questions for Tuesday?"   → the prep card for that appointment/day.
 *   "What did the doctor say?"               → the most recent visit-summary card.
 *   "Read me the visit summary."             → the most recent visit-summary card.
 *
 * DESIGN NOTES (why it looks the way it does):
 *
 *   - DETERMINISTIC OVER THE STORE, not the KB or an LLM. Like care-log retrieval (Task
 *     27), this reads the STORED artifacts directly — here the `card` rows — by keyword /
 *     day / kind filtering. The match and the spoken answer are composed IN CODE, so the
 *     mode works with ZERO keys (design.md provider-degradation) and has no `llm`
 *     dependency. It searches BOTH the active card and the archive (dismissed + done),
 *     since a prep/summary card the caregiver asks about later has usually left `active`.
 *
 *   - RECALL, NEVER INTERPRET (BINDING). The answer echoes the matched card's own title
 *     and body — the caregiver's/clinician's words as already stored — with a neutral
 *     "here's what I have" frame. It never advises, compares, or triages.
 *
 *   - RE-SURFACE THE MATCHED CARD. On a hit the mode both SPEAKS the content and RE-EMITS
 *     the matched card (retained, same title/body/action) so the client can show it and
 *     the caregiver can re-share it (voice + card parity, R16.8; spoken-and-shown for the
 *     retained artifact). Cards flow only from the validated contract; max one active
 *     card (R10.6) is enforced downstream by the persist path.
 *
 *   - NO MATCH → SAY SO PLAINLY, NO CARD. Mirrors log-retrieval's no-match path.
 *
 * Both this and the prep-briefing / visit-summary / appointment-creation runners carry
 * the `prep` mode tag; the orchestrator selects THIS runner via
 * {@link import('./mode-router.js').isSummaryRetrievalQuery}.
 *
 * Everything is injectable (store repos + patient/session are not even needed — cards are
 * keyed by session but the archive spans them for the single-user MVP) so the whole
 * surface — query parsing, card matching, say composition, re-surface, no-match — is
 * unit-testable with an in-memory store and zero network.
 */

/** This runner's mode tag. Summary retrieval is part of the `prep` mode family. */
const PREP_MODE: Mode = 'prep';

/** Lowercased weekday names, index 0 = Sunday. */
const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

/** What KIND of stored artifact the caregiver is asking to retrieve. */
export type SummaryKind = 'prep' | 'visit_summary' | 'any';

/** A parsed prep/summary retrieval query (deterministic, no LLM). */
export interface SummaryQuery {
  /** Whether the caregiver asked for prep questions, a visit summary, or either. */
  kind: SummaryKind;
  /** Content keywords the card title/body must contain (lowercased), e.g. ["tuesday"]. */
  keywords: string[];
}

/** Dependencies for the summary-retrieval runner (DI style, mirroring the sibling modes). */
export interface SummaryRetrievalDeps {
  /** Store repositories — the `card` rows are the only source of truth here. */
  repos: Repositories;
}

/**
 * Run the prep/visit-summary retrieval mode end-to-end and return the contract-valid
 * output: a plain-language `say` of the matched card's content plus the re-surfaced
 * card, or a plain no-match line with no card. This is the testable core;
 * {@link createSummaryRetrievalRunner} wraps it as a {@link ModeRunner}.
 *
 * @param userText - the caregiver's retrieval question.
 * @param deps     - injectable store repos.
 */
export function runSummaryRetrieval(userText: string, deps: SummaryRetrievalDeps): ModeOutput {
  const query = parseSummaryQuery(userText);
  const match = matchCard(deps.repos, query);

  // No match → say so plainly, no card (R12.5).
  if (!match) {
    return modeOutputSchema.parse({
      say: buildNoMatchSay(query),
      cards: [],
      memory_ops: [],
      flags: ['none'],
    });
  }

  // Hit → speak the content AND re-surface the matched card so it can be shown/shared.
  const say = buildRecallSay(match);
  const cards: Card[] = [reSurfaceCard(match)];
  return modeOutputSchema.parse({ say, cards, memory_ops: [], flags: ['none'] });
}

/**
 * Create the prep/visit-summary retrieval {@link ModeRunner} (Task 30, R12.5).
 * `run(userText)` returns the contract-valid {@link ModeOutput}: the matched card's
 * content spoken back plus the re-surfaced card, or a plain no-match line. Retrieval is
 * deterministic over the store, so there is no LLM dependency; `run` resolves
 * synchronously wrapped in a promise to satisfy the {@link ModeRunner} interface. Shares
 * the `prep` mode tag; the orchestrator selects this runner via
 * {@link import('./mode-router.js').isSummaryRetrievalQuery}.
 *
 * @param deps - injectable store repos.
 */
export function createSummaryRetrievalRunner(deps: SummaryRetrievalDeps): ModeRunner {
  return {
    mode: PREP_MODE,
    async run(userText: string): Promise<ModeOutput> {
      return runSummaryRetrieval(userText, deps);
    },
  };
}

// ---------------------------------------------------------------------------
// Query parsing (deterministic; no LLM).
// ---------------------------------------------------------------------------

/**
 * Parse a caregiver question into a deterministic {@link SummaryQuery}: which KIND of
 * artifact (prep questions vs. visit summary vs. either) and any content keywords (a
 * weekday, appointment name words) the card must contain. Pure and exported for testing.
 */
export function parseSummaryQuery(userText: string): SummaryQuery {
  const lower = userText.toLowerCase();
  const kind = inferKind(lower);
  const keywords = extractKeywords(lower);
  return { kind, keywords };
}

/** Infer the requested artifact kind from the question's cue words. */
function inferKind(lower: string): SummaryKind {
  const wantsVisitSummary =
    /\b(visit )?summary\b/.test(lower) ||
    /\brecap\b/.test(lower) ||
    /\bwhat (did|do)\b.*\b(doctor|oncologist|nurse|clinician|dr\.?)\b.*\bsay\b/.test(lower) ||
    /\b(doctor|oncologist|nurse|clinician|dr\.?)\b.*\bsaid\b/.test(lower);
  const wantsPrep = /\bquestions?\b/.test(lower) || /\bprep\b/.test(lower) || /\bto ask\b/.test(lower);

  if (wantsPrep && !wantsVisitSummary) return 'prep';
  if (wantsVisitSummary && !wantsPrep) return 'visit_summary';
  return 'any';
}

/**
 * Extract meaningful content keywords the card title/body must contain — a weekday
 * ("tuesday"), a clinician/appointment word ("oncology", "lee") — dropping the
 * interrogative/temporal glue and the kind cue words ("questions", "summary") which are
 * handled by {@link inferKind}. Exported for testing.
 */
export function extractKeywords(lower: string): string[] {
  return lower
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

// ---------------------------------------------------------------------------
// Card matching — deterministic filtering over the card rows.
// ---------------------------------------------------------------------------

/**
 * Find the best matching card for the query across the active card and the archive
 * (dismissed + done), NEWEST FIRST. A card is a candidate when its KIND matches the
 * query kind (prep vs. visit-summary, or either) AND every query keyword appears in its
 * title or body. The first candidate (newest) wins. Returns null when nothing matches.
 * Deterministic and LLM-free. Exported for testing.
 */
export function matchCard(repos: Repositories, query: SummaryQuery): CardRecord | null {
  // Newest-first union of active + archived so a card asked about later (which has
  // usually left `active`) is still found. Both lists are already created_at DESC.
  const candidates = [...repos.card.listByStatus('active'), ...repos.card.listArchived()];

  for (const card of candidates) {
    if (!kindMatches(card, query.kind)) continue;
    if (!keywordsMatch(card, query.keywords)) continue;
    return card;
  }
  return null;
}

/** True when the card's kind matches the requested kind (title-based classification). */
function kindMatches(card: CardRecord, kind: SummaryKind): boolean {
  if (kind === 'any') return isPrepCard(card) || isVisitSummaryCard(card);
  if (kind === 'prep') return isPrepCard(card);
  return isVisitSummaryCard(card);
}

/** A prep briefing card — Task 29 titles them "Prep: <appointment>". */
function isPrepCard(card: CardRecord): boolean {
  return /^prep\b/i.test(card.title.trim());
}

/** A visit-summary card — Task 30 titles them "Visit summary" / "Visit summary: …". */
function isVisitSummaryCard(card: CardRecord): boolean {
  return /^visit summary\b/i.test(card.title.trim());
}

/** True when every keyword appears (case-insensitive substring) in the card title/body. */
function keywordsMatch(card: CardRecord, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  const haystack = `${card.title}\n${card.body}`.toLowerCase();
  return keywords.every((kw) => haystack.includes(kw));
}

// ---------------------------------------------------------------------------
// Say + re-surfaced card composition (recall only) — built in code.
// ---------------------------------------------------------------------------

/**
 * Build the plain no-match answer (R12.5). One neutral sentence, no card, naming what
 * was asked for so "nothing found" is concrete. Exported for direct testing.
 */
export function buildNoMatchSay(query: SummaryQuery): string {
  const subject = describeSubject(query);
  return `I don't have ${subject} saved.`;
}

/**
 * Build the recall answer for a matched card (R12.5): the card title framed as "Here's
 * <title>:", then its body read back. Pure recall — echoes the stored artifact, never
 * interprets. Exported for direct testing.
 */
export function buildRecallSay(card: CardRecord): string {
  const title = trimText(card.title);
  // The body is already neutral labeled lines; read them back as a flowing sentence.
  const body = card.body
    .split('\n')
    .map((line) => line.replace(/^[•\-\s]+/, '').trim())
    .filter((line) => line.length > 0)
    .join('; ');
  return body.length > 0 ? `Here's ${title}: ${body}.` : `Here's ${title}.`;
}

/**
 * Re-emit the matched card so the client can show it and the caregiver can re-share it
 * (R12.5). Preserves the stored type/title/body/action (so a visit summary keeps its
 * `share` action). Exported for direct testing.
 */
export function reSurfaceCard(card: CardRecord): Card {
  const base = {
    type: card.type,
    title: card.title,
    body: card.body,
    // The stored action's `kind` is a string on CardRecord but was written from a valid
    // CardAction; re-parse through the card schema below so the shape is guaranteed.
    ...(card.action ? { action: { kind: card.action.kind, target: card.action.target } } : {}),
  };
  // Validate/normalize into a contract Card so a bad stored action can never leak out.
  return cardSchema.parse(base);
}

/** Describe the requested subject for a spoken frame ("the questions for Tuesday"). */
function describeSubject(query: SummaryQuery): string {
  const base =
    query.kind === 'prep'
      ? 'those prep questions'
      : query.kind === 'visit_summary'
        ? 'that visit summary'
        : 'that';
  const scope = query.keywords.length > 0 ? ` for ${query.keywords.join(' ')}` : '';
  return `${base}${scope}`;
}

/** Trim text and drop trailing sentence punctuation so fields compose cleanly. */
function trimText(text: string): string {
  return text.trim().replace(/[.!?]+$/, '');
}

/**
 * Query glue words dropped from keyword extraction: interrogatives, temporal words, the
 * kind-cue words (handled by {@link inferKind}), and generic verbs. Kept narrow so real
 * subjects (weekdays, clinician/appointment names) survive.
 */
const STOP_WORDS = new Set([
  'what', 'were', 'was', 'the', 'for', 'about', 'before', 'from', 'did', 'do', 'does',
  'read', 'show', 'pull', 'give', 'tell', 'you', 'your', 'that', 'this', 'these', 'those',
  'questions', 'question', 'summary', 'summaries', 'recap', 'prep', 'notes', 'note', 'ask',
  'say', 'said', 'doctor', 'oncologist', 'nurse', 'clinician', 'appointment', 'visit',
  'and', 'are', 'were', 'have', 'has', 'had', 'them', 'they', 'she', 'her', 'his', 'him',
  'again', 'please', 'back', 'wanted', 'want', 'know', 'get', 'got', 'find', 'there',
]);
