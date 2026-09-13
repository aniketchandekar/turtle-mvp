import type { Card, CardRecord, CardStatus } from '@turtle/shared';
import type { Repositories } from '../../store/index.js';

/**
 * Card service and lifecycle (Task 23, R10.1/R10.4/R10.6).
 *
 * Cards are persisted ONLY from the validated orchestrator contract — never inferred
 * client-side (spine invariant; R10.1). This service owns the write path and the
 * lifecycle so those rules live in one testable place.
 *
 * Lifecycle (design.md §Card service):
 *
 *     active ─▶ dismissed ─┐
 *        │                 ├─▶ (archived)
 *        └───▶ done ───────┘
 *
 * There is no distinct stored `archived` status. The stored statuses are exactly
 * `active | dismissed | done` (data model, §18) and the archive is the UNION of the
 * two terminal statuses: a card is "archived" the moment it leaves `active`. Voice and
 * REST retrieval of "archived" therefore reads dismissed + done together (R10.4). This
 * keeps the DB column, the contract, and the client all on the same three-value set
 * while honoring the "→ archived" lifecycle language.
 *
 * Max-one-active (R10.6): at most one card may be `active` at a time in the MVP.
 * `emit` enforces this on the write path by archiving whatever active card exists
 * before the new one is persisted, so the invariant holds no matter how many turns
 * emit cards. The contract schema already caps a single turn at one card; this service
 * enforces the invariant ACROSS turns.
 */

/** The pseudo-status used by voice/REST to read the archive (dismissed + done). */
export const ARCHIVED_STATUS = 'archived' as const;
export type ArchivedStatus = typeof ARCHIVED_STATUS;

/** Query statuses the service can list by: a stored status, or the archived view. */
export type CardListStatus = CardStatus | ArchivedStatus;

/** The two terminal statuses that make up the archive. */
export const ARCHIVE_STATUSES: readonly CardStatus[] = ['dismissed', 'done'] as const;

/**
 * When an active card is superseded by a newly emitted one, it is archived as
 * `dismissed` (it was neither acted on nor completed — it simply made way).
 */
export const SUPERSEDED_STATUS: CardStatus = 'dismissed';

export interface CardService {
  /**
   * Persist a card emitted by a turn contract, enforcing max-one-active (R10.1/R10.6).
   * Any currently-active card is first archived (→ dismissed) so exactly one active
   * card remains. Returns the newly persisted active card.
   */
  emit(sessionId: string, card: Card): Promise<CardRecord>;
  /**
   * Transition a card's lifecycle status (R10.4). Only `active → dismissed | done`
   * is a meaningful transition; the archive is those terminal states. Returns the
   * updated card, or null if no such card exists.
   */
  setStatus(cardId: string, status: CardStatus): Promise<CardRecord | null>;
  /**
   * List cards by status. `active`/`dismissed`/`done` read the stored status directly;
   * `archived` reads the union of dismissed + done (R10.4). Newest first.
   */
  list(status: CardListStatus): Promise<CardRecord[]>;
}

/** Dependencies for the card service (DI style, mirroring the sibling services). */
export interface CardServiceDeps {
  repos: Repositories;
}

/** True if `status` is the archived view rather than a stored status. */
export function isArchivedStatus(status: CardListStatus): status is ArchivedStatus {
  return status === ARCHIVED_STATUS;
}

/**
 * Create the card service.
 *
 * @param deps - store repos.
 */
export function createCardService(deps: CardServiceDeps): CardService {
  const { repos } = deps;

  return {
    async emit(sessionId: string, card: Card): Promise<CardRecord> {
      // R10.6: enforce max-one-active BEFORE inserting the new card. Any card still
      // `active` (from an earlier turn) is archived so it no longer competes for the
      // single active slot. Cards come only from the contract, never inferred (R10.1).
      for (const existing of repos.card.listByStatus('active')) {
        repos.card.setStatus(existing.id, SUPERSEDED_STATUS);
      }

      return repos.card.create({
        session_id: sessionId,
        type: card.type,
        title: card.title,
        body: card.body,
        action: card.action ? { kind: card.action.kind, target: card.action.target } : null,
      });
    },

    async setStatus(cardId: string, status: CardStatus): Promise<CardRecord | null> {
      const card = repos.card.get(cardId);
      if (!card) return null;
      repos.card.setStatus(cardId, status);
      return { ...card, status };
    },

    async list(status: CardListStatus): Promise<CardRecord[]> {
      // R10.4: "archived" is the union of the terminal statuses, not a stored value.
      if (isArchivedStatus(status)) return repos.card.listArchived();
      return repos.card.listByStatus(status);
    },
  };
}
