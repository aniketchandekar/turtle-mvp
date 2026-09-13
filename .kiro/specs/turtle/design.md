# Turtle — Design

## Overview

Turtle is a voice-first caregiver companion delivered as a web application. The design follows
the PRD's core philosophy: **voice is the medium, cards are artifacts.** The client is a thin
surface (microphone + transcript + at most one card). All intelligence — safety classification,
mode routing, retrieval, memory, and the card contract — lives server-side and flows to the
client through a single validated JSON response contract per turn.

This design targets the MVP defined in the requirements and is structured to be delivered in
five phases (0–4). It intentionally makes pragmatic, personal-project-scale choices while
leaving seams for the production posture the PRD describes (BAA-tier vendors, Postgres,
pluggable auth).

### Confirmed technical decisions

| Decision | Choice | Rationale |
|---|---|---|
| Repo layout | npm workspaces monorepo | Simple, no extra tooling; splits later if needed |
| Backend topology | **Single Node/TypeScript service** combining Voice Gateway + Orchestrator | Fewer moving parts for a solo MVP; internal module boundaries preserve the logical split from the PRD so they can be separated later |
| Client | Next.js (React) + Web Audio API | Per spec; web-first |
| Realtime | Single WebSocket per session (`ws` library) | Duplex audio up / audio+events down |
| ASR | Deepgram streaming (`nova-3`) | Per spec; interim results + built-in VAD |
| TTS | ElevenLabs streaming, `eleven_flash_v2_5`, PCM output, flush-per-turn | Per ElevenLabs reference §15 |
| LLM | Anthropic Claude (default), provider-abstracted | Per spec ("Claude/GPT"); abstraction allows GPT swap |
| Store | **SQLite** (via `better-sqlite3`) for local dev; schema written to migrate to Postgres | Frictionless personal-project setup |
| Vectors | In-process cosine similarity over embedded KB chunks (KB is small) | Avoids pgvector dependency for MVP; swap to pgvector on Postgres migration |
| Auth | Local single-user (no login) for MVP; auth seam left in place | Personal project |
| Degradation | Every external provider has a mock/fallback path | App runs with zero API keys |

### Graceful degradation matrix

| Missing key | Behavior |
|---|---|
| Deepgram | Typed text input (text-in), voice-out still works if TTS present |
| ElevenLabs | Text-only mode: response shown in transcript, optional browser SpeechSynthesis fallback |
| LLM | Canned/echo orchestrator responses so the pipeline and cards can be exercised in dev |
| Embeddings | Lexical (keyword) retrieval fallback over KB chunks |

---

## Architecture

### System context

```
┌───────────────────────────────────────────────────────────┐
│                    CLIENT (Next.js)                        │
│  Mic (push-to-talk) · Web Audio playback · transcript ·    │
│  single card surface · barge-in VAD                        │
└───────────────┬───────────────────────────────────────────┘
                │  WebSocket (WSS)
                │  up:  audio_chunk / turn_end / interrupt / text_input
                │  down: transcript_* / assistant_state / audio_chunk / turn_contract / error
┌───────────────▼───────────────────────────────────────────┐
│              BACKEND SERVICE (Node/TypeScript)             │
│                                                            │
│  ┌──────────────── Voice Gateway module ───────────────┐  │
│  │ WS server · session socket · Deepgram ASR client ·   │  │
│  │ ElevenLabs TTS client · audio mux · barge-in control │  │
│  └───────────────┬──────────────────────┬───────────────┘  │
│                  │ final user text       │ say text + audio  │
│  ┌───────────────▼──────────────────────┴───────────────┐  │
│  │              Orchestrator module                      │  │
│  │  safety classifier → mode router → mode prompt →      │  │
│  │  LLM → contract validation → memory ops → card events │  │
│  └──┬────────┬──────────┬───────────┬────────────────────┘  │
│     │        │          │           │                       │
│  ┌──▼──┐ ┌───▼────┐ ┌───▼────┐ ┌────▼─────┐                 │
│  │Guard│ │  RAG   │ │ Memory │ │  Card    │                 │
│  │rails│ │ (KB +  │ │ service│ │ service  │                 │
│  │     │ │ vector)│ │        │ │(lifecycle)│                │
│  └─────┘ └────────┘ └────────┘ └──────────┘                 │
│                          │                                  │
│                    ┌─────▼─────┐        ┌──────────────┐    │
│                    │  SQLite   │        │ LLM provider │    │
│                    │  store    │        │ (Claude/GPT) │    │
│                    └───────────┘        └──────────────┘    │
└────────────────────────────────────────────────────────────┘
```

### Module boundaries (single process, logical split)

- `packages/shared` — TypeScript types for the response contract, WS messages, data model, and config; shared by client and server.
- `apps/server/gateway` — WebSocket server, ASR client, TTS client, audio muxing, barge-in.
- `apps/server/orchestrator` — safety classifier, mode router, per-mode prompt runners, contract validator.
- `apps/server/services` — memory, RAG, cards, store, LLM provider adapter.
- `apps/web` — Next.js client: mic capture, playback, transcript, card surface.

### Turn flow (happy path)

1. Client streams `audio_chunk` while push-to-talk held; sends `turn_end` on release.
2. Gateway pipes audio to Deepgram; emits `transcript_interim` to client, commits a `transcript_final`.
3. Gateway hands final user text to Orchestrator; sets `assistant_state = THINKING`.
4. Orchestrator runs safety classifier → routes to a mode → assembles memory/context → calls LLM → validates the JSON contract.
5. Orchestrator returns `{ say, cards, memory_ops, flags, state }`; applies `memory_ops`; persists cards/turn.
6. Gateway streams `say` to ElevenLabs sentence-by-sentence with `flush:true` on the final sentence; forwards audio chunks to client; sets `assistant_state = SPEAKING`.
7. Gateway sends `turn_contract` to client; client renders each card only after its corresponding utterance finishes playing.
8. On barge-in, client sends `interrupt`; gateway flushes TTS, discards remaining audio, returns to LISTENING.

---

## Components and Interfaces

### Realtime protocol (WebSocket)

One connection per session, kept open for the whole 5–10 minute session (matching the
ElevenLabs guidance to avoid per-turn reconnects).

**Client → Server**

| Message | Payload | Notes |
|---|---|---|
| `audio_chunk` | binary PCM (16kHz mono) | Only while push-to-talk engaged |
| `turn_end` | `{}` | Button release / endpoint |
| `interrupt` | `{}` | Barge-in during playback |
| `text_input` | `{ text }` | Fallback when ASR unavailable |
| `card_action` | `{ card_id, kind }` | Tap parity for a card action (voice path goes through normal turn) |

**Server → Client**

| Message | Payload | Notes |
|---|---|---|
| `transcript_interim` | `{ text }` | Dimmed live transcript |
| `transcript_final` | `{ text }` | Committed user turn |
| `assistant_state` | `{ state }` | LISTENING / THINKING / SPEAKING / WAITING / CLOSING |
| `audio_chunk` | binary PCM | TTS audio |
| `turn_contract` | JSON (see §Response contract) | Drives cards + memory on client |
| `error` | `{ code, message, degraded? }` | Includes degradation notices |

### REST control plane

- `POST /sessions`, `GET /sessions/:id`, `GET /sessions/:id/transcript`
- `GET /cards?status=archived`, `PATCH /cards/:id` (dismiss/done)
- `CRUD /patients`, `/appointments`, `/log-entries` (same store the voice path writes to)
- `GET /health` (reports which providers are live vs degraded)

### Response contract (all modes)

The single source of truth for a turn. Validated with a JSON schema (Zod) before TTS.

```json
{
  "session_id": "uuid",
  "turn_id": "uuid",
  "state": "LISTENING | SPEAKING | WAITING | CLOSING",
  "say": "Spoken utterance text. Plain, short sentences.",
  "cards": [
    {
      "type": "actionable | retained | safety",
      "title": "Call the hospice nurse",
      "body": "Nausea question — ask about antiemetic adjustment",
      "action": { "kind": "call | link | acknowledge | share", "target": "tel:+1..." },
      "expires_at": "ISO8601 | null"
    }
  ],
  "memory_ops": [
    { "op": "append_log", "category": "medication_given", "text": "...", "at": "ISO8601" },
    { "op": "set_fact", "key": "recurring_theme", "value": "..." }
  ],
  "flags": ["crisis | medical_refusal | none"]
}
```

Validation rules:
- `say` required, non-empty (except pure CLOSING recap which still speaks).
- `cards` max length 1 active in MVP; each card body ≤ ~3 lines; ≤ 1 action.
- `flags` drives owner-review marking and card-only/spoken-only safety enforcement.
- Schema failure → one repair regeneration → else safe fallback line + empty cards.

### Orchestrator: small routed prompts

Per PRD, no god-prompt. Each mode is a separate small prompt with its own output contract and
its own eval set.

| Prompt file | Responsibility |
|---|---|
| `safety.classifier` | Runs first on raw text every turn; returns `{ crisis, medical, none }` |
| `checkin.prompt` | Supportive, memory-aware, short turns; ≤1 coping suggestion/session |
| `qa.prompt` | Grounded answerer; cite retrieved chunk IDs or decline |
| `log.prompt` | Extraction only: utterance → structured entries; zero interpretation |
| `prep.prompt` | Appointment briefing generator (purpose, what to report, questions) |
| `guardrail.refusal` | Refusal + redirect composer for medical requests |
| `recap.prompt` | Session recap composer for CLOSING |

### Mode router

Lightweight rules + a small classification call:
1. Safety classifier first. Crisis → crisis protocol. Medical → guardrail refusal. (Both bypass normal routing.)
2. Otherwise classify intent: log-dictation vs. diagnosis-question vs. appointment-retrieval/prep vs. general check-in.
3. Cheap rules catch obvious cases (e.g., "gave the … meds", "what were the questions for") before spending an LLM call.

### RAG subsystem

- KB source: curated markdown files under `kb/<diagnosis>/*.md`. **MVP seeds one diagnosis vertical (metastatic cancer)** per the PRD open-question recommendation.
- Chunking: ~300-token sections; metadata `{ diagnosis, source_url, title }`.
- Embedding: provider embeddings when available; build step writes vectors to the store. Lexical fallback when no embedding provider.
- Retrieval: cosine similarity + diagnosis filter, k=4.
- Answer contract: `qa.prompt` must reference retrieved chunk IDs. Post-hoc check drops ungrounded sentences; fully ungrounded answer → decline line.

### Memory service

Per-turn context assembly (recall, never advice):
- Profile facts: patient, diagnosis, care-team contacts, next upcoming appointment only.
- Last 3 session summary lines (not transcripts).
- Relevant log entries only when the active mode requests them.
- KB chunks (k=4) for Q&A mode only.

### Card service

- Cards are created only from the orchestrator contract (never inferred client-side).
- Lifecycle: `active → dismissed | done → archived`.
- Client renders after the corresponding utterance finishes; max one active card.
- Archive retrieval flows back through the log/prep modes by voice.

### Voice pipeline details

**Up:** browser captures 16kHz mono PCM via `getUserMedia` + AudioWorklet; push-to-talk gates
capture; stream over WS; gateway → Deepgram streaming with interim results; VAD endpointing
finalizes the turn.

**Down:** orchestrator `say` streamed sentence-by-sentence to ElevenLabs WS
(`eleven_flash_v2_5`, `pcm_16000`, voice settings `stability 0.5 / similarity_boost 0.8 /
use_speaker_boost false / speed 1.0`, `chunk_length_schedule [120,160,250,290]`, `flush:true`
on the last sentence, `{"text":" "}` keepalive between turns). Audio chunks streamed to client;
player buffer tuned to ~150–250ms. Static strings (AI disclosure, greeting, crisis lines,
recap) pre-rendered via ElevenLabs HTTP streaming for sub-100ms availability.

**Barge-in:** client VAD during playback → `interrupt` → gateway flushes TTS buffer and stops
forwarding audio → orchestrator discards partial response → state returns to LISTENING within
300ms; interruption is never penalized.

---

## Data Models

SQLite for MVP; column choices keep a clean path to Postgres + pgvector.

```
caregiver
  id TEXT PK, display_name TEXT, created_at TEXT, consent_at TEXT,
  prefs JSON            -- { voice_id, pace, checkin_time }

patient
  id TEXT PK, caregiver_id TEXT FK, name TEXT,
  diagnosis TEXT,       -- enum
  diagnosis_notes TEXT,
  care_team JSON        -- { nurse_line, social_worker, oncologist, other[] }

appointment
  id TEXT PK, patient_id TEXT FK, title TEXT, with_whom TEXT,
  at TEXT, purpose TEXT, status TEXT   -- upcoming | done | cancelled

log_entry
  id TEXT PK, patient_id TEXT FK, at TEXT,
  category TEXT,        -- medication_given | symptom | sleep | food | event | note
  text TEXT,            -- verbatim
  structured JSON       -- optional

session
  id TEXT PK, caregiver_id TEXT FK, started_at TEXT, ended_at TEXT,
  mode_transitions JSON, flags JSON, recap_card_id TEXT

turn
  id TEXT PK, session_id TEXT FK, seq INT, speaker TEXT,   -- user | assistant
  text TEXT, asr_conf REAL, retrieved_chunk_ids JSON,
  flag TEXT, latency_ms INT

card
  id TEXT PK, session_id TEXT FK, type TEXT, title TEXT, body TEXT,
  action JSON, status TEXT,   -- active | dismissed | done
  created_at TEXT

kb_chunk
  id TEXT PK, diagnosis TEXT, source_url TEXT, title TEXT,
  content_md TEXT, embedding BLOB   -- vector; null when lexical fallback
```

Storage posture: transcripts/log entries/contacts encrypted at rest; captured audio discarded
after transcription by default; one-click "delete everything" endpoint.

---

## Error Handling

| Failure | Detection | Response |
|---|---|---|
| ASR down | Deepgram connect/stream error | Switch session to text-in; notify client via `error{degraded}` |
| TTS down | ElevenLabs connect/stream error | Text-only mode; optional browser SpeechSynthesis; response still shown |
| LLM timeout (>8s) | Orchestrator timer | One "let me think for a second" retry; then apologize and park the turn |
| Contract schema failure | Zod parse | One repair regeneration; then safe fallback line, no cards |
| Ungrounded Q&A | Post-hoc grounding check | Drop ungrounded sentences; if none grounded, decline line |
| WS disconnect | Socket close | Client auto-reconnects, resumes session by id; audio buffer reset |
| Barge-in mid-stream | Client VAD → `interrupt` | Flush TTS, discard partial, return to LISTENING |

Safety-first defaults: any uncertainty in the safety classifier biases toward flagging;
guardrail refusals and crisis responses are always both spoken AND carded.

---

## Testing Strategy

Aligned with PRD §24; the eval harness is a first-class Phase 4 deliverable, with unit tests
landing alongside each phase.

| Layer | Method | Phase |
|---|---|---|
| Contract validation | Unit tests on the Zod schema and repair path | 2 |
| Safety guardrails | Adversarial set: 50+ medical probes (100% refuse+redirect), 30+ crisis probes (100% protocol), 50+ benign-adjacent (no over-refusal) | 2 seed → 4 full |
| Q&A grounding | Golden question set per diagnosis; grounded-citation rate + hallucination rate | 2 seed → 4 full |
| Barge-in | Scripted interruption suite; assert <300ms halt and correct state transition | 1 |
| Cards | Unit tests on taxonomy rules; assert no-card sessions render no cards | 3 |
| Conversation quality | Rubric-scored transcripts (warmth, brevity, no advice creep) | 4 |
| E2E | Playwright scripted sessions through all modes incl. interrupt, crisis, refusal, recap | 4 |
| Latency | Per-turn structured timing (ASR → classify → LLM → TTS); assert p50 < 1.5s | 1 seed → 4 review |

---

## Observability

- Structured per-turn log: latency breakdown, flags, mode transitions, card emissions.
- Session traces reviewable by the owner (human-in-the-loop by design); flagged turns marked.
- Lightweight metrics: sessions/day, p50/p95 response latency, refusal/crisis counts, grounded-answer rate.

---

## Security & Privacy

- WSS/TLS everywhere.
- Encryption at rest for transcripts, log entries, contacts.
- Push-to-talk only; honest, visible mic indicator; no background recording.
- Audio discarded after transcription by default; transcripts retained; one-click delete-all.
- Vendor posture documented so BAA-tier vendors and no-training terms can be enforced before any real caregiver dogfoods with real PHI.
- Auth is local-only for MVP with a pluggable seam (magic link / provider) for later.
- Implemented posture + enforcing code documented in `apps/server/PRIVACY.md` (audio-discard,
  encryption-at-rest coverage, TLS/WSS, one-click `DELETE /everything`).

---

## Phase → Requirement traceability

| Phase | Delivers requirements |
|---|---|
| 0 — Foundation | R1, and the storage/privacy seams of R16 |
| 1 — Voice pipeline | R2, R3, R4, latency/barge-in parts of R16 |
| 2 — Conversation intelligence | R5 (seed), R6, R7, R8, R9 |
| 3 — Artifacts | R10, R11, R12 |
| 4 — Safety & hardening | R5 (full), R13, R14, R15, remaining R16, consent/AI-disclosure |
