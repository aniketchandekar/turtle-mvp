# Turtle — Requirements

## Introduction

Turtle is a voice-first companion web application for a single primary caregiver of a person
with terminal illness. It provides someone to talk to, grounded plain-language answers about
the diagnosis, appointment preparation, and a hands-free care log. Information is spoken by
default; visual cards appear only when content must be kept, acted on, or verified. Turtle is
honest about being software, never gives medical or dosing advice, never estimates prognosis,
and routes crises to human resources.

This document defines the requirements for the MVP, organized so they can be delivered across
five implementation phases (Phase 0–4). Each requirement is written in EARS format and traces
back to the source PRD (`reference files/turtle_prd_and_technical_spec.md`).

### Scope Boundaries (Non-Goals for MVP)

The following are explicitly out of scope and MUST NOT be built in the MVP: telephony /
outbound phone calls, multi-user support, voice profiles, patient mode, family access,
medication reasoning or dosing guidance, symptom triage, prognosis estimates, benefits
navigation, EHR integrations, ambient always-listening audio, speaker diarization,
bereavement continuity, native mobile apps, and any billing / B2B features.

### Phasing Overview

- **Phase 0 — Foundation:** monorepo, backend service skeleton, client shell, data store, config, graceful degradation.
- **Phase 1 — Voice pipeline:** push-to-talk, streaming ASR, streaming TTS, barge-in, session state machine.
- **Phase 2 — Conversation intelligence:** safety classifier, mode router, check-in prompt, Q&A + RAG, memory assembly, response contract validation.
- **Phase 3 — Artifacts:** card contract/surface/archive/voice retrieval, care log extraction, appointment prep.
- **Phase 4 — Safety & hardening:** crisis protocol end-to-end, recap, eval harness, observability, polish.

---

## Requirements

### Requirement 1: Foundation & Runtime (Phase 0)

**User Story:** As the developer, I want a runnable monorepo with a backend service, a client
shell, and a data store, so that later phases have a stable base and the app runs even when
external API keys are absent.

#### Acceptance Criteria

1. WHEN the repository is cloned and dependencies installed THEN the system SHALL start both the client and the backend service with a single documented command.
2. WHEN required third-party API keys (ElevenLabs, Deepgram, LLM provider) are missing THEN the system SHALL start in a degraded mode without crashing and SHALL clearly surface which capabilities are disabled.
3. WHEN the backend starts THEN the system SHALL initialize the data store (SQLite by default) and apply the schema for all entities defined in the design data model.
4. WHERE configuration values are required (API keys, model IDs, voice ID) THE system SHALL read them from environment variables with documented defaults.
5. WHEN the client loads THEN the system SHALL present only a microphone control and a transcript area, with no feed, home screen, or badges.

### Requirement 2: Session Lifecycle & State Machine (Phase 1)

**User Story:** As a caregiver, I want to start and end a voice session naturally, so that
talking to Turtle feels like a conversation rather than operating software.

#### Acceptance Criteria

1. WHEN the app opens THEN the system SHALL arm the microphone in an IDLE state without recording.
2. WHEN the caregiver presses and holds the microphone control THEN the system SHALL transition to LISTENING and stream audio.
3. WHEN end-of-speech is detected (button release or endpointing) THEN the system SHALL transition to THINKING.
4. WHEN the assistant response begins streaming THEN the system SHALL transition to SPEAKING.
5. WHEN an utterance completes THEN the system SHALL transition to WAITING, and after a short silence SHALL return to LISTENING.
6. WHEN the caregiver says a closing phrase (e.g., "I have to go") THEN the system SHALL transition to CLOSING and end warmly within 20 seconds.
7. THE system SHALL persist each session with its start time, end time, mode transitions, and flags.

### Requirement 3: Push-to-Talk Audio Capture & Streaming ASR (Phase 1)

**User Story:** As a caregiver, I want to speak and see my words appear, so that I trust the
system heard me correctly.

#### Acceptance Criteria

1. THE system SHALL capture microphone audio only while the push-to-talk control is engaged and SHALL NOT listen in the background.
2. WHEN audio is captured THEN the system SHALL stream it over a WebSocket to the backend as it is spoken.
3. WHEN the backend receives audio THEN the system SHALL forward it to the streaming ASR provider and receive interim and final transcripts.
4. WHEN interim transcripts arrive THEN the system SHALL display them in the transcript pane in a visually distinct (dimmed) style.
5. WHEN a final transcript is committed THEN the system SHALL display it as committed text and use it as the user turn.
6. IF the ASR provider is unavailable THEN the system SHALL fall back to a typed text input (text-in, voice-out).

### Requirement 4: Streaming TTS Playback & Barge-in (Phase 1)

**User Story:** As a caregiver, I want to hear Turtle speak and be able to interrupt it, so
that the conversation stays responsive and never talks over me.

#### Acceptance Criteria

1. WHEN the backend has validated response text THEN the system SHALL stream it to the TTS provider using the frozen Turtle voice preset (Flash v2.5, PCM output, per-turn flush).
2. WHEN TTS audio chunks arrive THEN the system SHALL stream them to the client and play them with low added buffering.
3. WHEN the caregiver begins speaking during playback THEN the system SHALL halt playback within 300ms, discard the remaining buffered response, and return to LISTENING.
4. WHEN a barge-in occurs THEN the system SHALL NOT penalize or scold the interruption and SHALL treat the new speech as the next turn.
5. IF the TTS provider is unavailable THEN the system SHALL degrade to a text-only mode that displays the response text.
6. THE spoken voice SHALL be clearly synthetic and SHALL NOT clone a human voice.

### Requirement 5: Safety Classifier & Guardrails (Phase 2, hardened in Phase 4)

**User Story:** As a caregiver in a high-stakes situation, I want Turtle to refuse clinical
advice and respond safely to distress, so that I am never harmed by wrong information.

#### Acceptance Criteria

1. WHEN a user turn is received THEN the system SHALL run a safety classifier on the raw text BEFORE any mode routing.
2. IF the classifier detects crisis content (suicidal ideation, self-harm, abuse) THEN the system SHALL bypass normal routing and invoke the crisis protocol.
3. IF the classifier detects a medical request (medication selection, dosing, timing, interactions, prognosis, or symptom triage) THEN the system SHALL bypass normal routing and produce a refusal that acknowledges, states the limit plainly, and redirects to the care-team contact.
4. WHEN a medical refusal is produced THEN the system SHALL emit an actionable card containing the relevant care-team contact.
5. WHEN any turn is flagged (crisis or medical_refusal) THEN the system SHALL mark that turn in the transcript log for owner review.
6. THE system SHALL NOT over-refuse benign but medically adjacent conversation (e.g., "he's tired today"); only clinical-decision requests trigger the guardrail.

### Requirement 6: Response Contract & Validation (Phase 2)

**User Story:** As the developer, I want every assistant turn to conform to a strict JSON
contract, so that cards, memory, and safety behavior are deterministic and testable.

#### Acceptance Criteria

1. WHEN a mode prompt produces a response THEN the system SHALL parse it against the mode's JSON contract containing `session_id`, `turn_id`, `state`, `say`, `cards`, `memory_ops`, and `flags`.
2. IF the response fails schema validation THEN the system SHALL regenerate once with a repair instruction.
3. IF regeneration still fails THEN the system SHALL emit a safe fallback line and no cards.
4. THE client SHALL render only the `say` field (as TTS + transcript) and the `cards` field (on the card surface), and SHALL NOT infer cards on its own.
5. WHEN the contract includes `memory_ops` THEN the system SHALL apply them to the memory store.

### Requirement 7: Check-in Conversation Mode (Phase 2)

**User Story:** As a caregiver, I want a warm, brief check-in that remembers what I said
before, so that I feel heard without a long session.

#### Acceptance Criteria

1. WHEN a session opens THEN the system SHALL initiate a check-in opener (e.g., "How are you holding up — honestly?").
2. WHEN the caregiver responds THEN the system SHALL listen and validate, offering at most one concrete coping suggestion per session.
3. WHERE prior session themes exist THE system SHALL ground a follow-up question in them (e.g., "Last time you mentioned the nausea — how's that going?").
4. THE system SHALL keep turns short and aim to close the session naturally within 5–10 minutes.
5. WHEN the session closes THEN the system SHALL provide a spoken recap and a recap card.

### Requirement 8: Diagnosis Q&A with RAG (Phase 2)

**User Story:** As a caregiver, I want grounded plain-language answers about the diagnosis, so
that I understand what is happening without being misled.

#### Acceptance Criteria

1. WHEN the caregiver asks a question about the diagnosis, treatment, side effects, or what to expect THEN the system SHALL retrieve the top-k (k=4) knowledge-base chunks filtered by the patient's diagnosis.
2. WHEN an answer is composed THEN the system SHALL ground every factual sentence in a retrieved chunk and SHALL end with either a source reference or a redirect to the care team.
3. IF no retrieved chunk supports the answer THEN the system SHALL say "I don't know — this is one for your care team" rather than guessing.
4. WHEN post-hoc grounding validation finds an ungrounded factual sentence THEN the system SHALL drop it and replace ungrounded answers with the decline line.
5. WHERE the caregiver confirms THE system MAY save an effective answer as a retained card.

### Requirement 9: Memory & Context Assembly (Phase 2)

**User Story:** As a caregiver, I want Turtle to recall relevant facts and past themes, so
that I do not repeat myself.

#### Acceptance Criteria

1. WHEN assembling context for a turn THEN the system SHALL include profile facts: patient, diagnosis, care-team contacts, and the next upcoming appointment only.
2. WHEN assembling context THEN the system SHALL include summary lines from the last 3 sessions, not full transcripts.
3. WHERE the active mode requires it THE system SHALL include relevant log entries stated as recall (e.g., "you noted a cough on Monday"), never as advice.
4. THE system SHALL surface memory as recall only and SHALL NOT convert it into interpretation or advice.

### Requirement 10: Card System (Phase 3)

**User Story:** As a caregiver, I want a card only when something must be kept or acted on, so
that the interface stays quiet and the artifact is meaningful.

#### Acceptance Criteria

1. WHEN the response contract emits a card event meeting the taxonomy (actionable, retained, safety) THEN the system SHALL render exactly that card.
2. THE card SHALL contain a title, a body of at most ~3 lines, and at most one action button; dismiss and confirm SHALL be available by voice.
3. WHEN spoken content corresponds to a card THEN the system SHALL render the card only after that utterance finishes playing, and SHALL NOT interrupt speech.
4. WHEN a card is dismissed or completed THEN the system SHALL move it to an archive retrievable by voice.
5. IF a session emits no card events THEN the client SHALL show only the microphone and transcript.
6. THE system SHALL show at most one active card at a time in the MVP.

### Requirement 11: Care Log (Phase 3)

**User Story:** As a caregiver, I want to dictate log entries hands-free, so that care events
are captured without interpretation.

#### Acceptance Criteria

1. WHEN the caregiver dictates a log entry (e.g., "Gave the 2pm meds… slept badly… new cough") THEN the system SHALL extract it into one or more structured entries with a timestamp and a category (medication_given, symptom, sleep, food, event, note).
2. WHEN an entry is filed THEN the system SHALL confirm with passive phrasing (e.g., "Noted — 2pm meds given") and create a log card.
3. THE system SHALL NOT interpret, compare, advise on, or triage log content.
4. WHEN the caregiver asks about past events (e.g., "What happened yesterday?", "When did the cough start?") THEN the system SHALL retrieve matching entries by voice and MAY list them as a card on request.

### Requirement 12: Appointment Prep & Summary (Phase 3)

**User Story:** As a caregiver, I want to be prepared for appointments and capture what the
doctor said, so that I ask the right questions and remember the answers.

#### Acceptance Criteria

1. THE system SHALL store appointments in the patient profile, addable by voice or a minimal form.
2. WHEN a session occurs within a configurable window before an appointment (default 48h) THEN the system SHALL offer a prep briefing covering the appointment's purpose, what to report, and suggested questions.
3. WHEN a prep briefing is generated THEN the system SHALL produce one card per appointment containing the appointment name, date, and a "what to ask" list.
4. WHEN the caregiver dictates "what the doctor said" after a visit THEN the system SHALL structure it into a visit summary card shareable via link.
5. WHEN the caregiver asks to retrieve prep or summary content by voice (e.g., "What were the questions for Tuesday?") THEN the system SHALL return the matching card content.

### Requirement 13: Crisis Protocol (Phase 4)

**User Story:** As a caregiver in distress, I want gentle, immediate access to crisis
resources, so that I am supported and directed to humans.

#### Acceptance Criteria

1. WHEN the safety classifier flags crisis content THEN the system SHALL respond gently, validate, and SHALL NOT continue normal conversation.
2. WHEN the crisis protocol runs THEN the system SHALL speak crisis resources (988 Suicide & Crisis Lifeline) and encourage contacting the care team or a trusted person.
3. WHEN the crisis protocol runs THEN the system SHALL emit a safety card with the same resources, so the resources are BOTH spoken AND shown.
4. WHEN the crisis protocol runs THEN the system SHALL flag the transcript for owner review.
5. THE system SHALL NEVER present safety content as card-only or spoken-only.

### Requirement 14: Recap & Session Close (Phase 4)

**User Story:** As a caregiver, I want a short recap when we finish, so that I leave with a
clear artifact of what we covered.

#### Acceptance Criteria

1. WHEN a session enters CLOSING THEN the system SHALL speak a brief recap of what was covered.
2. WHEN the recap is spoken THEN the system SHALL emit a recap card summarizing the session.
3. THE system SHALL persist recap cards as long-term artifacts associated with the session.

### Requirement 15: Eval Harness & Observability (Phase 4)

**User Story:** As the developer, I want automated evals and per-turn observability, so that
prompt changes stay safe and latency is measurable.

#### Acceptance Criteria

1. THE system SHALL provide an eval harness that runs adversarial safety probes and asserts 100% refuse+redirect on medical probes and 100% crisis-protocol trigger on crisis probes.
2. THE system SHALL provide a Q&A grounding eval that scores grounded-citation rate and hallucination rate against a golden question set.
3. THE system SHALL provide a benign-medical-adjacent set and assert the guardrail does not over-refuse.
4. WHEN a turn completes THEN the system SHALL emit a structured log recording the latency breakdown (ASR → classify → LLM → TTS), flags, mode transitions, and card emissions.
5. THE system SHALL provide a card taxonomy unit test asserting no cards are emitted for purely conversational content.

### Requirement 16: Non-Functional Requirements (all phases)

**User Story:** As a caregiver, I want the app to be fast, private, honest, and accessible,
so that I can rely on it.

#### Acceptance Criteria

1. THE system SHALL target voice response start (end-of-speech → first audio byte) under 1.5s p50 and under 2.5s p95.
2. THE system SHALL render a card within 500ms after the corresponding spoken content finishes.
3. THE system SHALL support barge-in halting playback within 300ms.
4. IF TTS or ASR fails THEN the system SHALL degrade gracefully to a text-only or text-in mode rather than failing hard.
5. THE system SHALL use push-to-talk only, SHALL show an honest microphone indicator, and SHALL NOT record in the background.
6. THE system SHALL store transcripts, log entries, and contacts encrypted at rest, and SHALL use TLS/WSS in transit.
7. THE system SHALL discard captured audio after transcription by default unless retention is explicitly consented.
8. THE system SHALL provide full voice parity: anything doable by tap SHALL be doable by voice.
9. THE system SHALL provide accessible UI: large tap targets and readable type.
10. THE system SHALL obtain explicit consent to recording/storage before the first session and SHALL introduce itself as software (AI) in the first session.
