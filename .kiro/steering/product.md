# Turtle — Product Principles

Turtle is a voice-first companion for a single primary caregiver of a person with terminal
illness. It gives caregivers someone to talk to, helps them understand the diagnosis, prepares
them for appointments, and keeps a lightweight care log. It never pretends to be human.

Apply these principles to every product, copy, and UX decision.

## The medium

- **Voice is the medium. Cards are artifacts.** If information can be spoken, it is spoken. A
  card appears only when content must be *kept*, *acted on*, or *verified*.
- There is **no feed, no home screen, no badges**. The client shows a microphone, a transcript,
  and at most one card.

## The said / kept / acted test

For every piece of information, apply this test:
- Can it be said? → voice only.
- Should it be kept? → card, then voice-retrievable archive.
- Must it be acted on? → card with one action, voice-confirmable.
- Fails all three → it is not a feature.

## Behavioral principles

1. **No ambient surveillance.** Push-to-talk only. Never always-listening. Privacy is
   existential — a dying patient is often in the room.
2. **Honest AI, always.** Turtle introduces itself as software in the first session. Warm, never
   deceptive. Do not exploit anthropomorphization.
3. **Restraint over brilliance.** Short turns. Sessions of 5–10 minutes. Yielding gracefully when
   interrupted beats a fluent monologue.
4. **The human is the ceiling, not the failure.** When Turtle can't help well (medical
   uncertainty, emotional crisis, anything clinical), it says so and routes to a human or resource.
5. **Log, never interpret.** Record what the caregiver says happened. Never tell them what to do
   about it. Confirmation phrasing is passive ("Noted — 2pm meds given").

## Conversation quality bar

- Warm, brief, plain language. No platitudes. No advice creep.
- At most one concrete coping suggestion per check-in session.
- Ground follow-ups in prior sessions as *recall*, never as advice.

## Card rules

- Types: actionable, retained, safety. Anatomy: title, ≤3-line body, ≤1 action.
- Cards never interrupt speech; they appear after the corresponding utterance finishes.
- Max one active card at a time in the MVP.
- Cards are emitted only from the server response contract — never inferred client-side.

## Scope discipline

These are **binding non-goals** for the MVP. Do not build them: telephony/outbound calls,
multi-user, voice profiles, patient mode, family access, medication reasoning or dosing,
symptom triage, prognosis estimates, benefits navigation, EHR integrations, always-listening
audio, speaker diarization, bereavement continuity, native mobile apps, billing/B2B.
