# Turtle — Privacy Controls & Data Retention

This document records the privacy posture implemented for the MVP and the code that
enforces it. It covers R16.6 (encryption at rest + TLS/WSS in transit) and R16.7 (discard
captured audio after transcription by default; one-click delete-everything).

## Audio retention: discard after transcription by default (R16.7)

Captured microphone audio is **never persisted**. It is streamed to the ASR provider
(Deepgram) for transcription and then discarded — only the resulting transcript text is
retained.

- **Push-to-talk only.** The client captures audio solely while the caregiver holds the
  talk control; there is no background/always-on recording (design.md §Security & Privacy,
  R3.1/R16.5). The mic indicator is honest and visible.
- **The gateway does not store audio.** `SessionChannel.onAudioChunk`
  (`src/gateway/session.ts`) pipes each binary PCM frame straight to the ASR stream. It
  writes nothing to the store. When ASR is degraded (no Deepgram key), the audio is
  **dropped** rather than buffered — no background recording and no fabricated transcript.
- **The ASR stream keeps no recording.** `DeepgramAsrStream.pushAudio`
  (`src/gateway/asr/deepgram.ts`) forwards frames to Deepgram. The only buffer is a
  transient in-memory queue for frames that arrive before the socket signals `open`; it is
  flushed to the provider once ready and then cleared. Nothing is written to disk.
- **Only transcripts are retained**, as encrypted turn rows (see below). Retention of raw
  audio would require explicit consent; that is out of scope for the MVP and not
  implemented, so the default (discard) always holds.

## Encryption at rest (R16.6)

Sensitive fields are encrypted at the application layer before they reach SQLite, via
`src/store/crypto.ts` (AES-256-GCM, per-value random salt + IV, scrypt-derived key from
`TURTLE_ENCRYPTION_KEY`). Stored format: `enc:v1:<salt>:<iv>:<tag>:<cipher>`.

Coverage (encrypted on write, decrypted on read in `src/store/repositories.ts`):

| Entity      | Encrypted field | Sensitive content                    |
|-------------|-----------------|--------------------------------------|
| `turn`      | `text`          | Conversation transcript text         |
| `log_entry` | `text`          | Care-log entries                     |
| `patient`   | `care_team`     | Care-team contacts (names / numbers) |

These are the three field types called out in the design (transcripts, log entries,
contacts). The coverage is verified by tests in `src/store/store.test.ts`
("encryption at rest (R16.6)"), which read the **raw column bytes** and assert the stored
value is prefixed ciphertext with no plaintext leak, and still decrypts on read.

> **Operational note.** In development the server falls back to a fixed insecure key and
> logs a warning (`config.ts` → `describeCapabilities`: "using DEV key"). Set
> `TURTLE_ENCRYPTION_KEY` to a real secret for any non-throwaway use. The per-value-salt
> scheme is a self-contained MVP seam; a KMS can replace `createCipher` later without
> changing call sites.

## TLS / WSS in transit (R16.6)

- **Single origin, single scheme.** The client derives the WebSocket URL from the HTTP
  server URL by swapping the scheme (`useSession.ts` → `wsUrl()`:
  `http→ws`, so `https→wss`). Deploying the server behind HTTPS therefore yields WSS for
  the realtime channel automatically — the transport follows the origin.
- **Provider calls are HTTPS/WSS.** Outbound ASR/TTS/LLM calls use the vendor SDKs, which
  connect over TLS.
- **MVP posture.** Locally the server listens on plain HTTP/WS for developer ergonomics.
  TLS termination is expected at the deployment edge (the hosting platform / reverse
  proxy), which upgrades both the REST plane and the `/ws` channel to HTTPS/WSS. CORS is
  currently permissive for local dev and must be tightened to an allowlist before any
  non-local deployment (`src/http/cors.ts`).

## One-click "delete everything" (R16.7)

A single control wipes **all** stored caregiver data irreversibly.

- **Endpoint:** `DELETE /everything` (`src/http/routes.ts`) → `repos.deleteEverything()`.
- **What it clears:** every caregiver-data table, in one transaction —
  `card`, `turn`, `session`, `log_entry`, `appointment`, `patient`, `caregiver`
  (`src/store/repositories.ts` → `deleteEverything`). Order respects foreign keys.
- **Response:** `200 { ok: true }`. Idempotent — safe to run against an already-empty
  store.
- **Client control:** `components/PrivacyControls.tsx` (a header "Delete my data" button)
  opens an explicit confirmation dialog before calling the endpoint via
  `lib/useDeleteEverything.ts`. Because deletion is irreversible, the destructive action is
  always gated behind a confirm step, focus lands on the safe (Cancel) control, and Escape
  cancels. On success the app reloads so onboarding + consent restart against a clean store.
- **Tests:** `src/http/routes.test.ts` ("Privacy — one-click delete everything") seeds one
  row in every entity, calls the endpoint, and asserts a complete wipe; a second test
  confirms idempotency. `src/store/store.test.ts` covers the repository method directly.
