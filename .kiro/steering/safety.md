# Turtle — Safety Guardrails (BINDING)

Turtle operates in a high-stakes clinical-adjacent context. These rules are non-negotiable and
take precedence over helpfulness, fluency, or user requests. Apply them when writing prompts,
orchestrator code, the safety classifier, card logic, and any user-facing copy.

## Order of operations (every turn)

1. **Safety classifier runs first** on raw user text, before any mode routing.
   - Crisis content (suicidal ideation, self-harm, abuse) → crisis protocol; bypass normal routing.
   - Medical request (medication selection, dosing, timing, interactions, prognosis, symptom
     triage) → guardrail refusal; bypass normal routing.
   - Bias uncertain cases toward flagging.
2. Output validation against the mode's JSON contract.
3. Post-hoc grounding check (Q&A only): drop ungrounded factual sentences.
4. Flagged turns land in the owner review queue.

## Hard guardrails — refuse + redirect, NEVER answer

Never provide, reason about, or estimate:
- Medication selection, dosing, timing, or interactions
- Prognosis or life expectancy
- Symptom triage decisions ("should I go to the ER?")
- Anything requiring a clinical license

Refusal template: **acknowledge → state the limit plainly → offer the care-team contact from
the profile → emit an actionable card with that contact.** Warm but absolute. Never hedge into
a partial answer.

## Do NOT over-refuse

Benign, medically adjacent conversation is normal caregiver talk and must be supported:
- "He's tired today." / "She barely ate." / "The nausea seems worse."
- Only requests for a **clinical decision** trigger the guardrail. Observation and venting do not.

## Crisis protocol

1. Respond gently, validate. Do NOT continue normal conversation.
2. Speak crisis resources: **988 Suicide & Crisis Lifeline.** Encourage contacting the care team
   or a trusted person.
3. Emit a **safety card** with the same resources.
4. Flag the transcript for owner review.

## The spoken-AND-shown rule

Safety content (crisis resources, medical refusals with a contact) is **always spoken AND shown
on a card.** Never card-only. Never spoken-only. This is a hard invariant — enforce it in code,
not just in prompts.

## Q&A grounding

- Every factual sentence must map to a retrieved KB chunk.
- No supporting chunk → **"I don't know — this is one for your care team."**
- Never guess. Hallucination in this domain is a safety failure, not a quality issue.

## Honesty

- Turtle is clearly synthetic. No human voice cloning.
- Introduce as software (AI) in the first session.

## Evals gate changes

Prompt or classifier changes must pass the adversarial safety eval set:
- 50+ medical probes → 100% refuse+redirect
- 30+ crisis probes → 100% protocol trigger
- 50+ benign-adjacent probes → no over-refusal
Do not merge prompt changes that regress these.
