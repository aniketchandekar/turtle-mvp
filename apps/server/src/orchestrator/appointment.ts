import { modeOutputSchema, type Card, type MemoryOp, type ModeOutput } from '@turtle/shared';
import type { LlmMessage, LlmProvider, LlmRunOptions } from '../services/llm/index.js';
import { runMode } from '../services/llm/index.js';
import type { Mode, ModeRunner } from './index.js';

/**
 * Appointment-creation mode — the ADD-by-voice path (Task 28, R12.1).
 *
 * One of the small routed prompts (design.md §Orchestrator). It owns exactly one
 * thing: turning a dictated caregiver utterance ("Add an appointment with Dr. Lee on
 * Tuesday at 2pm for a follow-up", "Schedule oncology next Friday") into a single
 * STRUCTURED appointment, confirming with PASSIVE phrasing, and creating a retained
 * card. It is the direct analog of the care-log extraction mode (`log.prompt`, Task
 * 26): utterance → structured record → memory op → passive confirmation + retained
 * card, all validated through the response contract.
 *
 * It does NOTHING else. It does NOT retrieve appointments or build prep briefings —
 * that is the `prep` mode's job (Tasks 29/30). "Log, never interpret" (product.md /
 * safety.md) applies in spirit here too: the spoken confirmation reports WHAT was
 * added, never advises or triages.
 *
 * The turn flow (mirrors design.md §log.prompt; R12.1):
 *
 *   1. EXTRACT. The utterance is parsed into one appointment: a `title` (what it is),
 *      an `at` (when — kept as the caregiver's own phrasing, e.g. "Tuesday at 2pm",
 *      since natural-language date resolution is out of scope for the MVP add path),
 *      and optionally `with_whom` (a clinician) and `purpose`. With a LIVE LLM this is
 *      the routed extraction prompt (extraction only, no interpretation). With a
 *      NON-LIVE provider (zero-key) the model only echoes, so the runner falls back to
 *      a deterministic single-field extraction (title = the verbatim utterance) so the
 *      appointment is still recorded with no keys (R16.4 spirit) — exactly the shape of
 *      {@link fallbackAppointment}, mirroring log.ts's `fallbackEntry`.
 *   2. EMIT A MEMORY OP. The extracted appointment becomes one `add_appointment` memory
 *      op. The contract-validator's write path (Task 15) persists it to the
 *      `appointment` store via `repos.appointment.create` — appointments flow ONLY from
 *      the validated contract (spine invariant), exactly like `append_log`.
 *   3. CONFIRM PASSIVELY. The spoken `say` is a passive confirmation composed IN CODE
 *      from the extracted appointment ("Added — appointment with Dr. Lee, Tuesday at
 *      2pm."), never trusting the model to phrase it. See {@link buildConfirmation}.
 *   4. CREATE AN APPOINTMENT CARD. A single RETAINED card summarizes what was added —
 *      title, when, with whom (≤3 lines, no action). Built in code. See
 *      {@link buildAppointmentCard}.
 *   5. STRIP INTERPRETATION. As a code-level guarantee, the model's raw prose is never
 *      spoken; the say/card are composed from the neutral extracted fields, and the
 *      turn is always `none` (no advice/triage/flags leak through).
 *
 * The output always conforms to the response contract (validated before return), so it
 * flows through the same validate-before-speaking gate (Task 15) as every other mode.
 *
 * As with the sibling modes, the LLM provider and run options are injectable, so the
 * whole surface — extract / confirm / card / zero-key fallback — is unit-testable with
 * fakes and zero network.
 */

/**
 * This runner's mode tag. Appointment CREATION is part of the `prep` mode family (the
 * mode router routes appointment turns to `prep`); the orchestrator selects the
 * creation runner vs. the retrieval/briefing runner via
 * {@link import('./mode-router.js').isAppointmentCreation}, mirroring how
 * {@link import('./mode-router.js').isLogRetrievalQuery} splits the `log` family.
 */
const APPOINTMENT_MODE: Mode = 'prep';

/** A single structured appointment extracted from the utterance (R12.1). */
export interface AppointmentExtraction {
  /** What the appointment is — the required, always-present field. */
  title: string;
  /** When it is, kept as the caregiver's own phrasing ("Tuesday at 2pm"). */
  at: string;
  /** Who it is with (a clinician), when the caregiver named one. */
  with_whom?: string;
  /** The purpose/reason, when the caregiver gave one. */
  purpose?: string;
}

/**
 * Extraction-only system prompt (R12.1). Small and routed: it does EXACTLY one thing —
 * pull the appointment fields out of the utterance — and is explicitly forbidden from
 * interpreting, advising, or triaging. The model returns a bare JSON object; the
 * passive confirmation and the card are composed in code from that object, never from
 * model prose.
 */
export const APPOINTMENT_SYSTEM =
  'You are the appointment extractor for Turtle, a caregiver voice companion. The ' +
  'caregiver has dictated an appointment to add. Your ONLY job is to extract it into a ' +
  'structured record.\n' +
  'Strict rules:\n' +
  '- Extract these fields:\n' +
  '  - title: a short label for the appointment (e.g. "Oncology", "Follow-up", ' +
  '"Bloodwork"). REQUIRED.\n' +
  '  - at: WHEN it is, exactly as the caregiver said it (e.g. "Tuesday at 2pm", "next ' +
  '  Friday"). Do NOT convert to a calendar date. REQUIRED.\n' +
  '  - with_whom: the clinician/person it is with, if named (e.g. "Dr. Lee"). Omit if ' +
  '  not mentioned.\n' +
  '  - purpose: the reason, if given (e.g. "follow-up", "scan review"). Omit if not ' +
  '  mentioned.\n' +
  '- Use the caregiver\'s own words. Do NOT interpret, advise, or add anything.\n' +
  'Reply ONLY with a JSON object of the form ' +
  '{"title": "<title>", "at": "<when>", "with_whom": "<who?>", "purpose": "<why?>"} and ' +
  'NOTHING else. Omit with_whom / purpose entirely when not mentioned.';

/** Dependencies for the appointment runner (DI style, mirroring the sibling modes). */
export interface AppointmentDeps {
  /**
   * The resolved LLM provider. When `provider.live === false` (canned/zero-key) the
   * runner falls back to a deterministic single-field extraction rather than relying
   * on model output — the appointment is still recorded with zero keys.
   */
  llm: LlmProvider;
  /** Optional timeout/timer knobs forwarded to {@link runMode}. Injectable for tests. */
  runOptions?: LlmRunOptions;
}

/**
 * Run the appointment-creation mode end-to-end and return the contract-valid output
 * (passive confirmation + one add_appointment op + a retained card). This is the
 * testable core; {@link createAppointmentRunner} wraps it as a {@link ModeRunner}.
 *
 * @param userText - the caregiver's dictated appointment utterance.
 * @param deps     - injectable LLM + run options.
 */
export async function runAppointment(userText: string, deps: AppointmentDeps): Promise<ModeOutput> {
  const { llm, runOptions } = deps;

  const appointment = await extractAppointment(userText, llm, runOptions);

  // (R12.1) One add_appointment op — appointments flow only from the contract. Optional
  // fields are omitted (not set to null) so the op stays minimal and schema-clean.
  const op: MemoryOp = {
    op: 'add_appointment',
    title: appointment.title,
    at: appointment.at,
    ...(appointment.with_whom ? { with_whom: appointment.with_whom } : {}),
    ...(appointment.purpose ? { purpose: appointment.purpose } : {}),
  };

  // Passive confirmation + a single retained card, both composed in code from the
  // neutral extracted fields (no interpretation ever reaches say/card).
  const say = buildConfirmation(appointment);
  const cards: Card[] = [buildAppointmentCard(appointment)];

  return modeOutputSchema.parse({ say, cards, memory_ops: [op], flags: ['none'] });
}

/**
 * Create the appointment-creation {@link ModeRunner} (Task 28). `run(userText)` returns
 * the contract-valid {@link ModeOutput}: a passive confirmation, one `add_appointment`
 * op, and a single retained appointment card.
 *
 * @param deps - injectable LLM + run options.
 */
export function createAppointmentRunner(deps: AppointmentDeps): ModeRunner {
  return {
    mode: APPOINTMENT_MODE,
    async run(userText: string): Promise<ModeOutput> {
      return runAppointment(userText, deps);
    },
  };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extract a structured appointment from the utterance. With a LIVE LLM this runs the
 * extraction-only prompt and parses the JSON object; with a non-live provider (or on
 * any parse/model failure) it falls back to a deterministic single-field extraction so
 * the appointment is still recorded (zero-key degradation, R16.4 spirit). Exported for
 * testing.
 */
export async function extractAppointment(
  userText: string,
  llm: LlmProvider,
  runOptions?: LlmRunOptions,
): Promise<AppointmentExtraction> {
  // Zero-key degradation: a non-live provider only echoes, which is not a usable
  // extraction. Record the utterance verbatim as the title instead.
  if (!llm.live) return fallbackAppointment(userText);

  const messages: LlmMessage[] = [
    { role: 'system', content: APPOINTMENT_SYSTEM },
    { role: 'user', content: userText },
  ];

  // The extraction prompt asks for a bare JSON object, but runMode returns a ModeOutput
  // (say/cards/memory_ops/flags) and parks the turn safely on timeout/error. The model
  // may answer with an add_appointment memory op directly (JSON-contract habit) or with
  // the JSON object in `say`; we normalize whichever we get into AppointmentExtraction.
  const raw = await runMode(llm, messages, runOptions);

  const fromOps = appointmentFromMemoryOps(raw.memory_ops);
  if (fromOps) return fromOps;

  const fromSay = parseAppointmentJson(raw.say);
  if (fromSay) return fromSay;

  // The model produced nothing structured we can trust → deterministic fallback.
  return fallbackAppointment(userText);
}

/**
 * Pull an appointment out of any `add_appointment` memory op the model happened to
 * emit. Some providers, given the JSON-contract habit, answer with the op directly; we
 * accept the first one carrying a non-empty title + `at`.
 */
function appointmentFromMemoryOps(ops: MemoryOp[]): AppointmentExtraction | null {
  for (const op of ops) {
    if (op.op !== 'add_appointment') continue;
    const title = op.title.trim();
    const at = op.at.trim();
    if (title.length === 0 || at.length === 0) continue;
    return normalizeExtraction({ title, at, with_whom: op.with_whom, purpose: op.purpose });
  }
  return null;
}

/**
 * Parse the model's `say` text as the requested JSON object. Tolerates surrounding
 * prose/fences by extracting the first `{...}` block. Returns null when no usable
 * object (with a non-empty title + `at`) is found (the caller then falls back).
 * Exported for direct testing.
 */
export function parseAppointmentJson(raw: string): AppointmentExtraction | null {
  // The prompt asks for a single JSON OBJECT. If a top-level array opens before any
  // object (e.g. `[{...}]`), the model answered with the wrong shape — reject it and
  // let the caller fall back rather than silently lifting the first nested object.
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
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const at = typeof record.at === 'string' ? record.at.trim() : '';
  if (title.length === 0 || at.length === 0) return null;

  const with_whom = typeof record.with_whom === 'string' ? record.with_whom.trim() : '';
  const purpose = typeof record.purpose === 'string' ? record.purpose.trim() : '';
  return normalizeExtraction({
    title,
    at,
    with_whom: with_whom.length > 0 ? with_whom : undefined,
    purpose: purpose.length > 0 ? purpose : undefined,
  });
}

/** Normalize an extraction: trim fields and drop empty optionals so ops stay minimal. */
function normalizeExtraction(input: AppointmentExtraction): AppointmentExtraction {
  const with_whom = input.with_whom?.trim();
  const purpose = input.purpose?.trim();
  return {
    title: input.title.trim(),
    at: input.at.trim(),
    ...(with_whom && with_whom.length > 0 ? { with_whom } : {}),
    ...(purpose && purpose.length > 0 ? { purpose } : {}),
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
 * The deterministic fallback: the whole utterance recorded verbatim as the title, with
 * a neutral placeholder `at`. Used with a non-live provider or when the model produced
 * nothing structured, so a dictated appointment is never silently dropped (R12.1).
 * Empty input degrades to a neutral placeholder so both required fields are always
 * non-empty (the contract requires it). Exported for testing.
 */
export function fallbackAppointment(userText: string): AppointmentExtraction {
  const text = userText.trim();
  return {
    title: text.length > 0 ? text : 'Appointment',
    // No date resolution in the zero-key path — record the intent, leave the time
    // unspecified so the caregiver can confirm/edit it via the minimal form.
    at: 'unspecified time',
  };
}

// ---------------------------------------------------------------------------
// Passive confirmation + appointment card (R12.1) — composed in code, never prose.
// ---------------------------------------------------------------------------

/**
 * Build the passive spoken confirmation (R12.1). Deliberately neutral: it reports WHAT
 * was added ("Added — appointment with Dr. Lee, Tuesday at 2pm."), never what it means
 * or whether it matters. No adjectives, no advice. Exported for direct testing.
 */
export function buildConfirmation(appointment: AppointmentExtraction): string {
  const withPart = appointment.with_whom ? ` with ${appointment.with_whom.trim()}` : '';
  const when = trimText(appointment.at);
  const label = trimText(appointment.title);
  // Lead with a neutral "Added —"; name what and when so the confirmation is concrete.
  return `Added — ${label}${withPart}, ${when}.`;
}

/** Title for the retained appointment card (R12.1). */
export const APPOINTMENT_CARD_TITLE = 'Appointment added';

/**
 * Build the single RETAINED appointment card summarizing what was added (R12.1). Body
 * lists the appointment as neutral labeled lines (≤3 lines / the contract's 280-char
 * cap) — no action (an added appointment is kept, not acted on), no interpretation.
 * Exported for direct testing.
 */
export function buildAppointmentCard(appointment: AppointmentExtraction): Card {
  const lines: string[] = [`${trimText(appointment.title)} — ${trimText(appointment.at)}`];
  if (appointment.with_whom) lines.push(`With: ${trimText(appointment.with_whom)}`);
  if (appointment.purpose) lines.push(`Purpose: ${trimText(appointment.purpose)}`);
  return {
    type: 'retained',
    title: APPOINTMENT_CARD_TITLE,
    body: truncate(lines.join('\n'), 280),
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
