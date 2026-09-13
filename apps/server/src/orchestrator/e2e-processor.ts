import {
  turnContractSchema,
  type CareTeam,
  type ModeOutput,
  type TurnContract,
} from '@turtle/shared';
import type { LlmProvider, LlmRunOptions } from '../services/llm/index.js';
import { createCannedLlmProvider } from '../services/llm/index.js';
import type { Orchestrator } from './index.js';
import { classifySafety } from './safety.js';
import { composeMedicalRefusal, assertSpokenAndShown } from './guardrail.js';
import { composeCrisisResponse, assertCrisisSpokenAndShown } from './crisis.js';
import { routeByRules, isLogRetrievalQuery } from './mode-router.js';
import { checkinOpener } from './checkin.js';
import { runLog } from './log.js';
import { qaDecline } from './qa.js';
import { runRecap, isClosingPhrase } from './recap.js';

/**
 * A zero-key, deterministic orchestrator wiring for end-to-end tests (Task 38).
 *
 * The gateway's `TurnProcessor` seam (gateway/index.ts) turns committed user text into
 * a validated {@link TurnContract}. In production the composition root wires the real,
 * key-backed modes behind it; until then `apps/server/src/index.ts` runs the gateway
 * with no processor (the canned stub). Neither of those lets an end-to-end test drive
 * the FULL turn brain deterministically with zero API keys.
 *
 * This module is that missing wiring, assembled ONLY from the pieces that are already
 * deterministic and key-free, so the whole conversation spine — the safety-first order
 * of operations, mode routing, cards, flags, and the CLOSING recap — runs end-to-end
 * over the real WebSocket gateway with no providers configured (the app boots with zero
 * keys, per R1.2 / R16.4). It is the processor the E2E, conversation-quality, and
 * latency-target suites drive.
 *
 * ORDER OF OPERATIONS (safety.md §Order of operations — BINDING). Every turn:
 *   1. The safety classifier runs FIRST on the raw user text, before any routing.
 *      - `crisis`  → the crisis protocol ({@link composeCrisisResponse}); bypass routing.
 *      - `medical` → the guardrail refusal ({@link composeMedicalRefusal}); bypass routing.
 *      Both are spoken AND shown (enforced in code by the assertions below) and carry
 *      their owner-review flag.
 *   2. Otherwise a CLOSING phrase closes the session with a recap (spoken AND shown).
 *   3. Otherwise the mode router picks a small routed prompt:
 *      - `log`  → care-log dictation extraction (structured entries + retained card) OR,
 *                 for a retrieval question, a plain recall line (no store here → no match).
 *      - `qa`   → grounded Q&A; with no KB wired the grounded behavior is the decline
 *                 line ("I don't know — this is one for your care team"), never a guess.
 *      - `prep` → appointment/prep talk; with no appointment store wired this degrades to
 *                 the warm check-in acknowledgement (nothing to brief).
 *      - `checkin` (default) → the supportive acknowledgement via the canned provider.
 *
 * DETERMINISM. The safety classifier, guardrail/crisis/recap composers, and the mode
 * router are all pure and LLM-free. The check-in / log paths use an LLM provider that
 * defaults to the canned/echo provider (`live === false`), so every path is fully
 * deterministic and produces a contract-valid output with zero keys. The composer that
 * produces `say` never fabricates cards, memory, or safety behavior beyond what the
 * deterministic composers emit.
 *
 * This is NOT the production orchestrator (that wires the real key-backed modes, RAG,
 * and appointment store). It is a faithful, deterministic slice of the same spine whose
 * SAFETY and CLOSING behavior is identical to production because it calls the exact same
 * composers, so the end-to-end assertions about crisis / refusal / recap are meaningful.
 */
export interface E2eProcessorDeps {
  /**
   * The patient care team, so a medical refusal can name a dialable contact and the
   * crisis card can name an additional human (R5.4 / R13.2). Optional; when absent the
   * composers redirect to the care team generally.
   */
  careTeam?: CareTeam | null;
  /**
   * The LLM provider for the check-in / log paths. Defaults to the canned/echo provider
   * so the processor is zero-key. Tests may inject a fake live provider.
   */
  llm?: LlmProvider;
  /** Timeout/timer knobs forwarded to the mode runners. Injectable for tests. */
  runOptions?: LlmRunOptions;
}

/**
 * Build a deterministic {@link Orchestrator} that runs the safety-first turn spine end
 * to end with zero keys. The returned processor satisfies the gateway's `TurnProcessor`
 * seam directly, so it can be handed to `createGateway({ processor })`.
 */
export function createE2eProcessor(deps: E2eProcessorDeps = {}): Orchestrator {
  const careTeam = deps.careTeam ?? null;
  const llm = deps.llm ?? createCannedLlmProvider();
  const runOptions = deps.runOptions;

  return {
    async handleTurn({ sessionId, turnId, userText }): Promise<TurnContract> {
      // 1) SAFETY FIRST — on the raw text, before any routing (R5.1).
      const verdict = classifySafety(userText);
      if (verdict === 'crisis') {
        const out = composeCrisisResponse(careTeam);
        // Belt-and-suspenders: never ship a card-only / spoken-only crisis turn (R13.5).
        assertCrisisSpokenAndShown(out);
        // Crisis does NOT continue normal conversation; it settles to WAITING (R13.1).
        return finalize(sessionId, turnId, out, 'WAITING');
      }
      if (verdict === 'medical') {
        const out = composeMedicalRefusal(careTeam);
        assertSpokenAndShown(out);
        return finalize(sessionId, turnId, out, 'WAITING');
      }

      // 2) A closing phrase ends the session with a recap (spoken AND shown, R2.6/R14).
      if (isClosingPhrase(userText)) {
        const out = await runRecap({ llm, coveredTopics: [], runOptions });
        return finalize(sessionId, turnId, out, 'CLOSING');
      }

      // 3) Normal routing (safety = none). Rules-first; default check-in.
      const mode = routeByRules(userText) ?? 'checkin';
      const out = await runMode(mode, userText, { llm, runOptions });
      return finalize(sessionId, turnId, out, 'WAITING');
    },
  };
}

/**
 * Run the resolved mode's deterministic path and return its {@link ModeOutput}.
 *
 * `qa` and `prep` intentionally use their zero-dependency behavior here: with no KB /
 * appointment store wired, grounded Q&A is the decline line (never a guess, R8.3) and
 * prep talk falls back to the warm check-in acknowledgement (nothing to brief). `log`
 * runs the real extraction so a dictation still yields structured entries + a retained
 * card; a log RETRIEVAL question with no store returns a warm acknowledgement.
 */
async function runMode(
  mode: 'checkin' | 'qa' | 'log' | 'prep',
  userText: string,
  ctx: { llm: LlmProvider; runOptions?: LlmRunOptions },
): Promise<ModeOutput> {
  switch (mode) {
    case 'qa':
      // No KB wired → grounded behavior is the decline line (R8.3), never a guess.
      return qaDecline();
    case 'log':
      // A log RETRIEVAL question has no store to read here; answer warmly via check-in
      // rather than fabricating a match. A log DICTATION runs the real extraction.
      if (isLogRetrievalQuery(userText)) return checkinAck(ctx.llm, userText);
      return runLog(userText, { llm: ctx.llm, runOptions: ctx.runOptions });
    case 'prep':
      // No appointment store wired → nothing to brief; acknowledge warmly.
      return checkinAck(ctx.llm, userText);
    case 'checkin':
    default:
      return checkinAck(ctx.llm, userText);
  }
}

/**
 * The supportive check-in acknowledgement via the LLM provider. With the canned/echo
 * provider (zero-key) this is a warm, honest acknowledgement with no cards, no memory,
 * and the `none` flag — never fabricated safety or artifact behavior. Uses the shared
 * {@link checkinOpener} shape as a safe floor if the provider yields nothing usable.
 */
async function checkinAck(llm: LlmProvider, userText: string): Promise<ModeOutput> {
  try {
    const out = await llm.complete([
      {
        role: 'system',
        content:
          'You are Turtle, a warm voice companion for a caregiver. Reply briefly and ' +
          'supportively. No advice, no clinical content.',
      },
      { role: 'user', content: userText },
    ]);
    if (out.say && out.say.trim().length > 0) return out;
  } catch {
    /* fall through to the safe opener floor */
  }
  return checkinOpener();
}

/**
 * Assemble a validated {@link TurnContract} from a mode output. The gateway fills the
 * assistant state on the client via its own state machine, but the contract still
 * carries the terminal `state` the gateway settles to (WAITING for a normal turn,
 * CLOSING when the session is ending). Validated against the spine before it ships.
 */
function finalize(
  sessionId: string,
  turnId: string,
  out: ModeOutput,
  state: 'WAITING' | 'CLOSING',
): TurnContract {
  return turnContractSchema.parse({
    session_id: sessionId,
    turn_id: turnId,
    state,
    say: out.say,
    cards: out.cards,
    memory_ops: out.memory_ops,
    flags: out.flags,
  });
}
