import { z } from 'zod';
import { ASSISTANT_STATES, CARD_ACTION_KINDS, turnContractSchema } from './contract.js';
import { ONBOARDING_LOCALES, ONBOARDING_STEP_IDS, onboardingPromptSchema, onboardingSnapshotSchema } from './onboarding.js';

/**
 * WebSocket message types. One connection per session, kept open for the whole session.
 * Binary frames carry PCM audio; JSON frames carry everything else.
 *
 * Binary audio is sent as raw WS binary frames (not JSON), in both directions:
 *   client -> server: microphone PCM while push-to-talk engaged
 *   server -> client: TTS PCM audio chunks
 */

// ---- Client -> Server (JSON control messages) ----
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('turn_end') }),
  z.object({ type: z.literal('interrupt') }),
  z.object({ type: z.literal('text_input'), text: z.string().min(1) }),
  z.object({
    type: z.literal('onboarding_answer'),
    prompt_id: z.string().min(1),
    value: z.string().min(1),
    capture_method: z.enum(['voice', 'typed']).default('typed'),
  }),
  z.object({ type: z.literal('onboarding_section_confirm'), prompt_id: z.string().min(1) }),
  z.object({
    type: z.literal('onboarding_edit'),
    prompt_id: z.string().min(1),
    step_id: z.enum(ONBOARDING_STEP_IDS),
  }),
  z.object({ type: z.literal('onboarding_skip'), prompt_id: z.string().min(1) }),
  z.object({ type: z.literal('onboarding_back'), prompt_id: z.string().min(1) }),
  z.object({ type: z.literal('onboarding_pause'), prompt_id: z.string().min(1) }),
  z.object({ type: z.literal('onboarding_resume') }),
  z.object({ type: z.literal('onboarding_replay'), prompt_id: z.string().min(1) }),
  z.object({
    type: z.literal('onboarding_language'),
    prompt_id: z.string().min(1),
    locale: z.enum(ONBOARDING_LOCALES),
  }),
  z.object({
    type: z.literal('card_action'),
    card_id: z.string().min(1),
    kind: z.enum(CARD_ACTION_KINDS),
  }),
  // Sent right after connect to (re)bind the socket to a session.
  z.object({ type: z.literal('attach_session'), session_id: z.string().min(1) }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type { OnboardingPrompt } from './onboarding.js';

// ---- Server -> Client (JSON messages) ----
export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('transcript_interim'), text: z.string() }),
  z.object({ type: z.literal('transcript_final'), text: z.string() }),
  z.object({ type: z.literal('assistant_state'), state: z.enum(ASSISTANT_STATES) }),
  z.object({ type: z.literal('turn_contract'), contract: turnContractSchema }),
  z.object({ type: z.literal('onboarding_prompt'), prompt: onboardingPromptSchema }),
  z.object({ type: z.literal('onboarding_snapshot'), snapshot: onboardingSnapshotSchema }),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
    degraded: z.boolean().optional(),
  }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/**
 * Binary `audio_chunk` frames are raw WS binary frames carrying PCM 16kHz mono audio.
 * They are not JSON and therefore are not part of the discriminated unions above.
 * Both directions use the same wire format:
 *   - client -> server: captured microphone PCM while push-to-talk is engaged
 *   - server -> client: TTS PCM audio chunks
 */
export const AUDIO_CHUNK_MESSAGE = 'audio_chunk' as const;

/** PCM audio wire format for binary `audio_chunk` frames (frozen for MVP). */
export const AUDIO_WIRE_FORMAT = {
  encoding: 'pcm_s16le',
  sample_rate_hz: 16000,
  channels: 1,
} as const;
