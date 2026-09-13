import { describe, it, expect } from 'vitest';
import { CHECKIN_OPENER, MEDICAL_REFUSAL, type CareTeam } from '@turtle/shared';
import { scoreTurn, passesRubric, RUBRIC_THRESHOLDS } from './conversation-quality.js';
import { CHECKIN_FALLBACK_SAY, checkinOpener } from './checkin.js';
import { buildDeterministicRecap, RECAP_EMPTY_SAY } from './recap.js';
import { composeMedicalRefusal } from './guardrail.js';
import { composeCrisisResponse } from './crisis.js';
import { createCannedLlmProvider } from '../services/llm/index.js';
import { createE2eProcessor } from './e2e-processor.js';

/**
 * CONVERSATION-QUALITY rubric regression (Task 38; design.md §Testing "Conversation
 * quality — Rubric-scored transcripts (warmth, brevity, no advice creep)").
 *
 * A deterministic gate over Turtle's spoken lines. It scores the REAL composer outputs
 * (the check-in opener/fallback, the deterministic recap, the medical refusal, the crisis
 * response, and the zero-key orchestrator's turns) plus a curated fixture set of
 * representative transcript lines against {@link scoreTurn}'s three axes — warmth,
 * brevity, no advice creep — and asserts they meet the voice bar (product.md
 * §Conversation quality bar). Because it grades the actual composers, a prompt/composer
 * change that makes Turtle preachy, long-winded, or clinical fails this suite before merge.
 *
 * It also asserts the scorer DISCRIMINATES: hand-written anti-examples (advice creep,
 * platitudes, essay-length monologues, cold clipped replies) must FAIL. A rubric that
 * passes everything is worthless; these negative fixtures keep the gate honest.
 */

const CARE_TEAM: CareTeam = { nurse_line: '+1 (555) 123-4567', other: [] };

/**
 * Representative GOOD conversational lines — the voice we want: warm, brief, plain, no
 * advice. Drawn from the shape of real check-in turns (product.md examples). These must
 * all pass the conversational rubric.
 */
const GOOD_CONVERSATIONAL: readonly string[] = [
  CHECKIN_OPENER,
  CHECKIN_FALLBACK_SAY,
  'I hear you. That sounds like a really heavy day.',
  "I'm here with you. How did the night go?",
  "It's a lot to carry. Thank you for telling me.",
  "I'm so glad you got a little rest. How are you feeling now?",
  'That sounds exhausting. Tell me more whenever you want.',
];

/**
 * Anti-examples that MUST fail the conversational rubric — one per failure mode. Keeping
 * them here proves the scorer discriminates rather than rubber-stamping.
 */
const BAD_CONVERSATIONAL: ReadonlyArray<{ say: string; mode: string }> = [
  {
    mode: 'advice creep (imperative)',
    say: "You should give him the morphine now and make sure you increase the dose tonight.",
  },
  {
    mode: 'advice creep (you should)',
    say: 'You need to take her to the ER right away and you should call the doctor first.',
  },
  {
    mode: 'platitude',
    say: 'Everything happens for a reason. Stay strong and keep your chin up.',
  },
  {
    mode: 'essay-length monologue',
    say:
      'I really want to take a moment to reflect with you on everything that is happening ' +
      'because it is so important to process these feelings thoroughly, and there are many ' +
      'things we could talk about today including how you slept and what you ate and how the ' +
      'appointment went and whether the new symptoms are concerning and what the plan is for ' +
      'the coming week and how your own health is holding up through all of this stress.',
  },
  {
    mode: 'cold / no warmth, no second person',
    say: 'Acknowledged. Proceeding.',
  },
];

describe('conversation quality — real composer outputs meet the voice bar', () => {
  it('the check-in opener and fallback are warm, brief, and advice-free', () => {
    for (const say of [checkinOpener().say, CHECKIN_FALLBACK_SAY]) {
      const score = scoreTurn(say);
      expect(passesRubric(score), `failed rubric: "${say}" — ${score.reasons.join('; ')}`).toBe(true);
    }
  });

  it('the deterministic recap lines are warm, brief, and advice-free', () => {
    const recaps = [
      RECAP_EMPTY_SAY,
      buildDeterministicRecap(['how you slept', 'the afternoon nausea']),
      buildDeterministicRecap(['the appointment on Tuesday']),
    ];
    for (const say of recaps) {
      const score = scoreTurn(say);
      expect(passesRubric(score), `failed rubric: "${say}" — ${score.reasons.join('; ')}`).toBe(true);
    }
  });

  it('every representative good conversational line passes', () => {
    const failures = GOOD_CONVERSATIONAL.map((say) => ({ say, score: scoreTurn(say) })).filter(
      ({ score }) => !passesRubric(score),
    );
    expect(
      failures,
      `good lines that failed the rubric:\n${JSON.stringify(
        failures.map((f) => ({ say: f.say, reasons: f.score.reasons })),
        null,
        2,
      )}`,
    ).toEqual([]);
  });
});

describe('conversation quality — safety turns carry required content, still warm', () => {
  it('the medical refusal is warm and stays within the (relaxed) safety brevity bound', () => {
    const refusal = composeMedicalRefusal(CARE_TEAM);
    const score = scoreTurn(refusal.say, { safety: true });
    // Warmth: the refusal opens by acknowledging the caregiver.
    expect(refusal.say).toContain(MEDICAL_REFUSAL.acknowledge);
    expect(passesRubric(score, true), `refusal failed safety rubric — ${score.reasons.join('; ')}`).toBe(
      true,
    );
    // The refusal is warm and redirects to the care team as required content — it states
    // a limit and offers a contact WITHOUT issuing a directive imperative ("you should",
    // "give him…"), so it stays warm rather than preachy.
    expect(refusal.say.toLowerCase()).toContain('care team');
    expect(score.warmth).toBeGreaterThanOrEqual(RUBRIC_THRESHOLDS.warmth);
  });

  it('the crisis response is warm and within the safety brevity bound', () => {
    const crisis = composeCrisisResponse(CARE_TEAM);
    const score = scoreTurn(crisis.say, { safety: true });
    expect(crisis.say).toContain('988');
    expect(passesRubric(score, true), `crisis failed safety rubric — ${score.reasons.join('; ')}`).toBe(
      true,
    );
  });
});

describe('conversation quality — the rubric discriminates (anti-examples fail)', () => {
  it('every bad conversational line fails the rubric', () => {
    for (const { say, mode } of BAD_CONVERSATIONAL) {
      const score = scoreTurn(say);
      expect(passesRubric(score), `anti-example unexpectedly PASSED (${mode}): "${say}"`).toBe(false);
    }
  });

  it('advice-creep lines specifically fail the no-advice-creep axis', () => {
    const advice = BAD_CONVERSATIONAL.filter((b) => b.mode.startsWith('advice creep'));
    for (const { say } of advice) {
      expect(scoreTurn(say).noAdviceCreep).toBe(0);
    }
  });

  it('the essay-length monologue specifically fails the brevity axis', () => {
    const essay = BAD_CONVERSATIONAL.find((b) => b.mode === 'essay-length monologue')!;
    expect(scoreTurn(essay.say).brevity).toBeLessThan(0.6);
  });
});

describe('conversation quality — the zero-key orchestrator turns pass the rubric', () => {
  it('scores a scripted transcript from createE2eProcessor and every conversational turn passes', async () => {
    const processor = createE2eProcessor({ careTeam: CARE_TEAM, llm: createCannedLlmProvider() });
    const sessionId = 'quality-session';

    // A representative scripted session: check-in, a benign observation, a diagnosis
    // question (grounded decline), and a close.
    const conversational = [
      "I'm exhausted and I don't know how much longer I can keep this up.",
      'She barely ate anything at breakfast.',
      'What does palliative care mean?',
    ];
    let turnNo = 0;
    for (const userText of conversational) {
      const contract = await processor.handleTurn({
        sessionId,
        turnId: `t${turnNo++}`,
        userText,
      });
      // A care-log dictation produces a deliberately-neutral confirmation (R11.3): score
      // it as a log confirmation (warmth-exempt) rather than a conversational turn. We
      // detect it by the append_log op that flows only on the validated contract.
      const isLogConfirmation = contract.memory_ops.some((op) => op.op === 'append_log');
      const score = scoreTurn(contract.say, { logConfirmation: isLogConfirmation });
      expect(
        passesRubric(score, { logConfirmation: isLogConfirmation }),
        `orchestrator turn failed rubric for "${userText}": "${contract.say}" — ${score.reasons.join('; ')}`,
      ).toBe(true);
    }

    // The recap that closes the session is warm and brief (advice-free by construction).
    const recap = await processor.handleTurn({
      sessionId,
      turnId: `t${turnNo++}`,
      userText: 'I have to go now.',
    });
    const recapScore = scoreTurn(recap.say);
    expect(
      passesRubric(recapScore),
      `recap failed rubric: "${recap.say}" — ${recapScore.reasons.join('; ')}`,
    ).toBe(true);

    // The safety turns from the same processor carry required content and pass the
    // safety rubric.
    const crisis = await processor.handleTurn({
      sessionId,
      turnId: `t${turnNo++}`,
      userText: 'I want to die.',
    });
    expect(passesRubric(scoreTurn(crisis.say, { safety: true }), true)).toBe(true);

    const refusal = await processor.handleTurn({
      sessionId,
      turnId: `t${turnNo++}`,
      userText: 'How much morphine can I give him?',
    });
    expect(passesRubric(scoreTurn(refusal.say, { safety: true }), true)).toBe(true);
  });
});
