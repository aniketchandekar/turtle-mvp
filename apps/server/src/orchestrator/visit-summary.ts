import { modeOutputSchema, type Appointment, type Card, type ModeOutput } from '@turtle/shared';
import type { LlmMessage, LlmProvider, LlmRunOptions } from '../services/llm/index.js';
import { runMode } from '../services/llm/index.js';
import type { Repositories } from '../store/index.js';
import type { Mode, ModeRunner } from './index.js';

/**
 * Visit-summary dictation mode — the "what the doctor said" write path (Task 30, R12.4).
 *
 * One of the small routed prompts (design.md §Orchestrator: no god-prompt). It owns
 * exactly one thing: after a visit the caregiver DICTATES what the clinician conveyed
 * ("The doctor said the scan was stable and to keep the same dose, come back in two
 * weeks"), and this mode STRUCTURES that dictation into a visit summary and emits ONE
 * RETAINED card that is SHAREABLE VIA LINK.
 *
 * It is the direct analog of the appointment-creation and care-log extraction modes:
 * utterance → structured record → passive artifact, all validated through the response
 * contract. Both this and the prep-briefing / appointment-creation runners carry the
 * `prep` mode tag; the orchestrator selects THIS runner via
 * {@link import('./mode-router.js').isVisitSummaryDictation}, mirroring how
 * {@link import('./mode-router.js').isAppointmentCreation} splits creation from
 * retrieval. The RETRIEVAL of a stored summary by voice ("what did the doctor say?") is
 * the summary-retrieval mode (Task 30, R12.5), NOT this one.
 *
 * DESIGN NOTES (why it looks the way it does):
 *
 *   - STRUCTURE, NEVER INTERPRET (BINDING, product.md / safety.md). This mode records
 *     WHAT the clinician said — it does not add advice, triage, dosing, or prognosis of
 *     its own. "Log, never interpret" applies: the structured summary is the
 *     caregiver's report of the visit, framed neutrally. With a LIVE LLM the routed
 *     prompt reorganizes the dictation into a headline + points + optional follow-up
 *     WITHOUT adding anything; with a NON-LIVE provider (zero-key) the runner falls back
 *     to a deterministic structuring (the whole utterance as a single point) so the
 *     summary is never dropped and no keys are required (R16.4 spirit; every provider
 *     has a fallback).
 *
 *   - ONE RETAINED CARD, SHAREABLE VIA LINK (R12.4). A visit summary is a "retained"
 *     card (something to show someone later — see the card taxonomy). "Shareable via
 *     link" means a retrievable card with a stable id/URL: the card is persisted (the
 *     store assigns a stable id, stamped onto the contract by the gateway) and carries
 *     a `share` action pointing at the shareable-link retrieval route
 *     ({@link SHARE_ROUTE_BASE}, backed by `GET /cards/:id`). The client composes
 *     `{target}/{card.id}` into the shareable link. Max one active card (R10.6) is
 *     enforced by the card service / persist path.
 *
 *   - OPTIONALLY TIED TO AN APPOINTMENT. When the patient has exactly one obvious recent
 *     appointment (or the dictation names a matching one), the card title/body carry the
 *     appointment name + date so the summary is anchored. This is best-effort and
 *     deterministic over the store; when nothing matches, the summary stands on its own.
 *
 * Everything is injectable (the LLM provider, optional store repos + patient id, run
 * options) so the whole surface — structuring, zero-key fallback, card shape,
 * appointment anchoring — is unit-testable with a fake LLM / in-memory store and zero
 * network.
 */

/** This runner's mode tag. Visit-summary dictation is part of the `prep` mode family. */
const VISIT_SUMMARY_MODE: Mode = 'prep';

/** Title for the retained visit-summary card when no appointment anchors it (R12.4). */
export const VISIT_SUMMARY_CARD_TITLE = 'Visit summary';

/**
 * The base path of the shareable-link retrieval route (`GET /cards/:id`). The card's
 * `share` action carries this as its `target`; the client composes `{target}/{id}` once
 * the store-assigned id is stamped onto the contract card. Kept here so the write path
 * and the REST route agree on one convention.
 */
export const SHARE_ROUTE_BASE = '/cards';

/** How many structured points to keep (short for voice + the card's ≤3-line body). */
export const MAX_SUMMARY_POINTS = 4;

/** A structured visit summary extracted from the caregiver's dictation (R12.4). */
export interface VisitSummary {
  /** A one-line takeaway of the visit, in the caregiver's/clinician's own terms. */
  headline: string;
  /** The substantive points the clinician conveyed (kept as reported, not interpreted). */
  points: string[];
  /** An explicit next step / when-to-return, when the dictation stated one. */
  follow_up?: string;
}

/**
 * Structuring-only system prompt (R12.4). Small and routed: it does EXACTLY one thing —
 * reorganize the caregiver's dictation of what the clinician said into a structured
 * summary — and is explicitly forbidden from adding advice, dosing, prognosis, or
 * triage. It reports the caregiver's words back, structured; it never invents content.
 */
export const VISIT_SUMMARY_SYSTEM =
  'You are the visit-summary structurer for Turtle, a caregiver voice companion. After ' +
  'a medical visit the caregiver has dictated WHAT THE DOCTOR SAID. Your ONLY job is to ' +
  'structure that dictation into a summary of what was conveyed.\n' +
  'Strict rules:\n' +
  '- Extract these fields:\n' +
  '  - headline: a short one-line takeaway of the visit, in the caregiver\'s own terms. ' +
  'REQUIRED.\n' +
  `  - points: an array of the substantive things the clinician said (at most ${MAX_SUMMARY_POINTS}), ` +
  'each a short phrase. REQUIRED (may be a single item).\n' +
  '  - follow_up: the next step or when to return, if stated (e.g. "come back in two ' +
  'weeks"). Omit if not mentioned.\n' +
  '- Report ONLY what the caregiver said the clinician conveyed. Do NOT add advice, ' +
  'dosing, prognosis, triage, or ANY content of your own. Never interpret.\n' +
  'Reply ONLY with a JSON object of the form ' +
  '{"headline": "<takeaway>", "points": ["<point>", ...], "follow_up": "<next step?>"} ' +
  'and NOTHING else. Omit follow_up entirely when not mentioned.';

/** Dependencies for the visit-summary runner (DI style, mirroring the sibling modes). */
export interface VisitSummaryDeps {
  /**
   * The resolved LLM provider. When `provider.live === false` (canned/zero-key) the
   * runner falls back to a deterministic structuring rather than relying on model
   * output — the summary is still recorded with zero keys.
   */
  llm: LlmProvider;
  /**
   * Store repositories, optional. When present (with {@link patientId}) the runner
   * anchors the summary to the patient's nearest obvious appointment so the card names
   * it. When absent the summary stands on its own.
   */
  repos?: Repositories;
  /** The patient whose appointment (if any) anchors the summary. */
  patientId?: string;
  /** Optional timeout/timer knobs forwarded to {@link runMode}. Injectable for tests. */
  runOptions?: LlmRunOptions;
}

/**
 * Run the visit-summary dictation mode end-to-end and return the contract-valid output:
 * a passive confirmation + ONE shareable retained card. This is the testable core;
 * {@link createVisitSummaryRunner} wraps it as a {@link ModeRunner}.
 *
 * @param userText - the caregiver's dictation of what the doctor said.
 * @param deps     - injectable LLM + optional store/patient + run options.
 */
export async function runVisitSummary(
  userText: string,
  deps: VisitSummaryDeps,
): Promise<ModeOutput> {
  const { llm, repos, patientId, runOptions } = deps;

  const summary = await structureSummary(userText, llm, runOptions);

  // Best-effort anchor to an appointment so the card can name it (deterministic, no LLM).
  const appointment =
    repos && patientId ? pickAnchorAppointment(repos, patientId, userText) : undefined;

  const say = buildConfirmation(summary, appointment);
  const cards: Card[] = [buildVisitSummaryCard(summary, appointment)];

  // No memory op: a visit summary is a retained CARD (the artifact), not a log entry or
  // an appointment. Cards flow only from the validated contract.
  return modeOutputSchema.parse({ say, cards, memory_ops: [], flags: ['none'] });
}

/**
 * Create the visit-summary dictation {@link ModeRunner} (Task 30, R12.4). `run(userText)`
 * returns the contract-valid {@link ModeOutput}: a passive confirmation and a single
 * shareable retained visit-summary card. Shares the `prep` mode tag with the other
 * appointment modes; the orchestrator selects this runner via
 * {@link import('./mode-router.js').isVisitSummaryDictation}.
 *
 * @param deps - injectable LLM + optional store/patient + run options.
 */
export function createVisitSummaryRunner(deps: VisitSummaryDeps): ModeRunner {
  return {
    mode: VISIT_SUMMARY_MODE,
    async run(userText: string): Promise<ModeOutput> {
      return runVisitSummary(userText, deps);
    },
  };
}

// ---------------------------------------------------------------------------
// Structuring — generated with a live LLM, deterministic fallback otherwise.
// ---------------------------------------------------------------------------

/**
 * Structure the dictation into a {@link VisitSummary}. With a LIVE LLM this runs the
 * structuring-only prompt and parses the JSON object; with a non-live provider (or on
 * any parse/model failure) it falls back to a deterministic structuring so the summary
 * is always produced (zero-key degradation, R16.4 spirit). Exported for testing.
 */
export async function structureSummary(
  userText: string,
  llm: LlmProvider,
  runOptions?: LlmRunOptions,
): Promise<VisitSummary> {
  // Zero-key degradation: a non-live provider only echoes, which is not a usable
  // structuring. Record the utterance deterministically instead.
  if (!llm.live) return fallbackSummary(userText);

  const messages: LlmMessage[] = [
    { role: 'system', content: VISIT_SUMMARY_SYSTEM },
    { role: 'user', content: userText },
  ];

  // runMode returns a ModeOutput; the structurer is asked for a bare JSON object, so it
  // is carried in `say`. Parse it, else fall back deterministically.
  const raw = await runMode(llm, messages, runOptions);
  const parsed = parseSummaryJson(raw.say);
  return parsed ?? fallbackSummary(userText);
}

/**
 * Parse the model's `say` text as the requested JSON object. Tolerates surrounding
 * prose/fences by extracting the first `{...}` block. Returns null when no usable object
 * (a non-empty headline + at least one non-empty point) is found (the caller then falls
 * back). Exported for direct testing.
 */
export function parseSummaryJson(raw: string): VisitSummary | null {
  // Reject an array-first shape (the model answered with the wrong container).
  const firstBrace = raw.indexOf('{');
  const firstBracket = raw.indexOf('[');
  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) return null;

  const obj = extractJsonObject(raw);
  if (obj === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(obj);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const headline = typeof record.headline === 'string' ? record.headline.trim() : '';
  const points = Array.isArray(record.points)
    ? record.points
        .filter((p): p is string => typeof p === 'string')
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
    : [];
  if (headline.length === 0 || points.length === 0) return null;

  const followUp = typeof record.follow_up === 'string' ? record.follow_up.trim() : '';
  return normalizeSummary({
    headline,
    points,
    follow_up: followUp.length > 0 ? followUp : undefined,
  });
}

/** Normalize a summary: trim fields, bound the points, drop empty optionals. */
function normalizeSummary(input: VisitSummary): VisitSummary {
  const followUp = input.follow_up?.trim();
  return {
    headline: input.headline.trim(),
    points: input.points.map((p) => p.trim()).filter((p) => p.length > 0).slice(0, MAX_SUMMARY_POINTS),
    ...(followUp && followUp.length > 0 ? { follow_up: followUp } : {}),
  };
}

/** Extract the first balanced top-level JSON object substring, or null. */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
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
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * The deterministic fallback: the whole dictation recorded as a single point, with a
 * neutral headline. Used with a non-live provider or when the model produced nothing
 * usable, so a dictated visit summary is never silently dropped (R12.4). Empty input
 * degrades to a neutral placeholder so both required fields are always non-empty (the
 * card/contract require it). Exported for testing.
 */
export function fallbackSummary(userText: string): VisitSummary {
  const text = userText.trim();
  if (text.length === 0) {
    return { headline: 'Visit summary', points: ['(no details captured)'] };
  }
  return {
    headline: 'Visit summary',
    // Record the caregiver's verbatim words as the single point — no restructuring,
    // no interpretation, in the zero-key path.
    points: [text],
  };
}

// ---------------------------------------------------------------------------
// Appointment anchoring (best-effort, deterministic; no LLM).
// ---------------------------------------------------------------------------

/**
 * Pick the appointment (if any) this summary should be anchored to, deterministically
 * over the store. Preference order: (1) an upcoming appointment whose title/clinician is
 * NAMED in the dictation; else (2) when there is exactly one upcoming appointment, that
 * one. Otherwise undefined — the summary stands on its own rather than guessing. Pure
 * over the store (no LLM). Exported for testing.
 */
export function pickAnchorAppointment(
  repos: Repositories,
  patientId: string,
  userText: string,
): Appointment | undefined {
  const upcoming = repos.appointment.listUpcoming(patientId);
  if (upcoming.length === 0) return undefined;

  const lower = userText.toLowerCase();
  const named = upcoming.find((a) => {
    const title = a.title.trim().toLowerCase();
    const who = a.with_whom?.trim().toLowerCase();
    return (title.length > 0 && lower.includes(title)) || (who ? lower.includes(who) : false);
  });
  if (named) return named;

  return upcoming.length === 1 ? upcoming[0] : undefined;
}

// ---------------------------------------------------------------------------
// Passive confirmation + shareable visit-summary card (R12.4) — composed in code.
// ---------------------------------------------------------------------------

/**
 * Build the passive spoken confirmation (R12.4). Neutral: it reports that the summary
 * was captured and can be shared, naming the appointment when one anchors it. It never
 * repeats interpretation or advice — just a "saved, here to share" confirmation.
 * Exported for direct testing.
 */
export function buildConfirmation(summary: VisitSummary, appointment?: Appointment): string {
  const anchor = appointment ? ` from ${trimText(appointment.title)}` : '';
  const headline = trimText(summary.headline);
  return `Saved a visit summary${anchor}: ${headline}. You can share it by link whenever you're ready.`;
}

/**
 * Build the single RETAINED, shareable visit-summary card (R12.4). Title = the
 * appointment name (when anchored) else {@link VISIT_SUMMARY_CARD_TITLE}; body = the
 * headline, the points, and an optional follow-up as neutral lines (≤ the contract's
 * 280-char cap). Carries a `share` action pointing at {@link SHARE_ROUTE_BASE} so the
 * card is shareable via link once the store stamps its stable id. No interpretation.
 * Exported for direct testing.
 */
export function buildVisitSummaryCard(summary: VisitSummary, appointment?: Appointment): Card {
  const title = appointment
    ? `Visit summary: ${trimText(appointment.title)}`
    : VISIT_SUMMARY_CARD_TITLE;

  const lines: string[] = [];
  if (appointment) lines.push(`When: ${trimText(appointment.at)}`);
  lines.push(trimText(summary.headline));
  for (const point of summary.points) lines.push(`• ${trimText(point)}`);
  if (summary.follow_up) lines.push(`Next: ${trimText(summary.follow_up)}`);

  return {
    type: 'retained',
    title,
    body: truncate(lines.join('\n'), 280),
    // Shareable via link: the stable-id retrieval route. The client composes
    // `{target}/{card.id}` once the persisted id is stamped onto the contract card.
    action: { kind: 'share', target: SHARE_ROUTE_BASE },
  };
}

/** Trim text and drop trailing sentence punctuation so fields compose cleanly. */
function trimText(text: string): string {
  return text.trim().replace(/[.!?]+$/, '');
}

/** Truncate to at most `max` chars, adding an ellipsis when clipped. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
