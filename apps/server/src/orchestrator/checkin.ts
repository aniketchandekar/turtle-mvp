import { CHECKIN_OPENER, modeOutputSchema, type ModeOutput } from '@turtle/shared';
import type { LlmMessage, LlmProvider, LlmRunOptions } from '../services/llm/index.js';
import { runMode } from '../services/llm/index.js';
import type { AssembledContext, MemoryService } from '../services/memory/index.js';
import type { Mode, ModeRunner } from './index.js';

/**
 * Check-in mode (Task 20, R7.1–R7.4).
 *
 * The supportive, memory-aware conversation that is the product's default mode
 * (design.md §Mode router: `checkin` is `DEFAULT_MODE`). It is one of the small
 * routed prompts — NOT a god-prompt — so it owns exactly one thing: warm, brief
 * conversation that validates the caregiver's feelings and, sparingly, offers help.
 *
 * The behavioral contract (product.md §Conversation quality bar; R7.1–R7.4):
 *
 *   R7.1 — Session opener. When a session OPENS (before the first user turn), Turtle
 *          speaks the check-in opener {@link CHECKIN_OPENER}
 *          ("How are you holding up — honestly?"). See {@link checkinOpener}.
 *   R7.2 — Listen and validate, offering AT MOST ONE concrete coping suggestion per
 *          SESSION. This is a cross-turn budget, not a per-turn rule, so it is
 *          threaded through an injectable {@link SuggestionBudget} (see below).
 *   R7.3 — Ground follow-ups in prior session themes when they exist ("Last time you
 *          mentioned the nausea — how's that going?"). The prior-session summaries
 *          come from the injected {@link MemoryService} (Task 19) and are folded into
 *          the system prompt as RECALL — never as advice.
 *   R7.4 — Keep turns SHORT and aim to close the session naturally within 5–10
 *          minutes. Brevity is instructed in the system prompt.
 *
 * (R7.5 — the recap/close — is Task 32 and out of scope here.)
 *
 * DESIGN NOTE — why the coping-suggestion budget is injected, not inferred.
 * `ModeRunner.run(userText)` sees only the current user text, so "at most one
 * suggestion per session" cannot be enforced from a single turn's inputs. Rather than
 * smuggle session state into the prompt or infer it client-side (which the spine
 * forbids), the budget is a tiny session-scoped seam supplied by the factory. The
 * runner READS the budget to decide whether to permit a coping suggestion this turn,
 * folds that permission into the prompt, and MARKS the budget used once a suggestion
 * is actually emitted. This mirrors the DI style of the sibling modules
 * (mode-router's `record` hook, guardrail's care-team input): everything the runner
 * needs is injected, so the whole surface is unit-testable with fakes and zero network.
 *
 * ZERO-KEY DEGRADATION (R16.4 spirit). With no LLM key the resolved provider is the
 * canned/echo provider (`live === false`). Echoing the caregiver's words is fine for
 * the pipeline but is not a warm check-in, so this runner degrades DELIBERATELY: with
 * a non-live provider it returns a warm, valid fallback line (no cards) rather than
 * relying on model output. The pipeline still runs end-to-end with zero keys.
 *
 * As with the sibling modules, the LLM provider, memory service, suggestion budget,
 * caregiver id, and (for tests) the LLM run options are all injectable.
 */

/** This runner's mode tag (design.md §Orchestrator: small routed prompts). */
const CHECKIN_MODE: Mode = 'checkin';

/**
 * Session-scoped budget for the "at most one coping suggestion per session" rule
 * (R7.2). A tiny two-method seam so the cross-turn constraint can be threaded through
 * `ModeRunner.run` (which only sees the current turn) and driven by a fake in tests.
 *
 * The orchestrator/gateway supplies one instance PER SESSION; the runner reads it to
 * gate whether a coping suggestion is permitted this turn, and marks it used once a
 * suggestion is emitted. An in-memory implementation is available via
 * {@link createSuggestionBudget}.
 */
export interface SuggestionBudget {
  /** True once a concrete coping suggestion has already been offered this session. */
  hasSuggestedThisSession(): boolean;
  /** Record that a coping suggestion has now been offered this session. */
  markSuggested(): void;
}

/**
 * A simple in-memory {@link SuggestionBudget}, scoped to one session. Starts with the
 * budget available; {@link SuggestionBudget.markSuggested} flips it to spent. Create
 * one per session at the composition edge (gateway/orchestrator).
 */
export function createSuggestionBudget(): SuggestionBudget {
  let suggested = false;
  return {
    hasSuggestedThisSession: () => suggested,
    markSuggested: () => {
      suggested = true;
    },
  };
}

/**
 * Base check-in system prompt (R7.2/R7.4; product.md §Conversation quality bar). Small
 * and routed — it instructs ONLY warm, brief, plain conversation, never a full persona
 * or a mix of other modes. The per-turn suggestion permission (R7.2) and any prior-
 * theme recall (R7.3) are appended by {@link buildSystemPrompt} so the base stays
 * stable and testable.
 */
export const CHECKIN_SYSTEM =
  'You are Turtle, a warm voice companion for a single caregiver of someone with a ' +
  'terminal illness. This is a supportive check-in.\n' +
  'How to respond:\n' +
  '- Be warm, brief, and plain-spoken. Keep every turn short — a sentence or two, ' +
  'the way a caring friend speaks. This is a spoken conversation, not an essay.\n' +
  "- Listen first and validate the caregiver's feelings. Reflect what you hear; do " +
  'not rush to fix it.\n' +
  '- No platitudes ("everything happens for a reason"), no advice creep, no lists.\n' +
  '- You are not a clinician. Never give medical, dosing, or prognosis advice.\n' +
  'Reply ONLY with a JSON object of the form ' +
  '{"say": string, "cards": [], "memory_ops": [], "flags": ["none"]}. ' +
  'Put your spoken words in "say" and leave the other fields empty.';

/**
 * Instruction appended when a coping suggestion is STILL AVAILABLE this session
 * (R7.2). Even when permitted, a suggestion is optional and at most one — validation
 * first, help second.
 */
export const SUGGESTION_ALLOWED_INSTRUCTION =
  'If — and only if — it feels genuinely helpful, you may offer ONE small, concrete ' +
  'coping suggestion this turn. At most one for the entire session; prefer simply ' +
  'listening.';

/**
 * Instruction appended when the coping suggestion has ALREADY been spent this session
 * (R7.2). From here on, listen and validate only — no further suggestions.
 */
export const SUGGESTION_SPENT_INSTRUCTION =
  'You have already offered a coping suggestion this session. Do NOT offer another ' +
  'one — simply listen, validate, and be present.';

/**
 * Instruction appended when prior-session themes exist (R7.3). The summaries are the
 * one-line recaps of recent ended sessions (from the memory service). They are RECALL
 * only — a gentle way to ground a follow-up ("last time you mentioned …"), never a
 * springboard for advice or interpretation (product.md "Log, never interpret").
 */
export const PRIOR_THEMES_PREFIX =
  'For context, here are one-line summaries of recent sessions with this caregiver. ' +
  'You MAY gently ground a follow-up question in one of these themes if it fits ' +
  'naturally (e.g. "last time you mentioned the nausea — how is that going?"). Treat ' +
  'them as recall only; never turn them into advice:';

/**
 * The warm fallback line spoken when there is no live LLM (zero-key degradation) or a
 * turn cannot otherwise be produced. Brief, validating, no cards — a real check-in
 * line, not an echo.
 */
export const CHECKIN_FALLBACK_SAY = "I'm here with you. Tell me how today has been.";

/** Dependencies for the check-in runner (DI style, mirroring the sibling modules). */
export interface CheckinDeps {
  /**
   * The resolved LLM provider. When `provider.live === false` (canned/zero-key) the
   * runner does not rely on model output and returns a warm fallback instead.
   */
  llm: LlmProvider;
  /** Memory & context assembly (Task 19), used to ground follow-ups in prior themes. */
  memory: MemoryService;
  /**
   * Session-scoped coping-suggestion budget (R7.2). Supplied once per session by the
   * caller; read to gate suggestions and marked when one is emitted.
   */
  suggestionBudget: SuggestionBudget;
  /** The caregiver whose profile/summaries frame the conversation. */
  caregiverId: string;
  /**
   * Optional timeout/timer knobs forwarded to {@link runMode}. Injectable so tests
   * drive the timeout/retry/park path without real wall-clock waits.
   */
  runOptions?: LlmRunOptions;
}

/**
 * Compose the session opener (R7.1). Returns a valid {@link ModeOutput} that speaks
 * {@link CHECKIN_OPENER} with no cards, no memory ops, no flags. This is used when a
 * session OPENS — before the first user turn — so it takes no user text and never
 * touches the LLM. Validated against the contract before return.
 */
export function checkinOpener(): ModeOutput {
  return modeOutputSchema.parse({
    say: CHECKIN_OPENER,
    cards: [],
    memory_ops: [],
    flags: ['none'],
  });
}

/**
 * Build the full check-in system prompt for a turn: the stable {@link CHECKIN_SYSTEM}
 * base, plus the suggestion-permission instruction chosen from the budget (R7.2), plus
 * any prior-session themes for grounding (R7.3). Kept pure and exported so the exact
 * prompt assembly is unit-testable in isolation.
 *
 * @param context         - assembled memory context (its `recentSummaries` seed R7.3).
 * @param suggestionSpent - whether the session's one coping suggestion is used up.
 */
export function buildSystemPrompt(context: AssembledContext, suggestionSpent: boolean): string {
  const parts: string[] = [CHECKIN_SYSTEM];
  parts.push(suggestionSpent ? SUGGESTION_SPENT_INSTRUCTION : SUGGESTION_ALLOWED_INSTRUCTION);
  if (context.recentSummaries.length > 0) {
    const themes = context.recentSummaries.map((s) => `- ${s}`).join('\n');
    parts.push(`${PRIOR_THEMES_PREFIX}\n${themes}`);
  }
  return parts.join('\n\n');
}

/**
 * A warm fallback {@link ModeOutput} for the zero-key / no-usable-output path. Brief,
 * validating, no cards. Validated against the contract before return.
 */
function checkinFallback(): ModeOutput {
  return modeOutputSchema.parse({
    say: CHECKIN_FALLBACK_SAY,
    cards: [],
    memory_ops: [],
    flags: ['none'],
  });
}

/**
 * Decide whether a produced turn actually OFFERED a coping suggestion, so the budget
 * can be marked (R7.2). The model is not asked to self-report, and the contract has no
 * "suggestion" field, so this is a deliberately conservative heuristic over the spoken
 * text: it looks for imperative/suggestion phrasing ("try", "maybe you could", "it
 * might help to …"). It only ever runs when a suggestion was still PERMITTED this
 * turn, so a false positive merely spends the budget one turn early (safe — errs
 * toward fewer suggestions, which is the product bias). Exported for direct testing.
 */
export function outputOffersSuggestion(output: ModeOutput): boolean {
  const say = output.say.toLowerCase();
  const cues = [
    'you could try',
    'you might try',
    'try to',
    'maybe you could',
    'maybe you can',
    'it might help',
    'it could help',
    'one thing that helps',
    'what helps',
    'consider ',
    'why not ',
  ];
  return cues.some((cue) => say.includes(cue));
}

/**
 * Create the check-in {@link ModeRunner} (Task 20). Each `run(userText)`:
 *
 *   1. Assembles the caregiver's bounded memory context (R7.3) via the injected
 *      memory service, requesting recall so recent log observations are available to
 *      ground follow-ups alongside the prior-session summaries.
 *   2. Builds the small routed system prompt, gating the coping suggestion on the
 *      session budget (R7.2) and folding in prior themes (R7.3).
 *   3. With a LIVE LLM, runs the prompt through {@link runMode} (8s timeout + one
 *      retry + park-the-turn, all inherited from the adapter) and validates the
 *      result against the contract. With a NON-LIVE provider it returns the warm
 *      fallback (zero-key degradation) without consulting the model.
 *   4. When a suggestion was permitted AND the produced turn appears to offer one,
 *      marks the session budget used so no further suggestion is offered (R7.2).
 *
 * @param deps - injectable LLM provider, memory service, suggestion budget, caregiver
 *               id, and optional run options.
 */
export function createCheckinRunner(deps: CheckinDeps): ModeRunner {
  const { llm, memory, suggestionBudget, caregiverId, runOptions } = deps;

  return {
    mode: CHECKIN_MODE,

    async run(userText: string): Promise<ModeOutput> {
      // (R7.3) Bounded memory context. Recall is requested so recent log observations
      // are available to ground a follow-up, alongside prior-session summaries.
      const context = await memory.assemble(caregiverId, { includeRecall: true });

      // Zero-key degradation (R16.4 spirit): a non-live provider only echoes, which is
      // not a warm check-in. Return a valid, warm fallback without touching the model.
      if (!llm.live) return checkinFallback();

      // (R7.2) Gate the coping suggestion on the session budget.
      const suggestionSpent = suggestionBudget.hasSuggestedThisSession();
      const system = buildSystemPrompt(context, suggestionSpent);

      const messages: LlmMessage[] = [
        { role: 'system', content: system },
        { role: 'user', content: userText },
      ];

      // runMode owns the 8s timeout + one retry + park-the-turn policy and always
      // resolves to a valid ModeOutput (never throws mid-turn).
      const output = await runMode(llm, messages, runOptions);
      // Belt-and-suspenders: validate before speaking, matching the sibling modules.
      const validated = modeOutputSchema.parse(output);

      // (R7.2) If a suggestion was still available AND this turn appears to offer one,
      // spend the session budget so no further suggestion is made.
      if (!suggestionSpent && outputOffersSuggestion(validated)) {
        suggestionBudget.markSuggested();
      }

      return validated;
    },
  };
}
