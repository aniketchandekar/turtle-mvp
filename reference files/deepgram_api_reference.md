# Deepgram API Reference — for the Turtle Project

**Purpose:** Working reference for using Deepgram as Turtle's Speech-to-Text layer
(browser mic → Voice Gateway → Deepgram → finalized turns to Orchestrator), compiled from
official Deepgram documentation, community guides, and Pipecat integration patterns.

---

## How to Use This Document (Agent Instructions)

1. **This file is a compiled reference, not the source of truth.** It summarizes Deepgram
   documentation pages listed in §16. When you need parameter-level detail, current defaults,
   enums, error codes, or anything not fully spelled out here: **open the relevant source URL
   from §16 before answering or writing code.** Never guess API parameters from memory.
2. **Navigate by section:** §1 orientation · §3–4 models & auth · §5–8 the streaming protocol
   and turn-detection features · §10 other features · §12 Turtle presets · §13 gotchas.
   Read the whole file once before building; afterwards use it as a lookup.
3. **Turtle-specific decisions are marked as such** (e.g., `nova-3` + manual endpointing config,
   linear16/16kHz, keyterm list for drug names). Treat these as binding defaults unless the
   user explicitly overrides.
4. **Code examples here are illustrative.** Before shipping, verify against the live API
   reference (§16) — Deepgram ships new models (e.g., Flux STT) and deprecates parameters
   without notice.
5. **If anything in this file conflicts with the official docs, the official docs win** —
   flag the discrepancy to the user and update this file.

---

## 1. Orientation: where Deepgram sits in Turtle

```
Client (mic capture, 16kHz PCM)
   │  WebSocket audio chunks
   ▼
Voice Gateway (Node/TS) ──► Deepgram Streaming STT
   │  interim transcripts (dimmed live text)
   │  final transcripts + speech_final / UtteranceEnd
   ▼
Orchestrator (safety classifier → mode router → LLM)
```

Deepgram owns exactly one job: **turn audio into finalized text turns as fast and accurately
as possible**, including end-of-speech detection. Barge-in, guardrails, and conversation
state live elsewhere.

## 2. Endpoint decision

| Situation | Endpoint |
|---|---|
| Real-time conversation (Turtle) | **Streaming WebSocket** `wss://api.deepgram.com/v1/listen` |
| Batch file transcription (care log audio review, eval sets) | Pre-recorded REST: `POST /v1/listen` (with `url` or binary body) |

Streaming over WebSocket is not charged extra vs REST — same per-minute rate.<REF>cite✦tools://web_search:9#14:~:text=WebSocket streaming...no streaming surcharge</REF>

---

## 3. Models

| Model | Purpose | Notes |
|---|---|---|
| `nova-3` | General production STT; **Turtle default** | Best-in-class accuracy + noise robustness; 50+ languages; self-serve **keyterm** vocabulary boosting |
| `nova-3-general` / variants | Domain-tuned Nova variants | Industry-tuned (healthcare, legal, finance) variants exist for enterprise |
| **Flux STT** | Conversational voice agents | Built-in **turn detection, natural interruption handling, eager end-of-turn**, ultra-low latency; ~10 languages; no interim transcriptions (subscribe to `on_update` for incremental text) |
| Custom | Edge-case domains | Trained per-customer; not needed for Turtle |

**Key trade-off (Turtle):** Nova-3 gives you explicit control (endpointing, interim results,
utterance-end) — better for a custom orchestrator where turn-taking semantics matter. Flux
gives smarter turn detection for free but owns the loop (same reason we rejected Gemini
Live / ElevenLabs-managed agents). **Decision: start with Nova-3 + manual config; spike Flux
in week 4 as a comparison.**

## 4. Authentication

- WebSocket handshake header: `Authorization: Token <DEEPGRAM_API_KEY>`
  (SDKs handle this; raw WS requires it).
- Get the key: Deepgram Console → your project → **Settings → API Keys → Create New Key**.
  Set a friendly name, role, and expiration. Free signup includes $200 credit, no card.<REF>cite✦tools://web_search:9#13:~:text=Get $200 in credit absolutely free...No credit card needed</REF>
- The key lives server-side in the Voice Gateway only. If the browser ever connects directly,
  mint short-lived scoped keys from the backend.

---

## 5. Streaming WebSocket Protocol

### Connection URI

```
wss://api.deepgram.com/v1/listen?model=nova-3&language=en-US&smart_format=true
    &encoding=linear16&channels=1&sample_rate=16000
    &interim_results=true&endpointing=300&utterance_end_ms=1000&vad_events=true
```

### Core query parameters (streaming)

| Param | Type / default | Notes |
|---|---|---|
| `model` | `nova-3` | §3 |
| `language` | `en-US` | BCP-47; `multi` for multilingual auto-detect (Nova) |
| `smart_format` | bool | Punctuation, capitalization, paragraphing; **on for Turtle** — improves readability of transcripts shown to caregiver and fed to the LLM. Note: rare cases (reciting a phone number) may delay finalization slightly while formatting resolves |
| `encoding` | `linear16` | Send `linear16` 16-bit PCM from the browser (downsample `getUserMedia` 44.1/48k → 16k) |
| `channels` | `1` | Mono |
| `sample_rate` | `16000` | Must match actual audio |
| `interim_results` | `true` | Required for UtteranceEnd; enables live dimmed transcript |
| `endpointing` | int ms (default 10!) | §6 — **the most important param for conversational feel** |
| `utterance_end_ms` | string ms | §7 — robust end-of-turn signal for noisy rooms |
| `vad_events` | bool | Emits VAD state (speech start/stop) — useful for mic UI state |
| `keyterm` | repeated param | §10 — bias recognition toward critical words (drug names) |
| `numerals` | bool | Spoken numbers → digits |
| `punctuate` | bool | Punctuation (also included in smart_format) |
| `filler_words` | bool | Keep "uh"/"um" — **off for Turtle** (feeds LLM; cleaner without) |
| `profanity_filter` | bool | **off for Turtle** — never filter a grieving person's words |
| `redact` | string/list | `pii`, `phi`, `pci`... — optional; Turtle stores minimally instead |
| `diarize` | bool | Speaker labels — **defer** (single caregiver in MVP) |
| `replace` | list | Find/replace in transcript (`from: to`) |
| `search` / `keywords` | list | Legacy boosting (prefer `keyterm` on Nova-3) |

### Client → server messages (raw WebSocket)

| Message | Purpose |
|---|---|
| Binary audio frames | 16-bit PCM chunks (e.g., 20–100ms each) |
| `{"type": "KeepAlive"}` | Prevent idle close — send every ~3–4s while connected |
| `{"type": "Finalize"}` | Force finalization of buffered audio (used by Pipecat on VAD stop for faster finals — copy this pattern) |
| `{"type": "CloseStream"}` | Graceful close |

### Server → client messages

| Type | Meaning |
|---|---|
| `Results` (JSON) | Transcript payload — see §8 schema |
| `UtteranceEnd` (JSON) | Gap-based end-of-utterance signal: `{"type":"UtteranceEnd","channel":[0,1],"last_word_end":3.1}` |
| `Metadata` | Request/model metadata |
| VAD events | Speech start/stop when `vad_events=true` |

### Full JS SDK example (official getting-started, abridged)

```js
const { DeepgramClient } = require("@deepgram/sdk");
const deepgram = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });

const connection = await deepgram.listen.v1.connect({
  model: "nova-3",
  language: "en-US",
  smart_format: "true",
});

connection.on("open", () => {
  connection.on("message", (data) => {
    if (data.type === "Results") {
      const alt = data.channel.alternatives[0];
      // is_final / speech_final handling — see §6–8
    }
  });
  // stream audio in via connection.sendMedia(chunk)
});
```

## 6. Turn detection deep dive: endpointing

`endpointing` uses an audio-based VAD: when speech stops for the configured silence, the
transcript is finalized with **`speech_final: true`**.

| Value | Effect |
|---|---|
| `10` (default) | Very fast; fine for short command-style utterances |
| `300–500` | **Turtle value: 300.** Better for natural conversation where people pause mid-thought |
| `false` | Disable; transcripts arrive at Deepgram's chunking cadence instead |

**Known limitation:** in noisy environments (TV, kettle, hallway) background sound keeps the
VAD "speaking" and `speech_final` may never fire.<REF>cite✦tools://web_search:11#9:~:text=In environments with significant background noise...may prevent the speech_final=true flag from being sent</REF> This is exactly Turtle's
deployment environment (a home with a dying patient — machines, visitors, TV). Mitigation: §7.

## 7. Turn detection deep dive: UtteranceEnd

`utterance_end_ms` analyzes **word timings** (not audio) — it fires when a configured gap
appears after the last finalized word, ignoring non-speech noise like doorbells.<REF>cite✦tools://web_search:11#9:~:text=it ignores non-speech audio such as: door knocking...street noise</REF>

Rules:
- Requires `interim_results=true`.
- Set **≥ 1000** — interim results arrive ~every 1s, so shorter values gain nothing.<REF>cite✦tools://tools://web_search:11#9:~:text=Deepgram’s Interim Results are sent every 1 second...less than 1 second will not offer any benefits</REF>
- Message: `{"type":"UtteranceEnd","channel":[0,1],"last_word_end":<seconds>}` —
  use `last_word_end` to reconcile which words belong to the ended utterance.

**Turtle pattern:** trust `speech_final` as the fast path; treat `UtteranceEnd` as the
authoritative fallback in noise. A turn is complete when *either* fires; guard against
double-processing by tracking `last_word_end`.

## 8. Response schema (`Results`)

```json
{
  "type": "Results",
  "channel_index": [0, 1],
  "duration": 1.039875,
  "start": 0.0,
  "is_final": false,
  "speech_final": false,
  "channel": {
    "alternatives": [{
      "transcript": "another big",
      "confidence": 0.9600,
      "words": [
        {"word": "another", "start": 0.297, "end": 0.797, "confidence": 0.958,
         "punctuated_word": "another"},
        {"word": "big", "start": 0.852, "end": 1.040, "confidence": 0.960}
      ]
    }]
  }
}
```

| Flag | Meaning |
|---|---|
| `is_final: false` | Interim guess — may change; render dimmed in transcript UI |
| `is_final: true` | Finalized segment (accuracy peaked for that span); append to turn buffer |
| `speech_final: true` | This final result ends the utterance (endpointing fired) — **send turn to Orchestrator** |

Standard combination pattern: concatenate all `is_final` transcripts; when `speech_final`
arrives, the buffer is the complete user turn; clear and collect the next.<REF>cite✦tools://web_search:11#10:~:text=Append each is_final: true transcript to a buffer...Clear the buffer and start collecting the next utterance</REF>

## 9. Latency

- Deepgram markets ultra-low-latency streaming; for budgeting, the stages that matter to
  Turtle's TTFA are: browser capture + resampling (~30–80ms) → network → **endpointing wait
  (your configured 300ms)** → finalization + network back.
- Practical lever: `Finalize` on client-side VAD stop (Pipecat does this) shaves time when
  you already know the user stopped.
- Measure from your own stack (`elevenlabs-latency` equivalent: log timestamps
  audio-chunk-sent → speech_final-received per turn in the Voice Gateway).

## 10. Other features that matter for Turtle

| Feature | Notes |
|---|---|
| **Keyterm prompting** (`keyterm=ondansetron&keyterm=hospice...`) | Up to ~90% higher keyword recall for critical vocabulary. **Use for the patient's drug names, diagnosis terms, care-team names.** Replaces legacy `keywords`/`search` on Nova |
| **Smart format** | Auto punctuation/caps — on; transcripts feed both the UI and the LLM |
| **Multilingual** | `language=multi` for code-switching households (Nova); or fixed `en-US` for MVP |
| **Numerals** | "two milligrams" → "2 mg" — useful in care log dictation |
| **Redaction** | `redact=phi` possible, but Turtle's minimal-retention stance is primary |
| **Filler words** | Off — cleaner LLM input |
| **Diarization** | Defer (single-speaker MVP) |
| **MIP opt-out** | `mip_opt_out=true` opts audio out of Deepgram's Model Improvement Program — **consider for privacy posture; check pricing impact** |

## 11. Pipecat patterns worth copying

- **Finalize on VAD stop:** when local VAD says the user stopped, send `Finalize` for faster
  final transcripts.<REF>cite✦tools://web_search:11#4:~:text=When the pipeline’s VAD detects the user has stopped speaking...faster final transcript delivery</REF>
- **Runtime settings → reconnect on turn boundary:** changing settings mid-stream triggers a
  reconnect; Pipecat defers it until the current turn ends and buffers/replays audio. If you
  ever hot-change language or keyterms, copy this.
- **Reconnection limit:** after 3 failed connections, stop retrying and report degraded —
  fall back to text input (per spec §15.3).
- **Flux alternative service:** Pipecat's `DeepgramFluxSTTService` shows the event model
  (`EagerEndOfTurn`, `TurnResumed`, committed turns) if you spike Flux later.<REF>cite✦tools://web_search:11#4:~:text=With enable_eager_end_of_turn=True...discarded if the user resumes speaking</REF>

## 12. Turtle configuration preset

```json
{
  "asr": {
    "endpoint": "wss://api.deepgram.com/v1/listen",
    "model": "nova-3",
    "language": "en-US",
    "encoding": "linear16",
    "channels": 1,
    "sample_rate": 16000,
    "smart_format": true,
    "interim_results": true,
    "endpointing": 300,
    "utterance_end_ms": "1000",
    "vad_events": true,
    "keyterm": ["<patient drug names>", "<diagnosis terms>", "<care-team names>"],
    "filler_words": false,
    "profanity_filter": false,
    "mip_opt_out": false
  },
  "ws_messages": {
    "keepalive_secs": 4,
    "finalize_on_local_vad_stop": true,
    "close": "{\"type\":\"CloseStream\"}"
  }
}
```

Checklist:
- [ ] Resample browser audio to 16kHz mono PCM16 before sending
- [ ] Turn complete = `speech_final` OR `UtteranceEnd` (dedupe via `last_word_end`)
- [ ] KeepAlive every ~4s; CloseStream on session end
- [ ] Interim transcripts rendered dimmed; finals committed to transcript pane
- [ ] Turn buffer + flags logged for latency measurement (ASR→speech_final ms)

## 13. Gotchas & FAQ

1. **Endpointing default is 10ms** — too aggressive for natural conversation; set explicitly.
2. **Noisy rooms break `speech_final`** — homes have machines, TV, visitors. UtteranceEnd is
   the safety net; don't run without it.
3. **`utterance_end_ms` < 1000 is pointless** — interims arrive ~1s cadence.
4. **Sample rate mismatch corrupts everything** — if transcripts are garbage, check
   `encoding`/`channels`/`sample_rate` against actual audio first.
5. **Smart format can delay finals** in rare cases (reciting numbers) — acceptable; note it
   in latency evals.
6. **KeepAlive is `" "` in ElevenLabs but `{"type":"KeepAlive"}` in Deepgram** — don't confuse
   the two protocols.
7. **Free-tier WebSocket concurrency is limited** (~150 concurrent for paid; free has lower
   caps) — irrelevant for one caregiver, matters if dogfooding with 2–3.
8. **Nova-3 is not deterministic** either — eval WER on your caregiver voice samples
   (elderly, emotional, accented) before tuning prompts around quirks.

---

## 14. Relationship to the rest of the stack

| Concern | Owner |
|---|---|
| Mic capture, resample to 16k PCM | Client |
| KeepAlive, Finalize, audio relay | Voice Gateway |
| Turn completion semantics | Deepgram (`speech_final` + `UtteranceEnd`) |
| Barge-in (halt TTS playback) | Client VAD + `interrupt` → Gateway flush |
| Safety classification, routing, cards | Orchestrator (see PRD/tech spec) |
| Spoken output | ElevenLabs (see elevenlabs_api_reference.md) |

---

## 15. Build-order note

The Voice Gateway's Deepgram client is Week 1 work, in parallel with the ElevenLabs client —
the state machine only becomes testable once ASR finals and TTS playback both exist. Build
the Deepgram side first (it's the simpler protocol: one WS, binary up, JSON down); barge-in
lands once TTS playback exists to interrupt.

## 16. Quick Source Index

| Topic | URL |
|---|---|
| Live streaming getting started | https://developers.deepgram.com/docs/live-streaming-audio |
| Endpointing reference | https://developers.deepgram.com/docs/endpointing |
| Interim results reference | https://developers.deepgram.com/docs/interim-results |
| Utterance End reference | https://developers.deepgram.com/docs/utterance-end |
| End-of-speech detection guide | https://developers.deepgram.com/docs/understanding-end-of-speech-detection |
| Endpointing + interim config guide | https://developers.deepgram.com/docs/understand-endpointing-interim-results |
| Lower-level WS reference implementation | https://developers.deepgram.com/docs/lower-level-websockets |
| Models overview | https://deepgram.com/product/speech-to-text |
| Pipecat Deepgram patterns | https://docs.pipecat.ai/api-reference/server/services/stt/deepgram |
| Console (API keys) | https://console.deepgram.com |

---

*Companion file: `elevenlabs_api_reference.md`. Both files assume the architecture in
`turtle_prd_and_technical_spec.md` §13–15.*
