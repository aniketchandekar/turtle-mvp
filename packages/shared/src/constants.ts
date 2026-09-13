/**
 * Domain constants shared across client and server.
 */

// Spoken crisis resource line (988). Also rendered as a safety card — spoken AND shown.
export const CRISIS_RESOURCES = {
  lifeline_number: '988',
  lifeline_name: '988 Suicide & Crisis Lifeline',
  spoken:
    "I hear you, and I'm really glad you told me. You don't have to carry this alone. " +
    'You can reach the 988 Suicide and Crisis Lifeline any time by calling or texting 988. ' +
    'It would also help to reach out to someone you trust, or the care team.',
  card_title: '988 Suicide & Crisis Lifeline',
  card_body: 'Call or text 988, any time. You can also reach your care team or a trusted person.',
} as const;

// Medical guardrail refusal (R5.3/R5.4). Spoken AND shown on an actionable card.
// The refusal follows the frozen template from the safety guardrails:
//   acknowledge → state the limit plainly → offer the care-team contact → emit a card.
// Warm but absolute; never hedge into a partial answer.
export const MEDICAL_REFUSAL = {
  // 1) Acknowledge the caregiver warmly without engaging the clinical question.
  acknowledge: 'I hear you, and I want to help with this.',
  // 2) State the limit plainly — Turtle is not licensed and will not give clinical advice.
  limit:
    "This is a medical decision, and I'm not able to advise on it — I could get it wrong, " +
    'and that matters too much here.',
  // 3) Redirect to a human on the care team. A concrete contact name is appended when known.
  redirectWithContact: 'The best person for this is your care team',
  redirectNoContact:
    'The best person for this is your care team — please reach out to them directly.',
  // Card shown alongside the spoken refusal (spoken AND shown, never card-only/spoken-only).
  card_title: 'Ask your care team',
  card_body: 'This is a question for a clinician. Reach out to your care team directly.',
} as const;

// Q&A decline line used when no KB chunk supports an answer.
export const QA_DECLINE_LINE =
  "I don't know — this is one for your care team.";

export const CHECKIN_OPENER = 'How are you holding up — honestly?';

// The window before an appointment in which a prep briefing is offered.
export const APPOINTMENT_PREP_WINDOW_HOURS = 48;

// ElevenLabs TTS preset (frozen for MVP). Voice id is set from config.
export const TTS_PRESET = {
  model_id: 'eleven_flash_v2_5',
  output_format: 'pcm_16000',
  voice_settings: {
    stability: 0.5,
    similarity_boost: 0.8,
    style: 0.0,
    use_speaker_boost: false,
    speed: 1.0,
  },
  chunk_length_schedule: [120, 160, 250, 290],
} as const;
