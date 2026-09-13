# Implementation Plan

## Overview

Phased build of the full Turtle webapp. Each phase produces something runnable and testable.
Phases build on one another: Phase 0 gives a running skeleton, and by the end of Phase 4 the
full MVP from the PRD is delivered. Task references (e.g., R1.2) point to acceptance criteria
in `requirements.md`.

The plan is organized into five phases:

- **Phase 0 — Foundation:** monorepo, shared contract, config/degradation, store, client shell, backend service.
- **Phase 1 — Voice pipeline:** WebSocket channel, audio capture/playback, ASR, TTS, state machine, barge-in, latency instrumentation.
- **Phase 2 — Conversation intelligence:** LLM adapter, contract validation, safety classifier, guardrail refusal, mode router, memory, check-in, RAG, grounded Q&A.
- **Phase 3 — Artifacts:** cards, care log, appointments, prep briefings, visit summaries.
- **Phase 4 — Safety & hardening:** crisis protocol, recap/close, onboarding/consent, eval harnesses, observability, privacy controls, E2E tests.

## Tasks

### Phase 0 — Foundation

- [x] 1. Initialize the monorepo and shared types
  - Create npm workspaces root with `apps/web`, `apps/server`, `packages/shared`
  - Add root scripts to run web + server together with one command
  - Add TypeScript, ESLint, Prettier, and a test runner (Vitest) config
  - _Requirements: R1.1_

- [x] 2. Define shared contract and message types in `packages/shared`
  - Implement the response contract type and its Zod schema
  - Implement WebSocket message types (client→server, server→client)
  - Implement the data-model TypeScript types (caregiver, patient, appointment, log_entry, session, turn, card, kb_chunk)
  - _Requirements: R6.1, R6.4_

- [x] 3. Build the configuration and degradation layer
  - Load config from environment variables with documented defaults (API keys, model IDs, voice ID)
  - Implement a provider-availability check that reports which capabilities are live vs disabled
  - Ensure the server boots with zero API keys present
  - _Requirements: R1.2, R1.4_

- [x] 4. Implement the SQLite store and schema
  - Add `better-sqlite3` and create migrations for all data-model tables
  - Implement repository functions for each entity (create/read/update/list)
  - Add encryption-at-rest for transcript, log entry, and contact fields
  - Write unit tests for the repositories
  - _Requirements: R1.3, R16.6_

- [x] 5. Build the client shell (Next.js)
  - Create the minimal UI: microphone control + transcript area only (no feed/home/badges)
  - Add an honest, visible mic indicator (off by default)
  - Apply accessible defaults: large tap targets, readable type
  - _Requirements: R1.5, R16.5, R16.9_

- [x] 6. Stand up the backend service and health endpoint
  - Create the Node/TypeScript server entrypoint with module folders (gateway, orchestrator, services)
  - Implement `GET /health` reporting live vs degraded providers
  - Implement REST control-plane stubs for `/sessions`, `/patients`, `/appointments`, `/log-entries`, `/cards`
  - _Requirements: R1.1, R1.2_

---

### Phase 1 — Voice pipeline

- [x] 7. Implement the WebSocket session channel
  - Add a `ws` server; one connection per session, kept open for the session
  - Implement `POST /sessions` and session lifecycle persistence (start/end, mode_transitions, flags)
  - Wire client→server (`audio_chunk`, `turn_end`, `interrupt`, `text_input`) and server→client (`transcript_*`, `assistant_state`, `audio_chunk`, `turn_contract`, `error`) message handling
  - _Requirements: R2.7, R3.2_

- [x] 8. Implement client audio capture and playback
  - Capture 16kHz mono PCM via `getUserMedia` + AudioWorklet, gated by push-to-talk
  - Stream `audio_chunk` while held; send `turn_end` on release
  - Implement Web Audio playback of incoming PCM chunks with a ~150–250ms buffer
  - _Requirements: R3.1, R3.2, R4.2, R16.5_

- [x] 9. Integrate streaming ASR (Deepgram)
  - Forward client audio to Deepgram streaming (`nova-3`, interim on, built-in VAD endpointing)
  - Emit `transcript_interim` (dimmed) and commit `transcript_final` as the user turn
  - Implement text-in fallback (`text_input`) when Deepgram is unavailable
  - _Requirements: R3.3, R3.4, R3.5, R3.6, R16.4_

- [x] 10. Integrate streaming TTS (ElevenLabs)
  - Connect to ElevenLabs WS with the frozen Turtle preset (Flash v2.5, pcm_16000, voice settings, chunk schedule)
  - Stream `say` sentence-by-sentence with `flush:true` on the final sentence; keepalive with `{"text":" "}` between turns; keep the socket open across turns
  - Pre-render static strings (AI disclosure, greeting, crisis lines, recap) via HTTP streaming
  - Implement text-only degradation when ElevenLabs is unavailable
  - _Requirements: R4.1, R4.2, R4.5, R4.6, R16.4_

- [x] 11. Implement the conversation state machine
  - Implement IDLE → LISTENING → THINKING → SPEAKING → WAITING → (LISTENING | CLOSING)
  - Emit `assistant_state` on every transition; short-silence WAITING → LISTENING
  - Record mode_transitions on the session
  - _Requirements: R2.1, R2.2, R2.3, R2.4, R2.5, R2.7_

- [x] 12. Implement barge-in
  - Add client-side VAD during playback; send `interrupt` on speech
  - Gateway flushes TTS buffer, stops forwarding audio, discards partial response, returns to LISTENING within 300ms
  - Never penalize interruption; treat new speech as the next turn
  - Write a scripted interruption test asserting <300ms halt and correct state transition
  - _Requirements: R4.3, R4.4, R16.3_

- [x] 13. Add per-turn latency instrumentation
  - Record latency breakdown (ASR → classify → LLM → TTS) per turn
  - Assert p50 end-of-speech → first audio byte < 1.5s in a local timing test
  - _Requirements: R16.1, R15.4_

---

### Phase 2 — Conversation intelligence

- [x] 14. Implement the LLM provider adapter
  - Abstract Claude/GPT behind one interface with streaming support
  - Add an 8s timeout with one retry, then park-the-turn apology
  - Add a canned/echo fallback so the pipeline runs with no LLM key
  - _Requirements: R6.2, R6.3, R16.4_

- [x] 15. Implement contract validation and repair
  - Validate every mode response against the Zod contract schema
  - On failure, regenerate once with a repair instruction; else emit a safe fallback line with no cards
  - Apply `memory_ops` to the store; persist the turn and any cards
  - Write unit tests for valid/invalid/repair/fallback paths
  - _Requirements: R6.1, R6.2, R6.3, R6.5_

- [x] 16. Implement the safety classifier (seed)
  - Run `safety.classifier` on raw user text before any routing
  - Return crisis / medical / none; bias uncertain cases toward flagging
  - Bypass normal routing for crisis and medical flags
  - _Requirements: R5.1, R5.2, R5.3_

- [x] 17. Implement the medical guardrail refusal composer
  - `guardrail.refusal`: acknowledge → state limit plainly → redirect to care-team contact
  - Emit an actionable card with the care-team contact from the profile
  - Mark the flagged turn for owner review
  - _Requirements: R5.3, R5.4, R5.5_

- [x] 18. Implement the mode router
  - Rules-first routing (log dictation, appointment retrieval) then a small intent classification for the rest
  - Route to check-in / Q&A / log / prep prompts
  - Record the chosen mode in mode_transitions
  - _Requirements: R6.1_

- [x] 19. Implement the memory & context assembly service
  - Assemble profile facts (patient, diagnosis, care team, next appointment only)
  - Include last 3 session summary lines (not transcripts)
  - Include relevant log entries only when the mode requests, stated as recall not advice
  - _Requirements: R9.1, R9.2, R9.3, R9.4_

- [x] 20. Implement the check-in mode
  - `checkin.prompt`: warm, memory-aware, short turns; at most one coping suggestion per session
  - Open sessions with the check-in opener; ground follow-ups in prior themes
  - _Requirements: R7.1, R7.2, R7.3, R7.4_

- [x] 21. Build the RAG subsystem
  - Seed one diagnosis vertical (metastatic cancer) as curated plain-language markdown under `kb/`
  - Chunk (~300 tokens) with metadata; build embeddings on a build step; lexical fallback with no embedding key
  - Implement cosine retrieval with diagnosis filter, k=4
  - _Requirements: R8.1_

- [x] 22. Implement the Q&A mode with grounding
  - `qa.prompt`: answer grounded in retrieved chunks; end with source reference or care-team redirect
  - Post-hoc grounding check: drop ungrounded sentences; fully ungrounded → "I don't know — this is one for your care team"
  - Store retrieved_chunk_ids on the turn
  - Add a small golden-question grounding test
  - _Requirements: R8.1, R8.2, R8.3, R8.4, R15.2_

---

### Phase 3 — Artifacts (cards, care log, appointments)

- [x] 23. Implement the card service and lifecycle
  - Persist cards from the contract only (never inferred client-side)
  - Manage `active → dismissed | done → archived`; enforce max one active card
  - Add `GET /cards?status=archived` and `PATCH /cards/:id`
  - _Requirements: R10.1, R10.4, R10.6_

- [x] 24. Implement the client card surface
  - Single card component (bottom sheet/overlay): title, ≤3-line body, ≤1 action
  - Render a card only after its corresponding utterance finishes playing; never interrupt speech
  - No-card sessions show only mic + transcript
  - Voice parity: okay/done/dismiss/call flow through the normal turn pipeline; taps send `card_action`
  - _Requirements: R10.1, R10.2, R10.3, R10.5, R16.2, R16.8_

- [x] 25. Add a card taxonomy unit test
  - Assert cards only emit for actionable/retained/safety content
  - Assert purely conversational content emits no cards
  - _Requirements: R10.1, R15.5_

- [x] 26. Implement the care log extraction mode
  - `log.prompt`: extract utterance into one or more structured entries with timestamp and category; zero interpretation
  - Confirm with passive phrasing ("Noted — 2pm meds given") and create a log card
  - _Requirements: R11.1, R11.2, R11.3_

- [x] 27. Implement care log voice retrieval
  - Answer "what happened yesterday?" / "when did the cough start?" from stored entries
  - Optionally list matching entries as a card on request
  - _Requirements: R11.4_

- [x] 28. Implement appointment management
  - Add appointments by voice or a minimal form; store in the patient profile
  - Support statuses upcoming/done/cancelled
  - _Requirements: R12.1_

- [x] 29. Implement appointment prep briefing
  - `prep.prompt`: when a session occurs within the configurable window (default 48h) before an appointment, offer a prep briefing (purpose, what to report, suggested questions)
  - Emit one card per appointment: name, date, "what to ask" list
  - _Requirements: R12.2, R12.3_

- [x] 30. Implement visit summary and prep/summary retrieval
  - Dictate "what the doctor said" → structured visit summary card, shareable via link
  - Retrieve prep/summary content by voice ("what were the questions for Tuesday?")
  - _Requirements: R12.4, R12.5_

---

### Phase 4 — Safety & hardening

- [x] 31. Implement the crisis protocol end-to-end
  - On crisis flag: respond gently, validate, stop normal conversation
  - Speak crisis resources (988) and encourage contacting care team / trusted person
  - Emit a safety card with the same resources (spoken AND shown); enforce never card-only or spoken-only
  - Flag the transcript for owner review
  - _Requirements: R13.1, R13.2, R13.3, R13.4, R13.5, R5.5_

- [x] 32. Implement recap and session close
  - On CLOSING, speak a brief recap and emit a recap card
  - Support closing phrases ("I have to go") ending warmly within 20s
  - Persist recap cards as long-term session artifacts
  - _Requirements: R2.6, R7.5, R14.1, R14.2, R14.3_

- [x] 33. Implement onboarding, consent, and AI disclosure
  - First-run voice introduction: what Turtle is (an AI), what it does, what it never does
  - Create patient profile by voice or minimal form (name, diagnosis from fixed list, key dates, care-team contacts)
  - Pick check-in time and voice preferences
  - Capture explicit consent to recording/storage before the first session
  - _Requirements: R16.10_

- [x] 34. Build the full guardrail eval harness
  - Adversarial set: 50+ medical probes (assert 100% refuse+redirect), 30+ crisis probes (assert 100% protocol trigger), 50+ benign-adjacent (assert no over-refusal)
  - Wire as a runnable test suite gating prompt changes
  - _Requirements: R5.6, R15.1, R15.3_

- [x] 35. Expand the Q&A grounding eval
  - Golden question set per diagnosis; score grounded-citation rate and hallucination rate
  - Gate prompt changes on the grounding score
  - _Requirements: R15.2_

- [x] 36. Implement observability and metrics
  - Structured per-turn logs (latency breakdown, flags, mode transitions, card emissions)
  - Owner review view for flagged transcripts
  - Lightweight metrics: sessions/day, p50/p95 latency, refusal/crisis counts, grounded-answer rate
  - _Requirements: R15.4, R5.5_

- [x] 37. Implement privacy controls and audio retention policy
  - Discard captured audio after transcription by default
  - One-click "delete everything" endpoint and client control
  - Verify WSS/TLS posture and encryption-at-rest coverage
  - _Requirements: R16.6, R16.7_

- [x] 38. Write end-to-end tests and polish
  - Playwright scripted sessions through all modes including interrupt, crisis, refusal, recap
  - Rubric-scored transcript regression check for conversation quality (warmth, brevity, no advice creep)
  - Review latency p50/p95 and card-render timing against targets
  - _Requirements: R16.1, R16.2, R16.3_
---

## Task Dependency Graph

Tasks are grouped by phase; each phase builds on the previous one. Within a phase, the
foundational tasks are listed first. The graph below shows the primary dependencies
(`A -> B` means B depends on A).

The JSON block defines execution waves: each wave lists tasks whose dependencies are all
satisfied by earlier waves, so tasks within the same wave can be worked in parallel.

```json
{
  "tasks": {
    "1": { "depends_on": [] },
    "2": { "depends_on": ["1"] },
    "3": { "depends_on": ["2"] },
    "4": { "depends_on": ["3"] },
    "5": { "depends_on": ["1"] },
    "6": { "depends_on": ["1", "3"] },
    "7": { "depends_on": ["2", "6"] },
    "8": { "depends_on": ["5", "7"] },
    "9": { "depends_on": ["7", "8"] },
    "10": { "depends_on": ["7", "8"] },
    "11": { "depends_on": ["7", "9", "10"] },
    "12": { "depends_on": ["8", "10", "11"] },
    "13": { "depends_on": ["9", "10", "11"] },
    "14": { "depends_on": ["3", "11"] },
    "15": { "depends_on": ["2", "14"] },
    "16": { "depends_on": ["14"] },
    "17": { "depends_on": ["15", "16"] },
    "18": { "depends_on": ["15", "16"] },
    "19": { "depends_on": ["4", "15"] },
    "20": { "depends_on": ["18", "19"] },
    "21": { "depends_on": ["4"] },
    "22": { "depends_on": ["18", "19", "21"] },
    "23": { "depends_on": ["4", "15"] },
    "24": { "depends_on": ["5", "23"] },
    "25": { "depends_on": ["23", "24"] },
    "26": { "depends_on": ["18", "23"] },
    "27": { "depends_on": ["4", "26"] },
    "28": { "depends_on": ["4", "6"] },
    "29": { "depends_on": ["19", "23", "28"] },
    "30": { "depends_on": ["26", "28", "29"] },
    "31": { "depends_on": ["16", "17", "23"] },
    "32": { "depends_on": ["11", "23"] },
    "33": { "depends_on": ["5"] },
    "34": { "depends_on": ["16", "17", "31"] },
    "35": { "depends_on": ["22"] },
    "36": { "depends_on": ["13", "23"] },
    "37": { "depends_on": ["4", "8"] },
    "38": { "depends_on": ["12", "20", "22", "24", "25", "27", "30", "31", "32", "33", "34", "35", "36", "37"] }
  },
  "waves": [
    { "wave": 1, "tasks": ["1"] },
    { "wave": 2, "tasks": ["2", "5"] },
    { "wave": 3, "tasks": ["3", "33"] },
    { "wave": 4, "tasks": ["4", "6"] },
    { "wave": 5, "tasks": ["7", "21", "28"] },
    { "wave": 6, "tasks": ["8"] },
    { "wave": 7, "tasks": ["9", "10", "37"] },
    { "wave": 8, "tasks": ["11"] },
    { "wave": 9, "tasks": ["12", "13", "14"] },
    { "wave": 10, "tasks": ["15", "16"] },
    { "wave": 11, "tasks": ["17", "18", "19", "23"] },
    { "wave": 12, "tasks": ["20", "22", "24", "26", "29", "31", "32", "36"] },
    { "wave": 13, "tasks": ["25", "27", "30", "34", "35"] },
    { "wave": 14, "tasks": ["38"] }
  ]
}
```

```
Phase 0 — Foundation
  1 (monorepo) -> 2 (shared contract) -> 3 (config/degradation) -> 4 (SQLite store)
  1 -> 5 (client shell)
  1, 3 -> 6 (backend service + health)

Phase 1 — Voice pipeline
  2, 6 -> 7 (WebSocket channel)
  5, 7 -> 8 (audio capture/playback)
  7, 8 -> 9 (ASR / Deepgram)
  7, 8 -> 10 (TTS / ElevenLabs)
  7, 9, 10 -> 11 (state machine)
  8, 10, 11 -> 12 (barge-in)
  9, 10, 11 -> 13 (latency instrumentation)

Phase 2 — Conversation intelligence
  3, 11 -> 14 (LLM adapter)
  2, 14 -> 15 (contract validation + repair)
  14 -> 16 (safety classifier)
  15, 16 -> 17 (guardrail refusal)
  15, 16 -> 18 (mode router)
  4, 15 -> 19 (memory & context)
  18, 19 -> 20 (check-in mode)
  4 -> 21 (RAG subsystem)
  18, 19, 21 -> 22 (Q&A + grounding)

Phase 3 — Artifacts
  4, 15 -> 23 (card service)
  5, 23 -> 24 (client card surface)
  23, 24 -> 25 (card taxonomy test)
  18, 23 -> 26 (care log extraction)
  4, 26 -> 27 (care log retrieval)
  4, 6 -> 28 (appointment management)
  19, 23, 28 -> 29 (prep briefing)
  26, 28, 29 -> 30 (visit summary + retrieval)

Phase 4 — Safety & hardening
  16, 17, 23 -> 31 (crisis protocol)
  11, 23 -> 32 (recap + session close)
  5, 33 (onboarding/consent/disclosure)
  16, 17, 31 -> 34 (guardrail eval harness)
  22 -> 35 (Q&A grounding eval)
  13, 23 -> 36 (observability + metrics)
  4, 8 -> 37 (privacy controls + retention)
  all above -> 38 (E2E tests + polish)
```

## Notes

- Task references (e.g., `R1.2`) map to acceptance criteria in `requirements.md`.
- Each phase is designed to leave the app in a runnable, testable state. Do not start a
  later phase before the phase it depends on is green.
- Safety-related tasks (16, 17, 31, 34) are binding gates: prompt or classifier changes must
  pass the adversarial safety eval set before merge (50+ medical probes, 30+ crisis probes,
  50+ benign-adjacent probes) per the safety guardrails.
- Every external provider must have a working fallback (no Deepgram → text-in; no ElevenLabs →
  text-only; no LLM → canned; no embeddings → lexical). The app must boot with zero API keys,
  so degradation work in tasks 3, 9, 10, 14, and 21 is not optional.
- The JSON response contract is the spine: cards and memory ops flow only from the validated
  contract (tasks 2, 15, 23), never inferred client-side.
- The spoken-AND-shown rule for safety content (crisis resources, medical refusals) is enforced
  in code, not just prompts (tasks 17, 31).
