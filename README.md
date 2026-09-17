# Turtle

A voice-first companion for a caregiver of someone with terminal illness. Turtle is software,
never a person. Voice is the medium; cards are artifacts.

See `.kiro/specs/turtle/` for the requirements, design, and phased implementation plan, and
`.kiro/steering/` for the product, safety, and technical standards.

## Structure

```
apps/web       Next.js client — mic control + transcript + single card surface
apps/server    Node/TypeScript backend — Voice Gateway + Orchestrator + store (single service)
packages/shared  Shared types: the response contract (the spine), WS messages, data model
kb/            Curated knowledge base markdown (RAG source), added in Phase 2
```

## Getting started

Requires Node >= 20.

```bash
npm install
cp .env.example .env    # optional — the app boots with ZERO keys (degraded mode)
npm run dev             # runs server (:8787) and web (:3000) together
```

Open http://localhost:3000.

### Degraded mode

Turtle runs without any API keys. Each missing provider falls back:

| Missing key | Fallback |
|---|---|
| `DEEPGRAM_API_KEY` | Typed text input (voice input off) |
| `ELEVENLABS_API_KEY` | Text-only (no spoken voice) |
| `ANTHROPIC_API_KEY` | Canned orchestrator replies |
| `OPENAI_API_KEY` | Lexical (keyword) retrieval over the KB |
| `GEMINI_API_KEY` | Live trusted-resource search is unavailable; normal local KB still works |

`GET /health` reports which capabilities are live vs degraded.

### Voice diagnostics

The local app emits privacy-safe structured voice diagnostics in both consoles by
default. Browser events use the `[turtle:voice]` prefix; server events are JSON lines
whose `evt` starts with `voice_`. Logs contain lifecycle events, state, byte/chunk
counts, timing, and provider status—never audio samples, API keys, patient names, or
transcript text.

For a healthy spoken turn, look for this sequence:

```text
voice_microphone_capture_start_requested
voice_pcm_capture_started
voice_audio_uplink_started
voice_gateway_audio_received
voice_gateway_turn_end
voice_asr_finalize_sent
voice_asr_transcript_final
voice_session_asr_final_received
```

The first missing event identifies the failed boundary. Set `TURTLE_VOICE_DEBUG=0`
for the server and/or `NEXT_PUBLIC_VOICE_DEBUG=0` for the web app to disable these
diagnostics. Restart the corresponding process after changing either value.

### Trusted caregiver resources

When a caregiver explicitly asks Turtle to find support groups, financial help,
transportation, lodging, respite care, or other caregiver resources, the server uses
Gemini Search grounding and shows up to three cited links from an approved US source
policy. For a local request, Turtle asks for a city or ZIP and uses it only for that
search; it is not saved in the care profile. Set `GEMINI_SEARCH_MODEL` only if you
need a search-grounding model different from `GEMINI_MODEL`.

## Scripts

```bash
npm run dev         # server + web together
npm run dev:server  # server only
npm run dev:web     # web only
npm run typecheck   # typecheck all workspaces
npm run test        # unit tests (Vitest)
npm run lint        # eslint
npm run format      # prettier
```

## Build phases

- **Phase 0 — Foundation** (current): runnable monorepo, config/degradation, SQLite store, client shell, health + REST control plane.
- **Phase 1 — Voice pipeline**: push-to-talk, streaming ASR, streaming TTS, barge-in, session state machine.
- **Phase 2 — Conversation**: safety classifier, mode router, check-in, Q&A + RAG, memory, contract validation.
- **Phase 3 — Artifacts**: cards, care log, appointment prep.
- **Phase 4 — Safety & hardening**: crisis protocol, recap, eval harness, observability, polish.
