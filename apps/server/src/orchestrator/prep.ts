import { modeOutputSchema, type Appointment, type Card, type ModeOutput } from '@turtle/shared';
import type { LlmMessage, LlmProvider, LlmRunOptions } from '../services/llm/index.js';
import { runMode } from '../services/llm/index.js';
import type { Repositories } from '../store/index.js';
import type { Mode, ModeRunner } from './index.js';

/**
 * Appointment prep-briefing mode — `prep.prompt` (Task 29, R12.2/R12.3).
 *
 * One of the small routed prompts (design.md §Orchestrator: no god-prompt). It owns
 * exactly one thing: when a session occurs within a configurable look-ahead window
 * (default 48h) before an upcoming appointment, OFFER a prep briefing — the
 * appointment's purpose, what to report, and suggested questions — and produce ONE
 * card per appointment carrying the name, date, and a "what to ask" list.
 *
 * It is the read/briefing sibling of the appointment-CREATION mode (`appointment.ts`,
 * Task 28): both carry the `prep` mode tag, and the orchestrator selects the creation
 * runner (write) vs. this briefing runner (read) via
 * {@link import('./mode-router.js').isAppointmentCreation}. This runner does NOT create
 * appointments and does NOT do visit-summary dictation or arbitrary prep/summary
 * voice retrieval — that is Task 30.
 *
 * DESIGN NOTES (why it looks the way it does):
 *
 *   - IN-WINDOW DETECTION IS DETERMINISTIC OVER THE STORE. The upcoming appointments
 *     come from `repos.appointment.listUpcoming` (Task 28). Each appointment's `at` is
 *     the caregiver's own phrasing, which MAY or may not be a parseable date. An
 *     appointment is "within the window" only when its `at` PARSES to a concrete time
 *     that falls in `(now, now + windowHours]` — the briefing is offered against a
 *     known clock time (R12.2). Appointments whose `at` is free text we cannot place on
 *     a clock ("Tuesday at 2pm" with no date) are not windowed, so no briefing is
 *     forced for a time we cannot verify. This selection needs no LLM and works with
 *     zero keys.
 *
 *   - SUGGESTED QUESTIONS HAVE A FALLBACK. The briefing's "what to ask" list is the one
 *     part that benefits from generation. With a LIVE LLM the questions are generated
 *     from the appointment (purpose/with_whom) via a small routed prompt; with a
 *     NON-LIVE provider (zero-key) the runner falls back to a deterministic, neutral
 *     question set so a briefing is still produced with no keys (R16.4 spirit; every
 *     provider has a fallback). Either way the questions are plain, non-clinical
 *     prompts a caregiver can ASK — never medical decisions, dosing, or triage.
 *
 *   - ONE CARD PER APPOINTMENT (R12.3), MAX ONE ACTIVE (R10.6). The response contract
 *     caps a turn at one card and the MVP allows one active card. The briefing card is
 *     built PER APPOINTMENT ({@link buildBriefingCard}: title = the appointment name,
 *     body = the date + a "what to ask" list), and the turn emits the card for the
 *     NEAREST in-window appointment. {@link buildBriefingCard} is exported so the
 *     per-appointment shape is directly testable and reusable.
 *
 *   - NO INTERPRETATION. The spoken `say` and the card are composed IN CODE from the
 *     appointment fields + the (bounded) question list. The mode never advises,
 *     triages, or interprets (product.md / safety.md); it offers a neutral briefing and
 *     a list of questions to ASK the care team.
 *
 *   - NO APPOINTMENT IN WINDOW → SAY SO PLAINLY, NO CARD. When no upcoming appointment
 *     falls inside the window the mode says so in one neutral sentence and emits no
 *     card (mirrors log-retrieval's no-match path).
 *
 * Everything is injectable (store repos + the LLM provider + a clock + the window) so
 * the whole surface — in-window detection, question generation, zero-key fallback,
 * card shape, no-match — is unit-testable with an in-memory store, a fake LLM, and zero
 * network.
 */

/** This runner's mode tag. Briefings are part of the `prep` mode family. */
const PREP_MODE: Mode = 'prep';

/** Default look-ahead window (hours) when none is supplied. Mirrors config default. */
export const DEFAULT_PREP_WINDOW_HOURS = 48;

/** How many suggested questions to include in a briefing (kept short for voice + card). */
export const MAX_BRIEFING_QUESTIONS = 3;

/** One hour in milliseconds. */
const HOUR_MS = 3_600_000;

/** Dependencies for the prep-briefing runner (DI style, mirroring the sibling modes). */
export interface PrepDeps {
  /** Store repositories — upcoming appointments are read from here. */
  repos: Repositories;
  /** The patient whose upcoming appointments frame the briefing. */
  patientId: string;
  /**
   * The resolved LLM provider used to generate suggested questions. When
   * `provider.live === false` (canned/zero-key) the runner falls back to a
   * deterministic question set rather than relying on model output.
   */
  llm: LlmProvider;
  /**
   * Look-ahead window (hours) before an appointment within which a briefing is offered
   * (R12.2). Defaults to {@link DEFAULT_PREP_WINDOW_HOURS}; the composition root passes
   * `config.prepWindowHours`.
   */
  windowHours?: number;
  /** Clock for resolving "now" against appointment times. Defaults to now. */
  now?: () => Date;
  /** Optional timeout/timer knobs forwarded to {@link runMode}. Injectable for tests. */
  runOptions?: LlmRunOptions;
}

/** An upcoming appointment placed on the clock, with the resolved briefing questions. */
export interface AppointmentBriefing {
  appointment: Appointment;
  /** The resolved absolute time of the appointment (ms) — always in-window here. */
  atMs: number;
  /** The bounded "what to ask" list (generated or fallback), plain non-clinical prompts. */
  questions: string[];
}

/**
 * Run the prep-briefing mode end-to-end and return the contract-valid output. When an
 * upcoming appointment falls inside the window, offers a spoken briefing (purpose /
 * what to report / suggested questions) and emits ONE card for the nearest such
 * appointment (name, date, "what to ask" list). Otherwise says so plainly with no
 * card. This is the testable core; {@link createPrepRunner} wraps it as a
 * {@link ModeRunner}.
 *
 * @param deps - injectable store repos, patient id, LLM, window, clock, run options.
 */
export async function runPrep(deps: PrepDeps): Promise<ModeOutput> {
  const { repos, patientId, llm, runOptions } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const windowHours = deps.windowHours ?? DEFAULT_PREP_WINDOW_HOURS;

  // Deterministic, LLM-free selection: upcoming appointments whose `at` parses to a
  // concrete time inside (now, now + window]. Nearest first.
  const inWindow = selectInWindow(repos.appointment.listUpcoming(patientId), now, windowHours);

  // No appointment in window → say so plainly, no card (R12.2).
  if (inWindow.length === 0) {
    return modeOutputSchema.parse({
      say: buildNoUpcomingSay(windowHours),
      cards: [],
      memory_ops: [],
      flags: ['none'],
    });
  }

  // Offer a briefing for the NEAREST in-window appointment. Its "what to ask" list is
  // generated with a live LLM, else the deterministic fallback (every provider degrades).
  const nearest = inWindow[0]!;
  const questions = await suggestQuestions(nearest.appointment, llm, runOptions);
  const briefing: AppointmentBriefing = {
    appointment: nearest.appointment,
    atMs: nearest.atMs,
    questions,
  };

  const say = buildBriefingSay(briefing);
  const cards: Card[] = [buildBriefingCard(briefing)];

  return modeOutputSchema.parse({ say, cards, memory_ops: [], flags: ['none'] });
}

/**
 * Create the prep-briefing {@link ModeRunner} (Task 29). `run()` ignores the user text
 * (the briefing is driven by the appointment window, not the utterance) and returns the
 * contract-valid {@link ModeOutput}: a spoken briefing + one card for the nearest
 * in-window appointment, or a plain "nothing coming up" line.
 *
 * @param deps - injectable store repos, patient id, LLM, window, clock, run options.
 */
export function createPrepRunner(deps: PrepDeps): ModeRunner {
  return {
    mode: PREP_MODE,
    async run(_userText: string): Promise<ModeOutput> {
      return runPrep(deps);
    },
  };
}

// ---------------------------------------------------------------------------
// In-window selection (deterministic; no LLM).
// ---------------------------------------------------------------------------

/** An upcoming appointment resolved to a concrete in-window clock time. */
interface WindowedAppointment {
  appointment: Appointment;
  atMs: number;
}

/**
 * Select the upcoming appointments whose `at` parses to a concrete time inside the
 * window `(now, now + windowHours]`, NEAREST FIRST (R12.2). Appointments whose `at`
 * cannot be placed on a clock (free-text with no resolvable date) are skipped — a
 * briefing is only offered against a time we can verify. Pure and exported for testing.
 */
export function selectInWindow(
  appointments: Appointment[],
  now: Date,
  windowHours: number,
): WindowedAppointment[] {
  const nowMs = now.getTime();
  const untilMs = nowMs + Math.max(0, windowHours) * HOUR_MS;

  const windowed: WindowedAppointment[] = [];
  for (const appointment of appointments) {
    const atMs = parseAppointmentAt(appointment.at);
    if (atMs === null) continue; // unparseable time → not windowable
    // Strictly after now (a past-due time is not "upcoming within the window") and at
    // or before the window edge.
    if (atMs > nowMs && atMs <= untilMs) {
      windowed.push({ appointment, atMs });
    }
  }
  windowed.sort((a, b) => a.atMs - b.atMs);
  return windowed;
}

/**
 * Parse an appointment's `at` phrasing into an absolute epoch-ms time, or null when it
 * is not a resolvable date/time. Accepts anything `Date.parse` understands (ISO
 * timestamps, `YYYY-MM-DD`, common date strings) — the appointment-creation path may
 * store either a resolved ISO time or the caregiver's own words; only the former can be
 * windowed. Exported for testing.
 */
export function parseAppointmentAt(at: string): number | null {
  const trimmed = at.trim();
  if (trimmed.length === 0) return null;
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

// ---------------------------------------------------------------------------
// Suggested questions — generated with a live LLM, deterministic fallback otherwise.
// ---------------------------------------------------------------------------

/**
 * System prompt for the "what to ask" generator (R12.2). Small and routed: it produces
 * ONLY a short list of plain, non-clinical questions the caregiver can ASK the care
 * team at the appointment. It is explicitly forbidden from giving medical advice,
 * dosing, prognosis, or triage — those are the safety guardrail's domain and never the
 * caregiver's questions to answer themselves.
 */
export const PREP_SYSTEM =
  'You are the appointment-prep helper for Turtle, a caregiver voice companion. Given ' +
  'one upcoming appointment, produce a SHORT list of plain-language questions the ' +
  'caregiver could ASK the care team at that visit.\n' +
  'Strict rules:\n' +
  `- At most ${MAX_BRIEFING_QUESTIONS} questions. Keep each short and spoken-friendly.\n` +
  '- These are questions to ASK a clinician — never medical advice, dosing, prognosis, ' +
  'or triage, and never anything you answer yourself.\n' +
  '- Base them on the appointment purpose and who it is with; stay general and neutral.\n' +
  'Reply ONLY with a JSON array of question strings, e.g. ' +
  '["What are the next steps after this visit?", "Are there side effects to watch for?"] ' +
  'and NOTHING else.';

/**
 * Resolve the "what to ask" list for an appointment. With a LIVE LLM it runs the
 * generator prompt and parses the JSON array; with a non-live provider (or on any
 * parse/model failure) it falls back to the deterministic {@link fallbackQuestions} so
 * a briefing is always produced (zero-key degradation). Bounded to
 * {@link MAX_BRIEFING_QUESTIONS}. Exported for testing.
 */
export async function suggestQuestions(
  appointment: Appointment,
  llm: LlmProvider,
  runOptions?: LlmRunOptions,
): Promise<string[]> {
  // Zero-key degradation: a non-live provider only echoes, which is not a usable
  // question list. Use the deterministic fallback instead.
  if (!llm.live) return fallbackQuestions(appointment);

  const messages: LlmMessage[] = [
    { role: 'system', content: PREP_SYSTEM },
    { role: 'user', content: describeAppointmentForPrompt(appointment) },
  ];

  // runMode returns a ModeOutput; the generator is asked for a bare JSON array, so the
  // array is carried in `say`. Parse it, else fall back deterministically.
  const raw = await runMode(llm, messages, runOptions);
  const parsed = parseQuestionList(raw.say);
  const questions = parsed && parsed.length > 0 ? parsed : fallbackQuestions(appointment);
  return questions.slice(0, MAX_BRIEFING_QUESTIONS);
}

/** Compact one-line description of the appointment for the generator prompt. */
function describeAppointmentForPrompt(appointment: Appointment): string {
  const parts = [`Appointment: ${appointment.title}`];
  if (appointment.with_whom) parts.push(`With: ${appointment.with_whom}`);
  parts.push(`When: ${appointment.at}`);
  if (appointment.purpose) parts.push(`Purpose: ${appointment.purpose}`);
  return parts.join('\n');
}

/**
 * Parse the generator's `say` text as a JSON array of question strings. Tolerates
 * surrounding prose/fences by extracting the first `[...]` block. Returns null when no
 * usable array of non-empty strings is found (the caller then falls back). Exported for
 * direct testing.
 */
export function parseQuestionList(raw: string): string[] | null {
  const arr = extractJsonArray(raw);
  if (arr === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(arr);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const questions = parsed
    .filter((q): q is string => typeof q === 'string')
    .map((q) => q.trim())
    .filter((q) => q.length > 0);
  return questions.length > 0 ? questions : null;
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

/**
 * The deterministic "what to ask" list used with a non-live provider or when the model
 * produced nothing usable (R16.4 spirit). Neutral, non-clinical questions a caregiver
 * can ASK the care team — general enough to fit any visit, tailored only by whether a
 * purpose was recorded. Never advice, dosing, prognosis, or triage. Exported for testing.
 */
export function fallbackQuestions(appointment: Appointment): string[] {
  const purpose = appointment.purpose?.trim();
  const questions = [
    purpose && purpose.length > 0
      ? `What should we expect from this ${purpose}?`
      : 'What is the goal of this visit?',
    'What changes should I watch for and report back?',
    'Who should I contact if something comes up before the next visit?',
  ];
  return questions.slice(0, MAX_BRIEFING_QUESTIONS);
}

// ---------------------------------------------------------------------------
// Say + card composition (briefing; no interpretation) — built in code.
// ---------------------------------------------------------------------------

/**
 * Build the plain "nothing coming up" answer (R12.2). One neutral sentence, no card,
 * naming the window so it is concrete. Exported for direct testing.
 */
export function buildNoUpcomingSay(windowHours: number): string {
  return `You don't have any appointments coming up in the next ${describeWindow(windowHours)}.`;
}

/**
 * Build the spoken prep briefing (R12.2): purpose, what to report, and an invitation to
 * the suggested questions. Composed IN CODE from the appointment fields + the bounded
 * question list — a neutral offer to prepare, never advice or interpretation. Exported
 * for direct testing.
 */
export function buildBriefingSay(briefing: AppointmentBriefing): string {
  const { appointment, questions } = briefing;
  const label = trimText(appointment.title);
  const withPart = appointment.with_whom ? ` with ${trimText(appointment.with_whom)}` : '';
  const when = trimText(appointment.at);

  const lead = `You have ${label}${withPart} coming up (${when}). Let's get you ready.`;

  const purpose = appointment.purpose?.trim();
  const purposeLine = purpose && purpose.length > 0 ? ` The purpose is ${trimText(purpose)}.` : '';

  // "What to report" is a neutral prompt to bring the caregiver's own observations —
  // it points back to what they've logged/noticed, never a clinical checklist.
  const reportLine = ' It helps to jot down anything you have noticed since the last visit.';

  const questionsLine =
    questions.length > 0
      ? ` A few things you could ask: ${joinList(questions.map(trimText))}.`
      : '';

  return `${lead}${purposeLine}${reportLine}${questionsLine}`;
}

/**
 * Build ONE briefing card for a single appointment (R12.3): title = the appointment
 * name, body = the date and a "what to ask" list (≤3 lines / the contract's 280-char
 * cap). Retained (a briefing is kept, not acted on) with no action and no
 * interpretation. Exported and per-appointment so callers/tests can build a card for
 * any appointment and the "one card per appointment" invariant is explicit.
 */
export function buildBriefingCard(briefing: AppointmentBriefing): Card {
  const { appointment, questions } = briefing;
  const lines: string[] = [`When: ${trimText(appointment.at)}`];
  if (questions.length > 0) {
    lines.push('What to ask:');
    for (const q of questions) lines.push(`• ${trimText(q)}`);
  }
  return {
    type: 'retained',
    title: `Prep: ${trimText(appointment.title)}`,
    body: truncate(lines.join('\n'), 280),
  };
}

/** Human window phrasing: "48 hours", "1 hour", "2 days". */
function describeWindow(windowHours: number): string {
  const hours = Math.max(0, Math.round(windowHours));
  if (hours % 24 === 0 && hours >= 24) {
    const days = hours / 24;
    return `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/** Trim text and drop trailing sentence punctuation so fields compose cleanly. */
function trimText(text: string): string {
  return text.trim().replace(/[.!?]+$/, '');
}

/**
 * Join a list of phrases with commas and a trailing "and", Oxford-style for 3+.
 * ["a"] → "a"; ["a","b"] → "a, and b"; ["a","b","c"] → "a, b, and c".
 */
function joinList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]}, and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** Truncate to at most `max` chars, adding an ellipsis when clipped. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
