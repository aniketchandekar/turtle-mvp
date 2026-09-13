import {
  MEDICAL_REFUSAL,
  modeOutputSchema,
  type CardAction,
  type CareTeam,
  type ModeOutput,
} from '@turtle/shared';

/**
 * Medical guardrail refusal composer — `guardrail.refusal` (Task 17, R5.3–R5.5).
 *
 * When the safety classifier (Task 16) flags a turn as `medical` — medication
 * selection, dosing, timing, interactions, prognosis, symptom triage — the turn
 * BYPASSES normal mode routing and lands here. Per the binding safety guardrails,
 * the refusal is composed to a frozen template:
 *
 *   acknowledge → state the limit plainly → offer the care-team contact → emit an
 *   actionable card with that contact.
 *
 * Warm but absolute. Never hedge into a partial answer, never estimate, never reason
 * about the clinical question.
 *
 * DESIGN NOTE — why this is deterministic, not an LLM prompt.
 * design.md lists `guardrail.refusal` as one of the small routed prompts, but the
 * safety guardrails make this content a hard invariant that must be enforced "in
 * code, not just in prompts." A refusal that a model could soften, partially answer,
 * or drop the contact from would be a safety failure. So the composer is pure and
 * deterministic: it always refuses, always states the limit, and always attaches the
 * care-team contact from the profile. The output still conforms to the response
 * contract (ModeOutput) so it flows through the same validate-before-speaking gate
 * (Task 15) as every other turn.
 *
 * THE SPOKEN-AND-SHOWN RULE (enforced here, in code).
 * A medical refusal is ALWAYS both spoken (`say`) AND shown (an actionable `card`).
 * Never card-only, never spoken-only. {@link composeMedicalRefusal} guarantees a
 * non-empty `say` and exactly one actionable card in the same output;
 * {@link assertSpokenAndShown} is the belt-and-suspenders check the caller can run.
 */

/** Priority order for choosing which care-team contact to redirect to. */
const CONTACT_PRIORITY: Array<{
  key: keyof Pick<CareTeam, 'nurse_line' | 'oncologist' | 'social_worker'>;
  label: string;
}> = [
  { key: 'nurse_line', label: 'nurse line' },
  { key: 'oncologist', label: 'oncologist' },
  { key: 'social_worker', label: 'social worker' },
];

/** A resolved care-team contact to redirect the caregiver to. */
export interface ResolvedContact {
  /** Human label for the contact (e.g. "nurse line", "oncologist"). */
  label: string;
  /** The raw contact string from the profile (phone number, name, etc.). */
  contact: string;
}

/**
 * Pick the most appropriate care-team contact from the patient profile, or `null`
 * when the profile has no usable contact. Preference order: nurse line → oncologist
 * → social worker → first `other[]` entry. The nurse line is first because it is the
 * caregiver's normal clinical point of contact for exactly these questions.
 */
export function pickCareTeamContact(careTeam: CareTeam | null | undefined): ResolvedContact | null {
  if (!careTeam) return null;
  for (const { key, label } of CONTACT_PRIORITY) {
    const value = careTeam[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return { label, contact: value.trim() };
    }
  }
  const other = careTeam.other?.find((o) => o.contact.trim().length > 0);
  if (other) return { label: other.label.trim() || 'care team', contact: other.contact.trim() };
  return null;
}

/**
 * Build a card action from a resolved contact. A phone-like contact becomes a
 * tappable `call` action with a `tel:` target (design.md example:
 * `action.kind = "call", target = "tel:..."`); a non-phone contact (e.g. a name)
 * becomes an `acknowledge` action so the card is still actionable without inventing
 * a dialable number.
 */
export function contactToAction(contact: ResolvedContact | null): CardAction {
  if (!contact) return { kind: 'acknowledge' };
  const tel = toTelTarget(contact.contact);
  return tel ? { kind: 'call', target: tel } : { kind: 'acknowledge' };
}

/** Digits that make up a dialable number (with an optional leading +). */
const PHONE_RE = /^\+?[0-9][0-9\s().-]{4,}$/;

/**
 * Convert a phone-like contact string into a `tel:` URI, or `null` when the string
 * is not a phone number (e.g. a person's name). Strips spaces and punctuation,
 * preserving a leading `+` for international numbers.
 */
export function toTelTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (!PHONE_RE.test(trimmed)) return null;
  const plus = trimmed.startsWith('+') ? '+' : '';
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length < 3) return null;
  return `tel:${plus}${digits}`;
}

/**
 * Compose the spoken refusal line: acknowledge → limit → redirect. The redirect names
 * the concrete contact when one is known, else redirects to the care team generally.
 * Always warm, always absolute, never a partial answer.
 */
export function composeRefusalSay(contact: ResolvedContact | null): string {
  const { acknowledge, limit, redirectWithContact, redirectNoContact } = MEDICAL_REFUSAL;
  if (!contact) return `${acknowledge} ${limit} ${redirectNoContact}`;
  const who =
    toTelTarget(contact.contact) !== null
      ? `${redirectWithContact} — try the ${contact.label} at ${contact.contact}.`
      : `${redirectWithContact} — reach out to ${contact.contact}.`;
  return `${acknowledge} ${limit} ${who}`;
}

/** Build the card body, naming the specific contact when one is known. */
function composeCardBody(contact: ResolvedContact | null): string {
  if (!contact) return MEDICAL_REFUSAL.card_body;
  const label = contact.label.charAt(0).toUpperCase() + contact.label.slice(1);
  return `This is a question for a clinician. ${label}: ${contact.contact}.`;
}

/**
 * Compose a complete medical-refusal `ModeOutput` from the patient's care team.
 *
 * Guarantees (safety invariants, enforced here):
 *   - `say` is non-empty and follows acknowledge → limit → redirect (R5.3).
 *   - exactly ONE `actionable` card carries the care-team contact (R5.4).
 *   - `flags` is `['medical_refusal']`, so the turn is marked for owner review when
 *     persisted (R5.5; persistTurn maps the first non-none flag onto the turn row).
 *   - spoken AND shown: both `say` and the card are present in the same output.
 *
 * The result is validated against `modeOutputSchema` before return so a malformed
 * refusal can never leave this function.
 *
 * @param careTeam - the patient profile's care team (may be null/empty).
 */
export function composeMedicalRefusal(careTeam: CareTeam | null | undefined): ModeOutput {
  const contact = pickCareTeamContact(careTeam);
  const output: ModeOutput = {
    say: composeRefusalSay(contact),
    cards: [
      {
        type: 'actionable',
        title: MEDICAL_REFUSAL.card_title,
        body: composeCardBody(contact),
        action: contactToAction(contact),
      },
    ],
    memory_ops: [],
    flags: ['medical_refusal'],
  };
  // Validate before speaking: a refusal that fails the contract must never ship.
  return modeOutputSchema.parse(output);
}

/**
 * Assert the spoken-AND-shown invariant on a medical-refusal output: it must speak
 * (non-empty `say`), it must show exactly one actionable card, and it must carry the
 * `medical_refusal` flag. Throws when any leg is missing so the caller fails loudly
 * rather than shipping a card-only or spoken-only refusal.
 *
 * This is the code-level enforcement the safety guardrails require ("enforce this in
 * code, not just in prompts").
 */
export function assertSpokenAndShown(output: ModeOutput): void {
  if (!output.say || output.say.trim().length === 0) {
    throw new Error('medical refusal must be spoken: `say` is empty');
  }
  const hasActionableCard = output.cards.some((c) => c.type === 'actionable');
  if (!hasActionableCard) {
    throw new Error('medical refusal must be shown: no actionable card present');
  }
  if (!output.flags.includes('medical_refusal')) {
    throw new Error('medical refusal must be flagged medical_refusal for owner review');
  }
}
