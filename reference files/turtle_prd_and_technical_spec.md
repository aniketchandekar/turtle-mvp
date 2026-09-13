# Turtle — Product Requirements Document & High-Level Technical Specification

| | |
|---|---|
| **Project** | Turtle — Voice-first caregiver companion |
| **Version** | 0.1 (MVP) |
| **Status** | Draft for build |
| **Date** | 2026-09-12 |
| **Scope** | Personal project — single caregiver, single patient, app-based voice UI, no telephony, no B2B |

---

# PART 1 — PRODUCT REQUIREMENTS DOCUMENT

## 1. Vision

Turtle is a voice-first companion for primary caregivers of people with terminal illness. It gives caregivers someone to talk to, helps them understand the diagnosis, prepares them for appointments, keeps a lightweight log of care, and never pretends to be human. Information is spoken by default and surfaced visually **only** as cards, and only when it must be kept or acted on.

## 2. Problem Statement

Primary caregivers (typically a family member or spouse) of terminally ill patients experience:

- **Isolation** — friends withdraw; support groups are scheduled obligations; there is no one to talk to at 2am.
- **Information asymmetry** — they attend appointments but don't know what to ask; they leave confused; they carry medical language they don't understand.
- **Invisible labor** — medication schedules, symptom tracking, appointment logistics, all kept in their head or in notes apps not built for them.
- **Anticipatory grief** — clinically distinct, chronically underserved, with elevated risk of depression, complicated grief, and suicidality.

Existing tools are either dashboards (demanding attention caregivers don't have), generic chatbots (untrustworthy in high-stakes contexts), or human services (scarce, scheduled, and over capacity).

## 3. Target User (MVP)

- One **caregiver**: a family member or loved one providing daily care to a terminally ill patient.
- Caregiver is the **only** active voice user. No multi-user support, no patient mode, no family access in MVP.
- Comfortable talking out loud; not assumed to be technical. The UI is a microphone, a transcript, and cards. Nothing else.

## 4. Goals

| # | Goal |
|---|---|
| G1 | Caregiver can talk to Turtle naturally, by voice, with interruption support, and feel heard |
| G2 | Caregiver can ask questions about the patient's diagnosis and receive grounded, guarded, plain-language answers |
| G3 | Caregiver is prepared for every appointment: what it's for, what to report, what to ask |
| G4 | Caregiver can dictate care log entries (symptoms, meds given, sleep, events) hands-free by voice |
| G5 | Anything that must be kept or acted on appears as a card; everything else lives in speech |
| G6 | System never gives medication advice, never estimates prognosis, and escalates distress to humans/resources |

## 5. Non-Goals (Explicitly Out of Scope for MVP)

- Phone calls / telephony / proactive outbound calls
- Multi-user support, voice profiles, patient mode, family access
- Medication reasoning, dosing guidance, symptom triage
- Prognosis or life-expectancy estimates
- Benefits/government/hospital financial-aid navigation
- EHR integrations
- Speaker diarization in ambient audio; no always-listening
- Bereavement/post-death continuity
- Native mobile apps (web app first)
- Business model, billing, B2B features of any kind

## 6. Design Principles

1. **Voice is the medium. Cards are artifacts.** If information can be spoken, it is spoken. A card appears only when content must be *kept*, *acted on*, or *verified*.
2. **The said / kept / acted test.** For every piece of information:
   - Can it be said? → voice only.
   - Should it be kept? → card, then voice-retrievable archive.
   - Must it be acted on? → card with one action, voice-confirmable.
   - Fails all three → it is not a feature. Turtle has no feed, no home screen, no badges.
3. **No ambient surveillance.** No always-listening microphone. Push-to-talk only. A dying patient is often in the room; privacy is existential, not cosmetic.
4. **Honest AI, always.** Turtle introduces itself as software in the first session. It is warm but never deceptive. Users will anthropomorphize anyway; the product must not exploit that.
5. **Restraint over brilliance.** Short turns. Sessions of 5–10 minutes. Yielding gracefully when interrupted beats fluent monologue.
6. **The human is the ceiling, not the failure.** When Turtle can't help well — medical uncertainty, emotional crisis, anything clinical — it says so and routes to a human or a resource.
7. **Log, never interpret.** The system records what the caregiver says happened. It never tells them what to do about it.

## 7. Functional Requirements

### Onboarding

| ID | Requirement |
|---|---|
| FR-ONB-1 | First-run voice introduction: what Turtle is (an AI), what it does, what it never does |
| FR-ONB-2 | Caregiver creates patient profile by voice or minimal form: name, diagnosis (from a fixed list), key dates (next appointments), care team contacts (nurse line, social worker) |
| FR-ONB-3 | Caregiver picks a preferred check-in time and voice preferences (voice selection, pace) |
| FR-ONB-4 | Explicit consent: recording/storage of conversations acknowledged before first session |

### Check-in conversation

| ID | Requirement |
|---|---|
| FR-CHK-1 | On app open (or at preferred time when app is open), Turtle initiates: "How are you holding up — honestly?" |
| FR-CHK-2 | Free-form supportive conversation: listening, validating, offering at most one concrete coping tool or suggestion per session |
| FR-CHK-3 | Turtle asks follow-up questions grounded in prior sessions (memory) — "Last time you mentioned the nausea — how's that going?" |
| FR-CHK-4 | Session naturally closes within 5–10 minutes; spoken + card recap ("Here's what we covered") |
| FR-CHK-5 | Caregiver can end a session at any time by voice ("I have to go") — Turtle closes warmly in under 20 seconds |

### Diagnosis Q&A ("Ask me anything about the illness")

| ID | Requirement |
|---|---|
| FR-QA-1 | Caregiver can ask questions in plain language about the patient's diagnosis, treatment, side effects, what to expect |
| FR-QA-2 | Answers are grounded in the curated knowledge base via retrieval (RAG), plain-language, and end with either a source reference or a redirect to the care team |
| FR-QA-3 | Guardrailed: no prognosis estimates, no medication/dosing advice, no symptom triage beyond "call the nurse — here's the number" |
| FR-QA-4 | Guardrailed: when a question exceeds the knowledge base, Turtle says "I don't know — this is one for your care team" rather than guessing |
| FR-QA-5 | Effective answers may be offered as a card ("I've saved that explanation if you want it later") — always caregiver-initiated or confirmed |

### Appointment prep

| ID | Requirement |
|---|---|
| FR-APT-1 | Appointments live in the patient profile (added by voice or minimal form) |
| FR-APT-2 | When a session occurs within a configurable window before an appointment (default 48h), Turtle offers a prep briefing: what this appointment is for, what to report, suggested questions |
| FR-APT-3 | Prep output generates a card: appointment name, date, "what to ask" list — one card per appointment |
| FR-APT-4 | After the visit, caregiver can dictate "what the doctor said" by voice; Turtle structures it into a visit summary card, shareable via link |
| FR-APT-5 | Caregiver can retrieve prep/summary cards by voice: "What were the questions for Tuesday?" |

### Care log

| ID | Requirement |
|---|---|
| FR-LOG-1 | Caregiver can dictate log entries any time: "Gave the 2pm meds… slept badly… new cough." Turtle confirms and files |
| FR-LOG-2 | Each entry becomes a log card with timestamp and category (medication-given, symptom, sleep, food, event, note) |
| FR-LOG-3 | Turtle **never** interprets, compares, or advises on log content. Confirmation phrasing is passive: "Noted — 2pm meds given" |
| FR-LOG-4 | Entries are retrievable by voice ("What happened yesterday?", "When did the cough start?") and listed as a card on request |

### Cards system

| ID | Requirement |
|---|---|
| FR-CRD-1 | A card renders only when the conversation layer emits a card event meeting the taxonomy (§8) |
| FR-CRD-2 | Card anatomy: title, body (max ~3 lines), at most one action button; dismiss and confirm available by voice |
| FR-CRD-3 | Cards never interrupt speech; they appear as the assistant finishes speaking the content |
| FR-CRD-4 | Dismissed/completed cards go to an archive, retrievable by voice; no visual browse feed required in MVP |
| FR-CRD-5 | If a session emits no card events, the user sees only the mic and the transcript |

### Safety

| ID | Requirement |
|---|---|
| FR-SAF-1 | Crisis detection: utterances indicating suicidal ideation, self-harm, or abuse route to the crisis protocol (§9.1) — gentle acknowledgment + crisis resources spoken **and** carded + suggestion to contact their person |
| FR-SAF-2 | Medical guardrail: requests for medication advice, dosing, or prognosis trigger a refusal + redirect to care team contact (spoken and carded) |
| FR-SAF-3 | All flagged sessions are marked in the transcript log for human review by the project owner |
| FR-SAF-4 | Safety content is always spoken AND shown. Never card-only, never spoken-only |

---

## 8. Card Taxonomy

| Type | Trigger | Example | Action |
|---|---|---|---|
| Actionable | Something with a verb | "Call the hospice nurse", "Appointment moved to Thursday" | Call / Acknowledge |
| Retained | Something to show someone later | Question list for Tuesday, visit summary, care log entry | Share link / Dismiss |
| Safety | Crisis resources, escalation confirmations | 988 + local resources | Acknowledge |
| Handoff (future) | Notes from care team | — (deferred) | — |

## 9. Safety & Escalation

### 9.1 Crisis protocol

1. Classifier (dedicated small prompt or rules) flags crisis utterances in-stream.
2. Turtle responds gently, validates, does not continue normal conversation.
3. Speaks crisis resources (988 Suicide & Crisis Lifeline; encourage contacting care team / trusted person).
4. Emits a safety card with the same resources (spoken AND shown).
5. Flags transcript for owner review.

### 9.2 Hard guardrails (refuse + redirect, never answer)

- Medication selection, dosing, timing advice, interactions
- Prognosis / life expectancy
- Symptom triage decisions
- Anything requiring a clinical license

Refusal template: acknowledge → state limit plainly → offer the care-team contact from profile → emit actionable card with that contact.

---

## 10. Non-Functional Requirements

| Category | Requirement |
|---|---|
| Latency | Voice response start (end-of-speech → first audio byte): target < 1.5s p50, < 2.5s p95 |
| Latency | Card render after spoken content: < 500ms |
| Interruption | Barge-in supported: user speech during TTS playback halts playback within 300ms |
| Availability | Personal project SLO: best effort; degrade gracefully to text-only mode if TTS/ASR fails |
| Privacy | Push-to-talk only; audio streamed, not persistently stored unless consented; transcripts stored locally-first |
| Data | All PHI encrypted at rest and in transit; LLM/ASR/TTS vendors under HIPAA-eligible/BAA terms if real users are ever onboarded |
| Accessibility | Large tap targets, readable type, full voice parity (anything doable by tap is doable by voice) |
| Honesty | Voice is clearly synthetic; no human voice cloning |

## 11. Success Metrics (project-level)

- Conversation quality: sessions reaching natural close vs. abandonment; interruption-handling rate
- Retrieval quality: % Q&A answers with grounded source vs. "don't know" rate (target: >90% grounded, hallucination near zero on eval set)
- Card correctness: cards match taxonomy rules; no cards emitted for conversational content
- Latency targets above
- Subjective: 2–3 real caregivers dogfood; measure SUS and one qualitative question — "Did you want to talk to it again tomorrow?"

## 12. Release Plan

| Milestone | Content |
|---|---|
| M1 (Week 1) | Voice pipeline: push-to-talk, streaming ASR, streaming TTS, barge-in, session lifecycle |
| M2 (Week 2) | Conversation modes: check-in, Q&A + RAG, guardrails, memory |
| M3 (Week 3) | Cards: taxonomy, emission, rendering, archive, voice retrieval; appointment prep; care log |
| M4 (Week 4) | Recap, crisis protocol, eval harness, polish, caregiver dogfood |

---

# PART 2 — HIGH-LEVEL TECHNICAL SPECIFICATION

## 13. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     CLIENT (Web App)                         │
│  Mic button · streaming audio · transcript · card surface    │
└──────────────┬──────────────────────────────────────────────┘
               │ WebSocket (audio up / audio+events down)
┌──────────────▼──────────────────────────────────────────────┐
│                   VOICE GATEWAY SERVICE                      │
│  Streaming ASR (Deepgram) · VAD · barge-in control ·        │
│  streaming TTS (ElevenLabs) · audio muxing                   │
└───────┬──────────────────────┬──────────────────────────────┘
        │ user text (final)    │ assistant text/events
┌───────▼──────────────────────▼──────────────────────────────┐
│              CONVERSATION ORCHESTRATOR                       │
│  Mode router · turn manager · safety classifier ·            │
│  memory assembly · card event emitter · session state        │
│  ┌─────────┐ ┌──────────┐ ┌────────────┐ ┌───────────────┐  │
│  │ Check-in│ │ Q&A/RAG  │ │ Care log   │ │ Appointment   │  │
│  │ prompt  │ │ retrieval│ │ extraction │ │ prep prompts  │  │
│  └─────────┘ └──────────┘ └────────────┘ └───────────────┘  │
└───┬──────────────┬──────────────┬───────────────┬───────────┘
    │              │              │               │
┌───▼────┐   ┌─────▼─────┐  ┌─────▼──────┐  ┌────▼─────────┐
│Safety /│   │Knowledge  │  │ Memory     │  │ Card          │
│Guardrail│  │Base (RAG) │  │Service     │  │Service (schema│
│layer   │   │(curated   │  │(profile,   │  │+ lifecycle)  │
│        │   │markdown)  │  │sessions,log)│  │              │
└────────┘   └───────────┘  └────────────┘  └──────────────┘
        │              │
┌───────▼──────────────▼──────────────────────────────────────┐
│              LLM PROVIDER (Claude/GPT API, BAA tier)         │
└─────────────────────────────────────────────────────────────┘
```

### Design decision: small routed prompts, not one god-prompt

Each conversation mode is a separate, small, testable prompt:

- `checkin.prompt` — supportive conversation, memory-aware, short turns
- `qa.prompt` — grounded answerer; must cite retrieval or decline
- `log.prompt` — extraction only: entry text → structured category + timestamp; zero interpretation
- `prep.prompt` — appointment briefing generator
- `safety.classifier` — crisis/medical-flag detection run on every user turn *before* mode routing
- `guardrail.refusal` — refusal + redirect composer

Routing is done by a lightweight classifier (rules + small model) on each user turn. This makes guardrails debuggable and evals per-mode.

## 14. Conversation State Machine

```
        ┌────────────┐
        │   IDLE     │  app open, mic armed
        └─────┬──────┘
              │ push-to-talk / wake greeting
        ┌─────▼──────┐
        │  LISTENING │  ASR streaming, VAD active
        └─────┬──────┘
              │ end-of-speech detected
        ┌─────▼──────┐
        │  THINKING  │  safety classify → route → mode prompt → LLM
        └─────┬──────┘
              │ response stream
        ┌─────▼──────┐        user speaks
        │  SPEAKING  │ ────────────────────────► back to LISTENING
        └─────┬──────┘      (barge-in, <300ms)
              │ utterance complete
        ┌─────▼──────┐
        │   WAITING  │  short silence → LISTENING; "goodbye" → CLOSING
        └─────┬──────┘
              │ session end
        ┌─────▼──────┐
        │  CLOSING   │  recap spoken + recap card → persist session
        └────────────┘
```

Key rules:
- Barge-in from SPEAKING always returns to LISTENING; never penalize interruption.
- Every LLM response is validated against mode-specific output contract (JSON schema) before TTS.
- Card events are emitted as part of the response contract, never inferred client-side.

## 15. Voice Pipeline

### 15.1 Up (user audio)

1. Browser captures 16kHz mono PCM via `getUserMedia`.
2. Push-to-talk: button down starts stream; button up (or endpointing) ends turn.
3. Stream over WebSocket to Voice Gateway.
4. Gateway forwards to Deepgram streaming ASR (`nova-3` or later, interim results on).
5. VAD endpointing (Deepgram built-in) decides end-of-speech → finalize turn.
6. Interim transcripts shown live in the client transcript pane (dimmed); finals committed.

### 15.2 Down (assistant audio)

1. Orchestrator returns validated response (text + card events + state).
2. Gateway sends text to ElevenLabs streaming TTS (single fixed voice; consistent character).
3. Audio chunks streamed to client and played; client simultaneously renders any cards only after the corresponding utterance completes.
4. Barge-in: client-side VAD during playback → send `interrupt` → gateway flushes TTS buffer → orchestrator notified (partial response discarded).

### 15.3 Failure degradation

- TTS down → text-only mode (response shown, spoken with browser fallback voice or silent).
- ASR down → typed input fallback (text-in, voice-out).
- LLM timeout (>8s) → graceful "let me think for a second" retry once, then apologize and park the turn.

## 16. Guardrail & Safety Pipeline

Every user turn passes through, in order:

1. **Safety classifier** (runs on raw text before any mode prompt):
   - Crisis flags (suicidal ideation, self-harm, abuse) → crisis protocol; bypass normal routing.
   - Medical-request flags (dosing, prognosis, triage) → guardrail refusal composer; bypass normal routing.
2. **Output validation**: each mode's response is parsed against its JSON contract (§17). Schema failure → regenerate once with repair instruction → else safe fallback line.
3. **Post-hoc checks** (Q&A mode only): every factual sentence must map to a retrieved chunk ID or be dropped; ungrounded answers replaced with "I don't know — ask your care team."
4. **Human review queue**: all flagged transcripts land in an owner review log with the flag, the turn, and the system's action.

LLM constraints: provider with BAA/HIPAA-eligible tier; no training on data; region pinning if available.

## 17. Response Contract (all modes)

```json
{
  "session_id": "uuid",
  "turn_id": "uuid",
  "state": "LISTENING|SPEAKING|WAITING|CLOSING",
  "say": "Spoken utterance text. Plain, short sentences.",
  "cards": [
    {
      "type": "actionable|retained|safety",
      "title": "Call the hospice nurse",
      "body": "Nausea question — ask about antiemetic adjustment",
      "action": { "kind": "call|link|acknowledge|share", "target": "tel:+1..." },
      "expires_at": "ISO8601|null"
    }
  ],
  "memory_ops": [
    { "op": "append_log", "category": "medication_given", "text": "...", "at": "ISO8601" },
    { "op": "set_fact", "key": "recurring_theme", "value": "..." }
  ],
  "flags": ["crisis|medical_refusal|none"]
}
```

The client renders nothing except `say` (TTS + transcript) and `cards` (card surface). All behavior flows from this contract.

## 18. Data Model

```
caregiver
  id, display_name, created_at, consent_at, prefs(json: voice_id, pace, checkin_time)

patient
  id, caregiver_id, name, diagnosis (enum), diagnosis_notes, care_team(json:
    { nurse_line, social_worker, oncologist, other[] })

appointment
  id, patient_id, title, with_whom, at, purpose, status (upcoming|done|cancelled)

log_entry
  id, patient_id, at, category (medication_given|symptom|sleep|food|event|note)
  text (verbatim), structured (json, optional)

session
  id, caregiver_id, started_at, ended_at, mode_transitions[], flags[],
  recap_card_id

turn
  id, session_id, seq, speaker (user|assistant), text, asr_conf,
  retrieved_chunk_ids[], flag, latency_ms

card
  id, session_id, type, title, body, action(json), status (active|dismissed|done),
  created_at

kb_chunk
  id, diagnosis, source_url, title, content_md, embedding_id
```

Storage: Postgres (or SQLite for local dev) for relational; object storage for audio artifacts if retained; vector index only over `kb_chunk` (small — pgvector suffices).

## 19. Memory & Context Assembly

Per turn, the orchestrator assembles:

- **Profile facts**: patient, diagnosis, care team contacts, upcoming appointment (next only).
- **Recent session themes**: last 3 sessions' summary lines (not full transcripts) to enable "last time you mentioned…".
- **Relevant log entries**: only when the mode calls for it (e.g., prep briefing may include "you noted a cough on Monday" — stated, not interpreted).
- **Retrieved KB chunks**: top-k (k=4) for Q&A mode only.

Hard rule: memory is surfaced as *recall*, never as *advice*.

## 20. Knowledge Base (RAG)

- Source: curated markdown per diagnosis (start with ONE diagnosis vertical, e.g., late-stage cancer). Seed from NCI patient materials and caregiver-specific content, rewritten into plain language with a clinician-review pass.
- Chunking: ~300-token sections, metadata `{diagnosis, source_url, title}`.
- Retrieval: embedding similarity + diagnosis filter; k=4.
- Answer contract: cite chunk IDs; no chunk → decline.
- Update path: content is files in repo → embedding job on deploy. No CMS needed for MVP.

## 21. Card Service & Client Surface

- Server-side: card events created in orchestrator contract; Card Service persists, manages lifecycle (active → dismissed/done → archived).
- Client: a single card surface component (bottom sheet / overlay). Rules:
  - Render only on `cards` events; max 1 active card at a time in MVP.
  - Appears after the corresponding utterance finishes playing.
  - Voice parity: "okay / done / dismiss / call" handled by the normal turn pipeline (no separate voice grammar).
  - Archive retrieval by voice via log/prep modes ("what were the questions for Tuesday?").

## 22. API & Realtime Protocol

### WebSocket (single connection per session)

Client → Server:
- `audio_chunk` (binary PCM)
- `turn_end` (button release / endpoint)
- `interrupt` (barge-in during playback)
- `text_input` (fallback)

Server → Client:
- `transcript_interim` / `transcript_final`
- `assistant_state` (LISTENING/THINKING/SPEAKING/CLOSING)
- `audio_chunk` (binary)
- `turn_contract` (the JSON contract, drives cards + memory ops on client)
- `error`

### REST (control plane)

- `POST /sessions`, `GET /sessions/:id`, `GET /sessions/:id/transcript`
- `GET /cards?status=archived`, `PATCH /cards/:id`
- `CRUD /patients, /appointments, /log-entries` (also voice-manageable, backed by same store)

## 23. Security & Privacy

- TLS everywhere; WebSocket over WSS.
- Auth: simple email magic link or local-only mode for personal project; design so a real auth provider can slot in.
- Encryption at rest for transcripts, log entries, contacts.
- Retention: audio discarded after transcription by default; transcripts retained; one-click "delete everything."
- No always-listening. No background recording. Mic indicator visible and honest.
- Vendor policy: ASR/LLM/TTS under terms prohibiting training on your data (BAA tier if real users onboard).
- If real caregivers ever dogfood with real PHI: minimal data collection review, consent copy vetted, and BAA-tier vendors mandatory.

## 24. Testing & Evaluation

| Layer | Method |
|---|---|
| ASR/TTS | Sample clips incl. elderly voices, accents, emotional speech, noisy rooms; measure WER and latency |
| Barge-in | Scripted interruption suite; assert <300ms halt and correct state transition |
| Guardrails | Adversarial eval set: 50+ medication/prognosis/triage probes (must refuse+redirect 100%); 30+ crisis probes (must trigger protocol 100%); 50+ benign-but-medical-adjacent (must not over-refuse) |
| Q&A grounding | Golden question set per diagnosis; score grounded-citation rate and hallucination rate |
| Conversation quality | Rubric-scored transcripts (warmth, brevity, no platitudes, no advice creep); regression suite per prompt change |
| Cards | Unit tests on taxonomy rules; no-card sessions render no cards |
| E2E | Playwright: scripted sessions through all modes incl. interrupt, crisis, refusal, recap |

Eval harness is a first-class build item (M4), not an afterthought — it is the only way prompt changes stay safe.

## 25. Observability (lightweight)

- Structured logs per turn: latency breakdown (ASR → classify → LLM → TTS), flags, mode transitions, card emissions.
- Session traces reviewable (owner reads early transcripts — human-in-the-loop by design).
- Simple metrics dashboard: sessions/day, p50/p95 response latency, refusal/crisis counts, grounded-answer rate.

## 26. Tech Stack Summary

| Layer | Choice | Notes |
|---|---|---|
| Client | Next.js (React) + Web Audio API | Web-first; mic via getUserMedia |
| Realtime | WebSocket (ws / PartyKit-style) | Single duplex channel per session |
| ASR | Deepgram streaming | Interim results, built-in VAD/endpointing |
| TTS | ElevenLabs streaming | One fixed voice; clearly synthetic |
| Orchestration | Node (TypeScript) services | Orchestrator + Voice Gateway separate processes |
| LLM | Claude/GPT API (BAA/no-training tier) | Small routed prompts per mode |
| Safety | Dedicated classifier prompt + rules | Runs before routing, every turn |
| Retrieval | pgvector over curated markdown | k=4, diagnosis-filtered |
| Store | Postgres (+ object storage optional) | All entities in §18 |
| Auth | Local-only / magic link for project | Pluggable |
| Deploy | Single VPS or Vercel + managed Postgres | Project-scale |

## 27. Build Plan (4 weeks, solo)

| Week | Deliverables | Exit criteria |
|---|---|---|
| 1 | Voice gateway + client audio + state machine + barge-in | Natural 3-minute voice session with interruption handling; latency p50 < 1.5s |
| 2 | Safety classifier, mode router, check-in prompt, Q&A + RAG, memory assembly | Refusal suite 100%; grounded answers on golden set; "last time you mentioned…" works |
| 3 | Card contract + surface + archive + voice retrieval; appointment prep; care log extraction | Cards meet taxonomy; voice-retrievable archive; prep briefing generated from real appointment |
| 4 | Recap, crisis protocol end-to-end, eval harness, polish, dogfood | Full scripted E2E green; 2–3 caregivers try it; latencies and quality metrics reviewed |

## 28. Key Risks & Open Questions

| Risk | Mitigation |
|---|---|
| ASR quality with elderly/emotional speakers | Early testing with real voices (week 1); allow short retry prompts; keep turns short |
| Hallucination in Q&A | Citation-or-decline contract; golden-set gating on every prompt change |
| Over-refusal hurting trust | Balanced adversarial set; refusals always end with a constructive redirect |
| Caregiver expectation creep ("just tell me the dose") | Consistent persona copy; refusal phrasing warm but absolute |
| Scope creep back toward business features | This document's non-goals are binding for MVP; revisiting requires explicit decision |
| Emotional weight of dogfooding | Owner self-care plan; clear "project, not a provider" framing with testers |

### Open questions

1. Diagnosis vertical for MVP (recommend one: e.g., metastatic cancer) — drives the knowledge base seed.
2. Voice character finalization (voice casting + persona copy sheet) — do once, freeze for MVP.
3. Local-only vs cloud deployment for transcripts (privacy stance).
4. Whether recap cards should be persisted long-term or session-scoped (recommend: persist; they become the caregiver's artifact).
