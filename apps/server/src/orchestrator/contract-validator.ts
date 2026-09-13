import {
  modeOutputSchema,
  turnContractSchema,
  safeFallbackContract,
  type AssistantState,
  type Card,
  type MemoryOp,
  type ModeOutput,
  type TurnContract,
} from '@turtle/shared';
import type { Repositories } from '../store/index.js';
import { SUPERSEDED_STATUS } from '../services/cards/index.js';

/**
 * Contract validation and repair (Task 15, R6.1–R6.3/R6.5).
 *
 * This is the "validate before speaking" gate from the architectural invariants:
 * every mode response is parsed against the Zod contract BEFORE TTS. The flow,
 * straight from design.md §Error Handling ("Contract schema failure → one repair
 * regeneration → then safe fallback line, no cards"):
 *
 *   raw mode output ──parse──▶ ok? ──▶ assemble TurnContract
 *        │ fail                          ▲
 *        ▼                               │
 *   regenerate ONCE with a repair    ok? │
 *   instruction ──parse────────────────┘
 *        │ fail
 *        ▼
 *   safe fallback line, NO cards (R6.3)
 *
 * Once a valid contract exists, `memory_ops` are applied to the store (R6.5) and the
 * turn + any cards are persisted. Cards and memory flow ONLY from the validated
 * contract — never inferred elsewhere (spine invariant).
 *
 * Everything reachable here is injectable (the regenerate step, the store repos, the
 * fact sink, the clock) so the whole surface — valid / invalid-then-repair /
 * fallback / memory-ops — is unit-testable with zero network and no real LLM.
 */

/** The subset the orchestrator adds around a mode output to form a full contract. */
export interface TurnMeta {
  sessionId: string;
  turnId: string;
  /** Assistant state to stamp on the contract (default WAITING after a turn). */
  state?: AssistantState;
}

/**
 * Regenerate a mode output with a repair instruction appended. Implementations
 * re-run the same routed mode prompt with an added "your previous output failed
 * validation, return ONLY valid JSON…" message. Returns the raw (still-unvalidated)
 * candidate; the validator parses it. Injected so tests can drive the repair path.
 */
export type RepairFn = (validationError: string) => Promise<unknown>;

/**
 * Sink for `set_fact` memory ops. The MVP store has a `log_entry` table (the concrete
 * memory store for `append_log`) but no generic fact table yet; the memory service
 * (Task 19) owns fact assembly. Task 15 applies `append_log` to the log repository
 * directly and routes `set_fact` through this injectable sink so fact storage can be
 * wired in without changing this module. Optional — unset facts are simply skipped.
 */
export type FactSink = (key: string, value: string) => void;

export interface ContractValidatorDeps {
  repos: Repositories;
  /** Patient the turn's log ops belong to. Required to apply `append_log`. */
  patientId?: string;
  /** Optional sink for `set_fact` ops (see {@link FactSink}). */
  factSink?: FactSink;
  /** Clock for `append_log` default timestamps. Injectable for deterministic tests. */
  now?: () => string;
}

/** Result of validating (and possibly repairing) a mode output. */
export interface ValidationResult {
  contract: TurnContract;
  /** How the contract was produced — useful for observability/tests. */
  outcome: 'valid' | 'repaired' | 'fallback';
}

/**
 * Validate a raw mode output into a full `TurnContract`, repairing once on failure
 * and falling back safely if the repair also fails (R6.1–R6.3).
 *
 * @param raw     - the mode runner's output (unknown shape until parsed).
 * @param meta    - session/turn ids + optional assistant state to stamp.
 * @param repair  - regenerate-once function; called only if the first parse fails.
 */
export async function validateOrRepair(
  raw: unknown,
  meta: TurnMeta,
  repair: RepairFn,
): Promise<ValidationResult> {
  const state: AssistantState = meta.state ?? 'WAITING';

  const first = tryParseModeOutput(raw);
  if (first.ok) {
    return { contract: toContract(first.value, meta, state), outcome: 'valid' };
  }

  // R6.2: one repair regeneration with the validation error as the instruction.
  let repaired: unknown;
  try {
    repaired = await repair(first.error);
  } catch {
    // A thrown/failed regeneration is treated the same as an invalid one → fallback.
    return { contract: safeFallbackContract(meta.sessionId, meta.turnId, state), outcome: 'fallback' };
  }

  const second = tryParseModeOutput(repaired);
  if (second.ok) {
    return { contract: toContract(second.value, meta, state), outcome: 'repaired' };
  }

  // R6.3: repair still failed → safe fallback line, NO cards.
  return { contract: safeFallbackContract(meta.sessionId, meta.turnId, state), outcome: 'fallback' };
}

/** Parse an unknown into a `ModeOutput`, capturing the Zod error message on failure. */
function tryParseModeOutput(
  raw: unknown,
): { ok: true; value: ModeOutput } | { ok: false; error: string } {
  const result = modeOutputSchema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: result.error.message };
}

/**
 * Assemble a full `TurnContract` from a validated `ModeOutput` + turn meta, then
 * re-validate the whole thing. The re-parse is belt-and-suspenders: it guarantees
 * the object we hand to TTS/persistence satisfies the full spine schema (e.g. non-empty
 * session_id/turn_id), and it normalizes defaults.
 */
function toContract(output: ModeOutput, meta: TurnMeta, state: AssistantState): TurnContract {
  return turnContractSchema.parse({
    session_id: meta.sessionId,
    turn_id: meta.turnId,
    state,
    say: output.say,
    cards: output.cards,
    memory_ops: output.memory_ops,
    flags: output.flags,
  });
}

/**
 * Apply a contract's `memory_ops` to the store (R6.5).
 *
 *   - `append_log`      → creates a `log_entry` for the patient (the concrete memory store).
 *   - `add_appointment` → creates an `appointment` for the patient (Task 28, R12.1).
 *   - `set_fact`        → routed through the optional {@link FactSink}.
 *
 * `append_log` and `add_appointment` ops are skipped (not errored) when no `patientId`
 * is configured, so a turn that produced a patient-scoped op before a patient profile
 * exists degrades gracefully rather than throwing mid-turn. Returns the count of ops
 * actually applied.
 */
export function applyMemoryOps(ops: MemoryOp[], deps: ContractValidatorDeps): number {
  const now = deps.now ?? (() => new Date().toISOString());
  let applied = 0;
  for (const op of ops) {
    if (op.op === 'append_log') {
      if (!deps.patientId) continue; // no patient yet → nothing to attach the log to
      deps.repos.logEntry.create({
        patient_id: deps.patientId,
        at: op.at ?? now(),
        category: op.category,
        text: op.text,
        structured: null,
      });
      applied++;
    } else if (op.op === 'add_appointment') {
      // (Task 28, R12.1) A dictated appointment is stored in the patient profile. Like
      // append_log this flows only from the validated contract; the store assigns the
      // id and defaults the status to `upcoming`.
      if (!deps.patientId) continue; // no patient yet → nothing to attach the appt to
      deps.repos.appointment.create({
        patient_id: deps.patientId,
        title: op.title,
        at: op.at,
        with_whom: op.with_whom ?? null,
        purpose: op.purpose ?? null,
      });
      applied++;
    } else {
      // set_fact
      if (deps.factSink) {
        deps.factSink(op.key, op.value);
        applied++;
      }
    }
  }
  return applied;
}

/** Ids of the persisted card rows created from a contract (in contract order). */
export interface PersistResult {
  cardIds: string[];
}

/** Optional per-turn extras persisted alongside the contract (off the spine). */
export interface PersistOptions {
  /**
   * KB chunk ids retrieved for this turn (Q&A mode, Task 22, R8.1). Stored on the
   * assistant turn's `retrieved_chunk_ids` so the grounding provenance is auditable.
   * Non-Q&A turns omit this and the column stays `[]`.
   */
  retrievedChunkIds?: string[];
}

/**
 * Persist the assistant turn and any cards from a validated contract, and apply its
 * `memory_ops`. This is the single write path off the spine (design.md turn flow
 * step 5: "applies `memory_ops`; persists cards/turn").
 *
 * The assistant turn text is the `say`; the turn's `flag` mirrors the first non-`none`
 * contract flag (crisis / medical_refusal) for owner-review marking. Cards are created
 * from `contract.cards` only. The Q&A mode passes `options.retrievedChunkIds` so the
 * turn records which chunks grounded the answer (R8.1); other modes leave it empty.
 *
 * @param contract - the validated turn contract.
 * @param deps     - store repos + patient/fact wiring for `memory_ops`.
 * @param options  - optional per-turn extras (e.g. retrieved chunk ids for Q&A).
 */
export function persistTurn(
  contract: TurnContract,
  deps: ContractValidatorDeps,
  options: PersistOptions = {},
): PersistResult {
  // 1) Apply memory ops (R6.5) before persisting the turn artifacts.
  applyMemoryOps(contract.memory_ops, deps);

  // 2) Persist the assistant turn text.
  const seq = deps.repos.turn.nextSeq(contract.session_id);
  const flag = contract.flags.find((f) => f !== 'none') ?? null;
  deps.repos.turn.create({
    id: contract.turn_id,
    session_id: contract.session_id,
    seq,
    speaker: 'assistant',
    text: contract.say,
    asr_conf: null,
    retrieved_chunk_ids: options.retrievedChunkIds ?? [],
    flag,
    latency_ms: null,
  });

  // 3) Persist any cards from the contract (never inferred elsewhere; R10.1).
  const cardIds = contract.cards.map((card) => persistCard(card, contract.session_id, deps).id);

  return { cardIds };
}

/**
 * Persist a single contract card as a `card` row (status defaults to active).
 *
 * Enforces max-one-active (R10.6) on the write path: any card still `active` from an
 * earlier turn is archived (→ dismissed) before the new one is inserted, so exactly
 * one active card ever remains. This mirrors {@link createCardService}.emit — kept
 * inline here so the synchronous persist path stays synchronous, with the service as
 * the canonical async API for REST/voice retrieval and lifecycle changes.
 */
function persistCard(card: Card, sessionId: string, deps: ContractValidatorDeps) {
  for (const existing of deps.repos.card.listByStatus('active')) {
    deps.repos.card.setStatus(existing.id, SUPERSEDED_STATUS);
  }
  return deps.repos.card.create({
    session_id: sessionId,
    type: card.type,
    title: card.title,
    body: card.body,
    action: card.action ? { kind: card.action.kind, target: card.action.target } : null,
  });
}

/**
 * End-to-end finalizer used by the orchestrator: validate/repair a raw mode output,
 * then persist the turn + cards and apply memory ops. Returns the validated contract
 * (ready for TTS) alongside the outcome and persisted card ids.
 */
export async function finalizeTurn(
  raw: unknown,
  meta: TurnMeta,
  repair: RepairFn,
  deps: ContractValidatorDeps,
  options: PersistOptions = {},
): Promise<{ contract: TurnContract; outcome: ValidationResult['outcome']; cardIds: string[] }> {
  const { contract, outcome } = await validateOrRepair(raw, meta, repair);
  const { cardIds } = persistTurn(contract, deps, options);
  return { contract, outcome, cardIds };
}
