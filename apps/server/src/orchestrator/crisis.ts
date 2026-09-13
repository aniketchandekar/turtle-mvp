import {
  CRISIS_RESOURCES,
  modeOutputSchema,
  type CardAction,
  type CareTeam,
  type ModeOutput,
} from '@turtle/shared';
import { pickCareTeamContact, toTelTarget, type ResolvedContact } from './guardrail.js';

/**
 * Crisis protocol composer — the crisis-flag handler (Task 31, R13.1–R13.5 / R5.5).
 *
 * When the safety classifier (Task 16) flags a turn as `crisis` — suicidal ideation,
 * self-harm, abuse — the turn BYPASSES normal mode routing and lands here. Per the
 * binding safety guardrails, the crisis protocol:
 *
 *   1. Respond gently and validate; do NOT continue normal conversation (R13.1).
 *   2. Speak the crisis resources (988 Suicide & Crisis Lifeline) and encourage
 *      contacting the care team or a trusted person (R13.2).
 *   3. Emit a `safety` card with the same resources, so they are BOTH spoken AND
 *      shown (R13.3 / R13.5).
 *   4. Flag the transcript for owner review via the `crisis` flag (R13.4 / R5.5).
 *
 * DESIGN NOTE — why this is deterministic, not an LLM prompt.
 * design.md lists the crisis protocol as a small routed step, but the safety
 * guardrails make the crisis content a hard invariant that must be enforced "in code,
 * not just in prompts": the 988 resources are always spoken, always carded, and the
 * turn is always flagged. A response a model could soften, drop the resources from, or
 * render card-only/spoken-only would be a safety failure. So the composer is pure and
 * deterministic and always produces the full protocol. The crisis line itself is one
 * of the pre-rendered static strings (design.md §TTS): the gateway can render
 * {@link CRISIS_RESOURCES.spoken} via HTTP streaming for sub-100ms availability, but
 * the composer guarantees the matching safety card is ALWAYS emitted alongside it. The
 * output still conforms to the response contract (ModeOutput) so it flows through the
 * same validate-before-speaking gate (Task 15) as every other turn.
 *
 * THE SPOKEN-AND-SHOWN RULE (enforced here, in code).
 * Crisis resources are ALWAYS both spoken (`say`) AND shown (a `safety` card). Never
 * card-only, never spoken-only. {@link composeCrisisResponse} guarantees a non-empty
 * crisis `say` and exactly one safety card in the same output;
 * {@link assertCrisisSpokenAndShown} is the belt-and-suspenders check the caller runs,
 * and {@link enforceCrisisSpokenAndShown} repairs a malformed crisis output back to the
 * canonical protocol rather than ever letting it degrade to one channel.
 */

/** The tel: target for the 988 lifeline (call or text). */
const LIFELINE_TEL = `tel:${CRISIS_RESOURCES.lifeline_number}`;

/**
 * Build the safety-card body. When a care-team contact is known it is named as an
 * additional person to reach, reinforcing the "contact the care team or a trusted
 * person" encouragement (R13.2). The 988 line is always present regardless.
 */
function composeCardBody(contact: ResolvedContact | null): string {
  if (!contact) return CRISIS_RESOURCES.card_body;
  const label = contact.label.charAt(0).toUpperCase() + contact.label.slice(1);
  return `Call or text 988, any time. You can also reach ${label} at ${contact.contact}, or a trusted person.`;
}

/**
 * The safety card's action. The 988 lifeline is always dialable, so the card carries a
 * `call` action targeting `tel:988` — a caregiver in distress gets one tap to the
 * lifeline. (We intentionally point the action at 988 rather than the care-team contact
 * so the primary, always-available crisis resource is one tap away; the care-team
 * contact is named in the body.)
 */
function crisisCardAction(): CardAction {
  return { kind: 'call', target: LIFELINE_TEL };
}

/**
 * Compose a complete crisis-protocol `ModeOutput` from the patient's care team.
 *
 * Guarantees (safety invariants, enforced here):
 *   - `say` is the gentle, validating crisis line naming the 988 lifeline and
 *     encouraging contacting the care team / a trusted person (R13.1 / R13.2).
 *   - exactly ONE `safety` card carries the same 988 resources, dialable via a `call`
 *     action to `tel:988` (R13.3).
 *   - `flags` is `['crisis']`, so the turn is marked for owner review when persisted
 *     (R13.4 / R5.5; persistTurn maps the first non-none flag onto the turn row).
 *   - spoken AND shown: both `say` and the safety card are present in the same output
 *     (R13.5) — never card-only, never spoken-only.
 *   - NO memory ops and NO mode routing: the crisis protocol does not continue normal
 *     conversation (R13.1).
 *
 * The result is validated against `modeOutputSchema` before return so a malformed
 * crisis response can never leave this function.
 *
 * @param careTeam - the patient profile's care team (may be null/empty). Used only to
 *                   name an additional human contact in the card body; the 988
 *                   resource is always present regardless.
 */
export function composeCrisisResponse(careTeam?: CareTeam | null): ModeOutput {
  const contact = pickCareTeamContact(careTeam);
  const output: ModeOutput = {
    say: CRISIS_RESOURCES.spoken,
    cards: [
      {
        type: 'safety',
        title: CRISIS_RESOURCES.card_title,
        body: composeCardBody(contact),
        action: crisisCardAction(),
      },
    ],
    memory_ops: [],
    flags: ['crisis'],
  };
  // Validate before speaking: a crisis response that fails the contract must never ship.
  return modeOutputSchema.parse(output);
}

/**
 * Assert the spoken-AND-shown invariant on a crisis output: it must speak (non-empty
 * `say`), it must show exactly one `safety` card, and it must carry the `crisis` flag.
 * Throws when any leg is missing so the caller fails loudly rather than shipping a
 * card-only or spoken-only crisis response.
 *
 * This is the code-level enforcement the safety guardrails require ("enforce this in
 * code, not just in prompts"). Mirrors {@link assertSpokenAndShown} for medical refusals.
 */
export function assertCrisisSpokenAndShown(output: ModeOutput): void {
  if (!output.say || output.say.trim().length === 0) {
    throw new Error('crisis response must be spoken: `say` is empty');
  }
  const safetyCard = output.cards.find((c) => c.type === 'safety');
  if (!safetyCard) {
    throw new Error('crisis response must be shown: no safety card present');
  }
  // The safety card must actually carry the crisis resource, not an empty shell.
  if (!safetyCard.body || safetyCard.body.trim().length === 0) {
    throw new Error('crisis response safety card must carry the crisis resources');
  }
  if (!output.flags.includes('crisis')) {
    throw new Error('crisis response must be flagged crisis for owner review');
  }
}

/**
 * Enforce the spoken-AND-shown invariant, repairing rather than throwing. Given any
 * candidate crisis output (e.g. one an upstream step might have shaped), return it
 * unchanged when it already satisfies {@link assertCrisisSpokenAndShown}; otherwise
 * fall back to the canonical {@link composeCrisisResponse}. This guarantees a crisis
 * turn NEVER degrades to card-only or spoken-only — the worst case is the full,
 * correct protocol. `careTeam` is used to rebuild the canonical output when repairing.
 */
export function enforceCrisisSpokenAndShown(
  output: ModeOutput,
  careTeam?: CareTeam | null,
): ModeOutput {
  try {
    assertCrisisSpokenAndShown(output);
    return output;
  } catch {
    return composeCrisisResponse(careTeam);
  }
}
