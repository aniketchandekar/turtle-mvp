import { z } from 'zod';

/**
 * The response contract is the spine of Turtle. Every assistant turn conforms to it.
 * The client renders ONLY `say` and `cards`. Cards, memory ops, and safety behavior
 * flow only from this contract — never inferred client-side.
 */

export const ASSISTANT_STATES = [
  'IDLE',
  'LISTENING',
  'THINKING',
  'SPEAKING',
  'WAITING',
  'CLOSING',
] as const;
export type AssistantState = (typeof ASSISTANT_STATES)[number];

export const CARD_TYPES = ['actionable', 'retained', 'safety'] as const;
export type CardType = (typeof CARD_TYPES)[number];

export const CARD_ACTION_KINDS = ['call', 'link', 'acknowledge', 'share'] as const;
export type CardActionKind = (typeof CARD_ACTION_KINDS)[number];

export const TURN_FLAGS = ['crisis', 'medical_refusal', 'none'] as const;
export type TurnFlag = (typeof TURN_FLAGS)[number];

export const LOG_CATEGORIES = [
  'medication_given',
  'symptom',
  'sleep',
  'food',
  'event',
  'note',
] as const;
export type LogCategory = (typeof LOG_CATEGORIES)[number];

export const cardActionSchema = z.object({
  kind: z.enum(CARD_ACTION_KINDS),
  target: z.string().optional(),
});
export type CardAction = z.infer<typeof cardActionSchema>;

/** A trusted external reference displayed inside Turtle's single active card. */
export const resourceLinkSchema = z.object({
  title: z.string().min(1).max(120),
  url: z.string().url(),
});
export type ResourceLink = z.infer<typeof resourceLinkSchema>;

export const cardSchema = z.object({
  // A mode/LLM never produces an id — the store assigns it on persist. The gateway
  // stamps the persisted id onto the card before forwarding the turn_contract, so the
  // client can reference the exact stored card in a `card_action` tap (voice parity,
  // R16.8). Optional so mode outputs and pre-persist contracts still validate.
  id: z.string().min(1).optional(),
  type: z.enum(CARD_TYPES),
  title: z.string().min(1),
  // Body kept short by design (~3 lines). Enforced softly with a max length.
  body: z.string().max(280),
  action: cardActionSchema.optional(),
  // Resource searches retain the one-card invariant while presenting a short,
  // source-attributed list of trusted links.
  links: z.array(resourceLinkSchema).min(1).max(3).optional(),
  expires_at: z.string().datetime().nullable().optional(),
});
export type Card = z.infer<typeof cardSchema>;

export const memoryOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('append_log'),
    category: z.enum(LOG_CATEGORIES),
    text: z.string().min(1),
    at: z.string().datetime().optional(),
  }),
  z.object({
    op: z.literal('set_fact'),
    key: z.string().min(1),
    value: z.string(),
  }),
  // add_appointment (Task 28, R12.1): the appointment-creation voice path emits this
  // so a dictated appointment is persisted to the patient profile through the same
  // validated-contract write path as append_log. The store assigns id + defaults the
  // status to `upcoming`, so only the extracted fields travel on the op. Optional
  // fields mirror the Appointment data model (with_whom / purpose may be unknown from
  // a terse dictation).
  z.object({
    op: z.literal('add_appointment'),
    title: z.string().min(1),
    at: z.string().min(1),
    with_whom: z.string().min(1).optional(),
    purpose: z.string().min(1).optional(),
  }),
]);
export type MemoryOp = z.infer<typeof memoryOpSchema>;

/**
 * The full turn contract. MVP rule: at most one active card per turn.
 */
export const turnContractSchema = z.object({
  session_id: z.string().min(1),
  turn_id: z.string().min(1),
  state: z.enum(ASSISTANT_STATES),
  // `say` is required and non-empty per the design validation rules; every turn speaks.
  say: z.string().min(1),
  cards: z.array(cardSchema).max(1).default([]),
  memory_ops: z.array(memoryOpSchema).default([]),
  flags: z.array(z.enum(TURN_FLAGS)).min(1).default(['none']),
});
export type TurnContract = z.infer<typeof turnContractSchema>;

/**
 * The subset a mode prompt is expected to produce. The orchestrator fills in
 * session_id / turn_id / state, so the LLM only produces say/cards/memory_ops/flags.
 */
export const modeOutputSchema = z.object({
  say: z.string().min(1),
  cards: z.array(cardSchema).max(1).default([]),
  memory_ops: z.array(memoryOpSchema).default([]),
  flags: z.array(z.enum(TURN_FLAGS)).min(1).default(['none']),
});
export type ModeOutput = z.infer<typeof modeOutputSchema>;

/** Safe fallback line used when validation fails twice. */
export const SAFE_FALLBACK_SAY =
  "I'm having a little trouble right now. Let's try that again in a moment.";

export function safeFallbackContract(
  session_id: string,
  turn_id: string,
  state: AssistantState = 'WAITING',
): TurnContract {
  return {
    session_id,
    turn_id,
    state,
    say: SAFE_FALLBACK_SAY,
    cards: [],
    memory_ops: [],
    flags: ['none'],
  };
}
