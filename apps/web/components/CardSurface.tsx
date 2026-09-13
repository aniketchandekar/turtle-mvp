'use client';

import { useEffect, useRef } from 'react';
import type { Card, CardActionKind } from '@turtle/shared';
import { cn } from '@/lib/utils';

interface Props {
  /** The single active card, or null when nothing should show (max one active). */
  card: Card | null;
  /**
   * A card action was tapped. Voice parity (R16.8): this emits `card_action` up the
   * socket; the equivalent spoken replies (okay/done/dismiss/call) flow through the
   * normal turn pipeline instead. Receives the persisted card id and the action kind.
   */
  onAction?: (cardId: string, kind: CardActionKind) => void;
  /**
   * The card was dismissed by tap (the "Okay/Dismiss" control). Emits an `acknowledge`
   * card_action for the server lifecycle and clears the local surface.
   */
  onDismiss?: (cardId: string) => void;
}

/**
 * The single card surface (Task 24, R10.1/R10.2/R10.3/R10.5/R16.2/R16.8).
 *
 * A bottom-sheet overlay that renders AT MOST one card, and only the card the server
 * contract emits (never inferred client-side). The parent gates rendering behind the
 * spoken utterance — this component is handed a card only once its speech has finished
 * (R10.3/R16.2) — so it simply presents what it is given. When `card` is null it
 * renders nothing, leaving no-card sessions as mic + transcript only (R10.5).
 *
 * Anatomy (R10.2): title, ≤3-line body, and at most one action button plus a dismiss.
 * Both the tap actions here and the spoken okay/done/dismiss/call have parity (R16.8):
 * taps send `card_action`; voice goes through the turn pipeline.
 *
 * Accessibility: the sheet is a labelled `role="dialog"` with a heading; the primary
 * action gets focus on appearance; Escape dismisses. Large tap targets (≥44px) and
 * readable type throughout.
 */
export function CardSurface({ card, onAction, onDismiss }: Props) {
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const dismissRef = useRef<HTMLButtonElement | null>(null);

  // Move focus onto the card when it appears so a keyboard/screen-reader user lands on
  // it. Prefer the primary action; fall back to dismiss when there is no action.
  useEffect(() => {
    if (!card) return;
    (actionRef.current ?? dismissRef.current)?.focus();
  }, [card]);

  if (!card) return null;

  // Contract cards forwarded by the gateway carry the persisted id (voice parity).
  // Absent an id we still render (never inferred behavior), but taps can't be routed,
  // so the action buttons are inert rather than sending an unresolvable card_action.
  const cardId = card.id ?? null;

  const dismiss = () => {
    if (cardId) onDismiss?.(cardId);
  };

  const runAction = () => {
    if (cardId && card.action) onAction?.(cardId, card.action.kind);
  };

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-labelledby="card-title"
      aria-describedby="card-body"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          dismiss();
        }
      }}
      className={cn(
        'mt-3 rounded-2xl border-l-4 bg-card p-4 soft',
        card.type === 'safety' && 'border-l-destructive',
        card.type === 'actionable' && 'border-l-primary',
        card.type === 'retained' && 'border-l-accent',
      )}
    >
      <h2 id="card-title" className="m-0 mb-1.5 text-lg font-bold">
        {card.title}
      </h2>
      {/* ≤3-line body (R10.2): clamp so long bodies never grow the sheet. */}
      <p id="card-body" className="m-0 mb-3 line-clamp-3 text-muted-foreground">
        {card.body}
      </p>
      <div className="flex gap-2.5">
        {card.action && (
          <button
            ref={actionRef}
            type="button"
            onClick={runAction}
            disabled={!cardId}
            aria-label={actionAriaLabel(card.action.kind, card.title)}
            className="h-11 rounded-xl bg-primary px-4 font-bold text-primary-foreground soft transition-all duration-200 hover:scale-[1.02] active:scale-95 disabled:opacity-50 disabled:hover:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {actionLabel(card.action.kind)}
          </button>
        )}
        <button
          ref={dismissRef}
          type="button"
          onClick={dismiss}
          disabled={!cardId}
          aria-label={`Dismiss ${card.title}`}
          className="h-11 rounded-xl bg-card px-4 text-foreground soft transition-all duration-200 hover:scale-[1.02] active:scale-95 disabled:opacity-50 disabled:hover:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Dismiss
        </button>
      </div>
    </aside>
  );
}

/** Visible label for the single action button, by action kind. */
function actionLabel(kind: CardActionKind): string {
  switch (kind) {
    case 'call':
      return 'Call';
    case 'link':
      return 'Open';
    case 'share':
      return 'Share';
    case 'acknowledge':
    default:
      return 'Okay';
  }
}

/** Descriptive accessible name that pairs the action with the card it acts on. */
function actionAriaLabel(kind: CardActionKind, title: string): string {
  switch (kind) {
    case 'call':
      return `Call — ${title}`;
    case 'link':
      return `Open — ${title}`;
    case 'share':
      return `Share — ${title}`;
    case 'acknowledge':
    default:
      return `Okay — ${title}`;
  }
}
