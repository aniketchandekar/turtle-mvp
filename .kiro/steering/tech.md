# Turtle — Technical Standards (frozen for MVP)

These stack and architecture decisions are frozen for the MVP. Do not reintroduce alternatives
mid-build without an explicit decision to change them.

## Stack

| Layer | Choice |
|---|---|
| Repo | npm workspaces monorepo: `apps/web`, `apps/server`, `packages/shared` |
| Backend | Single Node/TypeScript service; internal modules `gateway`, `orchestrator`, `services` (kept separable) |
| Client | Next.js (React) + Web Audio API |
| Realtime | Single WebSocket per session (`ws`), kept open for the whole session |
| ASR | Deepgram streaming (`nova-3`), interim results + built-in VAD endpointing |
| TTS | ElevenLabs streaming, `eleven_flash_v2_5`, PCM output, flush-per-turn |
| LLM | Anthropic Claude default, behind a provider abstraction (GPT-swappable) |
| Store | SQLite (`better-sqlite3`); schema kept Postgres-migratable |
| Vectors | In-process cosine similarity over embedded KB chunks; pgvector on Postgres migration |
| Auth | Local single-user for MVP; pluggable seam left in place |
| Tests | Vitest for unit; Playwright for E2E |

## Architectural invariants

- **The JSON response contract is the spine.** Every assistant turn conforms to it
  (`session_id, turn_id, state, say, cards, memory_ops, flags`). The client renders only `say`
  and `cards`. Cards and memory ops flow only from this contract.
- **Small routed prompts, not a god-prompt.** Each mode (checkin, qa, log, prep) and the safety
  classifier and guardrail refusal are separate, small, individually testable prompts.
- **Validate before speaking.** Every response is parsed against its Zod schema before TTS.
  Schema failure → one repair regeneration → else a safe fallback line with no cards.
- **Contract-driven, not inference-driven.** Never infer cards, memory, or safety behavior on the
  client.

## ElevenLabs TTS presets (frozen)

- Model `eleven_flash_v2_5`; output `pcm_16000` (or `pcm_24000`); one fixed voice, chosen once.
- Voice settings: `stability 0.5`, `similarity_boost 0.8`, `use_speaker_boost false`, `speed 1.0`.
- `chunk_length_schedule [120,160,250,290]`; `flush:true` on the final sentence of every turn.
- Keepalive between turns with `{"text":" "}` (a single space); never `""` (that closes the socket).
- Keep the WS connection open across turns (no per-turn reconnect).
- Pre-render static strings (AI disclosure, greeting, crisis lines, recap) via HTTP streaming.
- `optimize_streaming_latency` is deprecated — do not use it.
- Never expose the API key to the client; the Voice Gateway holds it (single-use tokens for any
  client-initiated connection).

## Latency & degradation

- Targets: end-of-speech → first audio byte < 1.5s p50 / < 2.5s p95; card render < 500ms after
  speech; barge-in halt < 300ms.
- Player buffer ~150–250ms (not the 500ms default).
- Every external provider has a fallback: no Deepgram → text-in; no ElevenLabs → text-only; no
  LLM → canned responses; no embeddings → lexical retrieval. The app must boot with zero keys.

## Privacy posture

- WSS/TLS everywhere. Encryption at rest for transcripts, log entries, contacts.
- Push-to-talk only; honest visible mic indicator; no background recording.
- Discard captured audio after transcription by default. One-click delete-everything.
