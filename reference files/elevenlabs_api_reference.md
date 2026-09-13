# ElevenLabs API Reference — for the Turtle Project

**Purpose:** Detailed working reference for using ElevenLabs as Turtle's Text-to-Speech layer
(Voice Gateway → ElevenLabs → browser playback), compiled from the official ElevenLabs
documentation and Pipecat's integration patterns.

---

## How to Use This Document (Agent Instructions)

1. **This file is a compiled reference, not the source of truth.** It summarizes the ElevenLabs
   documentation pages listed in §17. When you need parameter-level detail, current defaults,
   enums, error codes, or anything not fully spelled out here: **open the relevant source URL
   from §17 before answering or writing code.** Never guess API parameters from memory.
2. **Navigate by section:** §1 orientation · §3–5 models, voices, formats · §6–8 endpoint
   references · §9 latency · §11 pronunciation dictionaries · §15 Turtle presets · §16 gotchas.
   Read the whole file once before building; afterwards use it as a lookup.
3. **Turtle-specific decisions are marked as such** (e.g., `eleven_flash_v2_5` frozen, PCM
   output, flush-per-turn). Treat these as binding defaults unless the user explicitly overrides.
4. **Code examples here are illustrative.** Before shipping, verify against the live API
   reference page (§17) — ElevenLabs deprecates parameters and changes tier gating without
   notice (see gotcha #1 in §16).
5. **If anything in this file conflicts with the official docs, the official docs win** —
   flag the discrepancy to the user and update this file.

**Sources used:**
- Realtime TTS WebSocket guide — https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts
- TTS WebSocket API reference — https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input
- HTTP streaming API reference — https://elevenlabs.io/docs/api-reference/text-to-speech/stream
- Multi-Context WebSocket reference — https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input
- Latency optimization guide — https://elevenlabs.io/docs/eleven-api/guides/how-to/best-practices/latency-optimization
- Understanding latency — https://elevenlabs.io/docs/eleven-api/concepts/latency
- TTS capabilities overview — https://elevenlabs.io/docs/overview/capabilities/text-to-speech
- Streaming TTS guide — https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/streaming
- Scribe Realtime STT reference — https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
- Pipecat ElevenLabs service — https://docs.pipecat.ai/api-reference/server/services/tts/elevenlabs

---

## 1. Orientation: where ElevenLabs sits in Turtle

```
Orchestrator (Claude/GPT, validated JSON contract)
        │  "say" text, streamed progressively (sentence by sentence)
        ▼
Voice Gateway (Node/TS) ──► ElevenLabs TTS
        │  base64 audio chunks
        ▼
Client (Web Audio API playback + barge-in VAD)
```

ElevenLabs is a **component, not the platform**: your guardrails, card taxonomy, mode routing,
and safety classifier stay upstream. ElevenLabs receives only final, validated, speakable text.

### Choosing an endpoint (decision matrix)

| Situation | Endpoint |
|---|---|
| Real-time conversation (LLM streaming text progressively) | **WebSocket** `/v1/text-to-speech/{voice_id}/stream-input` |
| Full text known upfront (onboarding phrases, recap cards pre-rendered) | **HTTP streaming** `GET /v1/text-to-speech/{voice_id}/stream` — lower latency than WS for complete text |
| Concurrent/interleaved audio streams (sound effects over speech, two speakers) | **Multi-Context WebSocket** `/v1/text-to-speech/{voice_id}/multi-stream-input` |
| Prototyping / experiments | HTTP non-streaming `POST /v1/text-to-speech/{voice_id}` |

Turtle primarily uses **WebSocket**; HTTP streaming is an optimization for pre-rendered content.

---

## 2. Authentication

- Header: `xi-api-key: <API_KEY>` on the WebSocket handshake (or as the first message field `xi_api_key`).
- Client-side connections should use **single-use tokens** (query param `single_use_token` /
  `token`) instead of exposing the API key in the browser. Generate via the single-use token endpoint.
- Never ship the master API key to the client. Turtle's Voice Gateway holds the key.

---

## 3. Models

| Model | Latency | Quality | Languages | Notes |
|---|---|---|---|---|
| `eleven_flash_v2_5` | ~75ms inference | Slight quality trade-off | 32 (incl. Hungarian, Norwegian, Vietnamese) | **Turtle default.** Accepts `language_code`. Recommended for real-time |
| `eleven_turbo_v2_5` | Low | Better than Flash | 32 | Accepts `language_code` |
| `eleven_multilingual_v2` | Higher | Highest quality, most nuanced | 29 | Does **not** accept `language_code` (auto-detected); not for real-time |
| `eleven_v3` / `eleven_v3_conversational` | Highest | Rich, emotional, 74 languages | 74 | Only reachable via the **Text-to-Dialogue** (multi-context-style) endpoint; inline audio tags like `[laughs]` |

**Key facts:**
- The ~75ms Flash figure is **model inference only**, not end-to-end latency (see §9).
- There is no way to get v3 quality at Flash speed — it is an architectural trade-off, not a tuning problem. If Turtle needs both low latency and high emotional quality, Flash v2.5 with a well-chosen voice is the current ceiling.
- List models via `GET /v1/models` (filter `can_do_text_to_speech`).

**Turtle decision:** `eleven_flash_v2_5`, frozen for MVP. One voice, chosen once, never swapped mid-relationship.

---

## 4. Voices & Voice Settings

Voice options: Voice Library (3,000+ community voices), Professional Voice Clones (PVC),
Instant Voice Clones (IVC), Voice Design (text-described custom voices). Note: the Voice
Library is not available via API to free-tier users.

### Voice settings object (per-request or per-message override)

| Param | Range | Effect |
|---|---|---|
| `stability` | 0.0–1.0 | Low = more expressive/varied; high = more consistent/flat. For v3 dialogue: 0.0 can hallucinate, 0.5 closest to reference, 1.0 most consistent |
| `similarity_boost` | 0.0–1.0 | Clarity/similarity to reference voice |
| `style` | 0.0–1.0 | Style exaggeration; higher amplifies the voice's character |
| `use_speaker_boost` | bool | Enhances clarity and speaker similarity |
| `speed` | WS: 0.7–1.2; HTTP: 0.25–4.0 | Speech rate |

**Latency ordering of voice types (fastest → slowest):** Default (premade) / Synthetic / IVC → PVC.
For strict latency + quality goals, Flash + default/synthetic/IVC voice beats Flash + PVC.

**Turtle starting point:** `stability: 0.5`, `similarity_boost: 0.8`, `use_speaker_boost: false`,
`speed: 1.0` — then tune by listening with real session scripts. Turtle's voice must sound
calm and consistent, not theatrical.

---

## 5. Output Formats

Format string: `codec_sample_rate_bitrate` (e.g., `mp3_22050_32`).

| Codec | Options | Notes |
|---|---|---|
| MP3 | 22.05–44.1kHz; 32–192kbps | Default `mp3_44100_128`. 192kbps needs Creator tier+ |
| PCM (S16LE) | 16kHz–48kHz | 44.1kHz PCM needs Pro tier+. Best for direct Web Audio playback |
| μ-law / A-law | 8kHz | Telephony (Twilio) — irrelevant for Turtle since telephony is out of scope |
| Opus | 48kHz, 32–192kbps | Efficient for browser streaming |

**Turtle recommendation:** `pcm_16000` or `pcm_24000` for playback (no decode step, lower
perceived latency; raw PCM decodes instantly in Web Audio). MP3 adds decode latency. If
bandwidth matters more than decode, use Opus.

---

## 6. Endpoint A — HTTP Streaming (for complete text)

`GET /v1/text-to-speech/{voice_id}/stream` — SSE-style progressive audio; full request body
at once. Lower latency than WebSocket when the text is fully known upfront.

### Query parameters

| Param | Type | Default | Notes |
|---|---|---|---|
| `output_format` | enum | `mp3_44100_128` | See §5 |
| `enable_logging` | bool | `true` | `false` = zero-retention mode (**Enterprise only**) |
| `optimize_streaming_latency` | int 0–4 | null | **DEPRECATED** — do not use. Replaced by model choice + WS streaming + chunk schedule |

### Request body

| Field | Type | Notes |
|---|---|---|
| `text` | string (required) | |
| `model_id` | string | Default `eleven_multilingual_v2` — **always set `eleven_flash_v2_5` for Turtle** |
| `language_code` | string | Ignored by `multilingual_v2`; Flash v2.5 accepts it |
| `voice_settings` | object | See §4 |
| `pronunciation_dictionary_locators` | list | Max 3 locators, applied in order |
| `seed` | int 0–4294967295 | Best-effort deterministic sampling |
| `previous_text` / `next_text` | string | Improve continuity across concatenated generations |
| `previous_request_ids` / `next_request_ids` | list | Alternative continuity mechanism (request IDs); max 3; if both given, `previous_text`/`next_text` ignored |
| `apply_text_normalization` | `auto`/`on`/`off` | `auto` decides (e.g., spelling out numbers) |
| `apply_language_text_normalization` | bool | **Japanese only; heavily increases latency** |
| `use_pvc_as_ivc` | bool | **Deprecated** temp workaround for PVC latency |

### Python example (from official guide)

```python
from elevenlabs import VoiceSettings
from elevenlabs.client import ElevenLabs

elevenlabs = ElevenLabs(api_key=ELEVENLABS_API_KEY)

response = elevenlabs.text_to_speech.stream(
    voice_id="pNInz6obpgDQGcFmaJgB",
    output_format="mp3_22050_32",
    text=text,
    model_id="eleven_flash_v2_5",
    voice_settings=VoiceSettings(
        stability=0.0, similarity_boost=1.0, style=0.0,
        use_speaker_boost=True, speed=1.0,
    ),
)
for chunk in response:
    if chunk:
        audio_stream.write(chunk)
```

**Turtle use case:** pre-rendered static strings — the AI disclosure script, the greeting,
crisis resource lines (so they're instantly available at sub-100ms), recap card audio.

---

## 7. Endpoint B — WebSocket Streaming (Turtle's main path)

`wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input`

Designed for **partial/streaming text input** (e.g., LLM output arriving token/sentence by
sentence) while maintaining audio consistency across the stream. Not ideal when full text is
known upfront (extra buffering → slightly higher latency than HTTP).

### Connection URI

```
wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input?model_id=eleven_flash_v2_5
```

Relevant query params (shared with the multi-context endpoint):

| Param | Notes |
|---|---|
| `model_id` | e.g. `eleven_flash_v2_5` |
| `output_format` | e.g. `pcm_16000` |
| `auto_mode` | Disables chunk schedule + buffers for lowest latency. **Only send complete sentences when enabled** — partial sentences degrade quality badly |
| `inactivity_timeout` | Seconds before auto-close. Default 20, max 180 |
| `language_code` | ISO 639-1; Flash v2.5 accepts it |
| `enable_ssml_parsing` | Required for phoneme-based pronunciation dictionaries; recommended to send SSML tags as fully-contained messages to avoid added latency |
| `sync_alignment` | Emit text alignment with every response |
| `seed` | Best-effort determinism |
| `apply_text_normalization` | `auto`/`on`/`off` |
| `enable_logging=false` | Zero-retention (Enterprise only) |
| `single_use_token` | For client-initiated sessions |

### Message 1 — Initialize connection

```json
{
  "text": " ",
  "voice_settings": {"stability": 0.5, "similarity_boost": 0.8, "use_speaker_boost": false},
  "generation_config": {"chunk_length_schedule": [120, 160, 250, 290]},
  "xi_api_key": "..."
}
```

- The first `text` is conventionally a single space (triggers init without content).
- `pronunciation_dictionary_locators` must be set **here** (init message only), not per text message.

### Messages N — Send text

```json
{"text": "How are you holding up today?"}
```

- Audio is generated only when the buffered text crosses the current threshold of
  `chunk_length_schedule` (default `[120, 160, 250, 290]` chars).
- A message below threshold sits in the buffer — this is the classic stall: a 50-char
  message waits for more text. **This is why per-sentence LLM streaming + flush works.**
- Per-message overrides allowed: `voice_settings`, `generation_config`.

### flush

```json
{"text": "I hear you.", "flush": true}
```

Forces generation of whatever is buffered, immediately. **Critical for conversational agents:
send `flush: true` with the final sentence of every turn** so the last fragment isn't held
waiting for more text. Closing the socket also flushes automatically.

### Keepalive / close semantics

- Connection auto-closes after **20s of inactivity** (default).
- Keepalive: send `{"text": " "}` — a **single space**. Sending `""` (empty string) **closes** the connection.
- `alignment: true` (in text messages) returns word-level timestamps — useful for
  word-completion tracking against the transcript; the Pipecat service uses this for
  interruption handling and text attribution.

### Receiving

Server messages contain `audio` (base64) per chunk; final message has `isFinal: true`.
(With alignment enabled, also `alignment` / `normalizedAlignment` fields — note SSML phoneme
tags render CMU arpabet syllables and `.` placeholders for breaks in normalized alignment.)

### Full Python skeleton (official guide)

```python
import asyncio, base64, json, os, websockets
from dotenv import load_dotenv

load_dotenv()
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")
voice_id = "Xb7hH8MSUJpSbSDYk0k2"
model_id = "eleven_flash_v2_5"

uri = f"wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input?model_id={model_id}"

async def text_to_speech_ws_streaming(voice_id, model_id):
    async with websockets.connect(uri) as websocket:
        await websocket.send(json.dumps({
            "text": " ",
            "voice_settings": {"stability": 0.5, "similarity_boost": 0.8, "use_speaker_boost": False},
            "generation_config": {"chunk_length_schedule": [120, 160, 250, 290]},
            "xi_api_key": ELEVENLABS_API_KEY,
        }))

        # Example: one-shot send
        text = "How are you holding up today?"
        await websocket.send(json.dumps({"text": text}))
        await websocket.send(json.dumps({"text": ""}))  # empty string = end + close

asyncio.run(text_to_speech_ws_streaming(voice_id, model_id))
```

### Official best practices (verbatim intent)

- Use the default `chunk_length_schedule` unless you have a measured reason to change it;
  shrinking it lowers latency at the cost of quality.
- Conversational agents: `flush: true` at end of every conversational turn.
- Keep the connection open across turns rather than reconnecting per utterance (Turtle
  sessions are 5–10 min; reconnect cost ~1 RTT + auth each time).

---

## 8. Endpoint C — Multi-Context WebSocket (later, if ever)

`wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/multi-stream-input`

Multiple independent generation **contexts** over one socket — each with its own buffer,
flush, and lifecycle. Useful for interleaved audio (e.g., a gentle chime or second voice over
speech) and the only path to Eleven v3 dialogue models.

Client message types: `initializeConnectionMulti` (new context), `initialiseContext`
(init/re-init with text+settings), `sendTextMulti`, `flushContextClient`,
`closeContextClient`, `closeSocketClient`, `keepContextAlive`.
Server messages: `audioOutputMulti` (per-context audio), `finalOutputMulti` (per-context final).

**Turtle verdict:** defer. If a card-confirmation chime ever needs to overlay speech, revisit.

---

## 9. Latency Engineering

### Two different numbers

- **Model inference latency** (~75ms Flash): internal model time only.
- **Time-to-first-audio (TTFA)**: request initiated → first sample played. This is the number
  users feel, and it is always substantially larger.

### TTFA budget stack (Turtle target: < 1.5s p50)

```
ASR finalization        ~200–500ms  (Deepgram endpointing)
Orchestrator (LLM)      ~300–800ms  (first validated sentence)
  └ guardrails/classifier included
Network RTT             ~20–200ms   (geography-dependent; irreducible)
TTS first chunk         ~100–150ms  (Flash, NA/EU/SEA TTFB)
Player buffer           ~500ms default — tune down (e.g. 150–250ms), accept minor stutter risk
```

ElevenLabs is typically the *smallest* slice. Optimize LLM first-chunk time and player
buffer before touching anything else.

### The four optimization principles (official)

1. **Flash models** — ~75ms inference; slight quality trade-off vs Multilingual v2.
2. **Streaming** — HTTP SSE for complete text; WebSocket `auto_mode` for streamed text.
   `auto_mode` removes manual chunk-schedule management; **only send full sentences** when enabled.
3. **Geographic proximity** — routed automatically to USA / Netherlands / Singapore clusters.
   TTFB ~100–150ms (NA, EU, SEA), 150–200ms (South/NE Asia). Inspect the `x-region` response
   header to see which cluster served you. Force USA routing with base URL
   `https://api.us.elevenlabs.io` if needed.
4. **Voice choice** — Default/Synthetic/IVC faster than PVC.

Enterprise adds concurrency headroom + rendering-queue priority + dedicated data residency
(EU/India) — not needed for Turtle.

### Streaming vs. model latency

Streaming does not reduce inference time; it reduces **perceived** latency by playing the
first chunk as it's generated. Measure from your own application, not from benchmark figures.

---

## 10. Determinism & Cross-Chunk Consistency

- Output is **nondeterministic**. Use `seed` (int 0–4294967295) for best-effort reproducibility.
- Prosody continuity across segmented generation:
  - `previous_text` / `next_text` — context strings around the current request.
  - `previous_request_ids` / `next_request_ids` — max 3 request IDs; takes precedence over
    the text variants when both are sent.
- Text-to-Dialogue concatenates inputs verbatim (sentence aggregation only).

**Turtle note:** keep per-turn spoken units to single sentences where possible — it both
improves barge-in responsiveness and keeps prosody natural.

---

## 11. Pronunciation Dictionaries

Two types: rule-based (string substitutions, e.g., "Tetris" → "Tetris [ˈtɛtrɪs]") and
phoneme-based (IPA / CMU arpabet).

- Locators: `{id, version_id}`; max 3 per request; applied in order.
- **WebSocket:** dictionaries must be declared in the **initialize connection** message, not per text message.
- **Phoneme dictionaries require `enable_ssml_parsing=true`** in the WS URI (auto-enabled if
  unset — setting it to `false` with phoneme dictionaries is deprecated and will be ignored).

**Turtle note:** drug names (ondansetron, morphine formulations, caregiver names) are a
credibility risk. Build a small rule-based dictionary at init. Careful with Pipecat-style
`replace_text` transforms: substituted text can break alignment-based word tracking (a known
issue that motivated Pipecat deprecating `pronunciation_dictionary_locators` in favor of
client-side `text_transforms`).

---

## 12. SSML

`enable_ssml_parsing=true` enables SSML tags in text. Send SSML tags as fully-contained
messages (a whole SSML block in one message) to avoid extra latency. In normalized alignment,
SSML breaks render as `.` and phonemes as CMU arpabet. Use sparingly — pauses via
punctuation are usually enough for Turtle.

---

## 13. Bonus: Scribe Realtime STT (optional A/B vs Deepgram)

`wss://api.elevenlabs.io/v1/speech-to-text/realtime` — WebSocket streaming transcription.

Notable params: `commit_strategy` (`manual` | `vad`), `vad_threshold`, `vad_silence_threshold_secs`,
`min_speech_duration_ms`, `min_silence_duration_ms`, `keyterms` (max 50 bias terms, +20% cost),
`no_verbatim` (strip fillers), `entity_detection` (`pii`, `phi`, `pci`, `offensive_language`...),
`filter_background_audio` (mutually exclusive with `include_timestamps` — relevant in a noisy
home), `language_code` / `secondary_languages`.
Events: `sessionStarted`, `partialTranscript`, `committedTranscript` (+ timestamps/entities
variants), and a family of `scribe*Error` events incl. `scribeUnacceptedTermsError`,
`scribeRateLimitedError`, `scribeSessionTimeLimitExceededError`.
Auth: `xi-api-key` header or `token` query param (single-use tokens for client-side).

**Turtle verdict:** stay on Deepgram per spec; this is the fallback if you ever consolidate vendors.

---

## 14. Pipecat Integration Patterns (distilled knowledge)

Even with a custom orchestrator, these patterns from Pipecat's ElevenLabs service are worth copying:

- **Text aggregation mode:** buffer LLM tokens until sentence boundaries before sending to TTS
  (`SENTENCE` mode, default) for natural prosody; use `TOKEN` mode only when chasing latency.
- **auto_mode interplay:** auto mode is auto-enabled for sentence aggregation and disabled for
  token aggregation (token streaming relies on the server-side chunk scheduler). Match them deliberately.
- **WebSocket over HTTP for conversation:** WS gives word-level timestamps + interruption
  handling — "significantly better for interactive conversations."
- **Runtime settings updates:** voice settings can be changed mid-conversation (Turtle could
  slow `speed` slightly for crisis conversations, e.g. 0.9).
- **Interruption handling:** use alignment timestamps to know which words were actually spoken
  before barge-in, so the transcript reflects reality.
- **v3 audio tags:** `[laughs]`, `[excited]` etc. come back as spoken characters in alignment —
  filter them from LLM context if used.

---

## 15. Turtle Configuration Presets

```json
{
  "tts": {
    "model_id": "eleven_flash_v2_5",
    "voice_id": "<chosen once, frozen>",
    "output_format": "pcm_16000",
    "voice_settings": {
      "stability": 0.5,
      "similarity_boost": 0.8,
      "style": 0.0,
      "use_speaker_boost": false,
      "speed": 1.0
    },
    "ws": {
      "generation_config": { "chunk_length_schedule": [120, 160, 250, 290] },
      "inactivity_timeout": 180,
      "auto_mode": false,
      "pronunciation_dictionary_locators": ["<caregiver + drug names dict>"]
    },
    "turn_end": "flush: true on final sentence of every turn",
    "keepalive": "{\"text\": \" \"} between turns; never \"\""
  }
}
```

Latency checklist for the Voice Gateway:
- [ ] Keep WS connection open for whole session (no per-turn reconnect)
- [ ] Sentence-buffer LLM stream, send sentence-by-sentence, flush on turn end
- [ ] Player buffer 150–250ms (not the 500ms default)
- [ ] Base URL default (`api.elevenlabs.io`); verify `x-region`; switch to `api.us.elevenlabs.io` if routing misbehaves
- [ ] Pre-render static strings (disclosure, crisis lines, greeting) via HTTP stream for <100ms availability

---

## 16. Gotchas & FAQ

1. **`optimize_streaming_latency` is deprecated** — use Flash model + streaming + chunk schedule. Ignore old blog posts.
2. **20-second inactivity close** — send `{"text": " "}` (a space) as keepalive. `""` closes the socket.
3. **Chunk-schedule stall** — a short message below threshold waits in buffer. Conversational turns must `flush: true`.
4. **auto_mode + partial sentences = bad quality.** Complete sentences only.
5. **Descriptive cues are spoken.** "She said gently" gets read aloud unless trimmed. Keep stage directions out of Turtle's spoken text.
6. **Tier gating:** MP3 192kbps → Creator+; PCM 44.1kHz → Pro+; Voice Library API → paid tiers; zero-retention mode → Enterprise only.
7. **Ownership:** you own generated audio; commercial use requires a paid plan.
8. **Free regenerations:** up to 2 per generation, same content + parameters only. Useful when a clip distorts.
9. **Region:** `x-region` header reveals serving cluster (USA / Netherlands / Singapore). Measure from where your users are.
10. **Pronunciation dictionaries on WS:** init message only; phoneme dictionaries need SSML parsing enabled.
11. **Nondeterminism:** use `seed` for reproducibility in evals; expect subtle variance regardless.
12. **Previous/next text:** the continuity mechanism for splitting long generations; request-ID variant takes precedence.

---

## 17. Quick Source Index

| Topic | URL |
|---|---|
| Realtime WS guide | https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts |
| WS API reference | https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input |
| HTTP streaming reference | https://elevenlabs.io/docs/api-reference/text-to-speech/stream |
| Multi-context WS | https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input |
| Latency optimization | https://elevenlabs.io/docs/eleven-api/guides/how-to/best-practices/latency-optimization |
| Understanding latency | https://elevenlabs.io/docs/eleven-api/concepts/latency |
| TTS overview | https://elevenlabs.io/docs/overview/capabilities/text-to-speech |
| Streaming guide | https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/streaming |
| Scribe realtime STT | https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime |
| Pipecat patterns | https://docs.pipecat.ai/api-reference/server/services/tts/elevenlabs |
