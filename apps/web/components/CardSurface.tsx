'use client';

import { useEffect, useRef } from 'react';
import type { Card, CardActionKind } from '@turtle/shared';
import { cn } from '@/lib/utils';
import { 
  AlertTriangle, 
  Calendar, 
  Phone, 
  ExternalLink, 
  Share2, 
  Check, 
  X,
  FileText 
} from 'lucide-react';

interface Props {
  /** The single active card, or null when nothing should show (max one active). */
  card: Card | null;
  /** A card action was tapped. */
  onAction?: (cardId: string, kind: CardActionKind) => void;
  /** The card was dismissed. */
  onDismiss?: (cardId: string) => void;
}

/**
 * ElevenLabs-style minimalist CardSurface for Actionable, Safety, and Retained cards.
 */
export function CardSurface({ card, onAction, onDismiss }: Props) {
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const dismissRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!card) return;
    (actionRef.current ?? dismissRef.current)?.focus();
  }, [card]);

  if (!card) return null;

  const cardId = card.id ?? null;

  const dismiss = () => {
    if (cardId) onDismiss?.(cardId);
  };

  const runAction = () => {
    if (cardId && card.action) onAction?.(cardId, card.action.kind);
  };

  const isSafety = card.type === 'safety';
  const isActionable = card.type === 'actionable';
  const isRetained = card.type === 'retained';

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
        'mt-3 rounded-2xl bg-[#121215] border border-zinc-800 p-4 shadow-xl transition-all duration-200 text-white',
        isSafety && 'border-rose-800/80 bg-[#160c0e]',
      )}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-bold',
              isSafety && 'bg-rose-500/20 text-rose-400',
              isActionable && 'bg-zinc-800 text-zinc-300',
              isRetained && 'bg-zinc-800 text-zinc-300',
            )}
          >
            {isSafety && <AlertTriangle className="h-3.5 w-3.5" />}
            {isActionable && <Calendar className="h-3.5 w-3.5" />}
            {isRetained && <FileText className="h-3.5 w-3.5" />}
          </span>
          <h2 id="card-title" className="m-0 text-sm font-semibold text-white">
            {card.title}
          </h2>
        </div>

        <button
          onClick={dismiss}
          aria-label={`Dismiss ${card.title}`}
          className="text-zinc-500 hover:text-white p-1 rounded-md hover:bg-zinc-800 transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <p id="card-body" className="m-0 mb-3 text-xs text-zinc-400 leading-relaxed pl-8">
        {card.body}
      </p>

      <div className="flex justify-end gap-2 pt-1">
        <button
          ref={dismissRef}
          type="button"
          onClick={dismiss}
          disabled={!cardId}
          className="h-8 rounded-lg bg-zinc-900 border border-zinc-800 px-3 text-xs font-medium text-zinc-400 transition-colors hover:text-white hover:bg-zinc-800 active:scale-95 disabled:opacity-50 cursor-pointer"
        >
          Dismiss
        </button>

        {card.action && (
          <button
            ref={actionRef}
            type="button"
            onClick={runAction}
            disabled={!cardId}
            aria-label={actionAriaLabel(card.action.kind, card.title)}
            className={cn(
              'flex items-center gap-1.5 h-8 rounded-lg px-3.5 text-xs font-semibold transition-colors active:scale-95 disabled:opacity-50 cursor-pointer',
              isSafety
                ? 'bg-rose-600 hover:bg-rose-500 text-white'
                : 'bg-white text-black hover:bg-zinc-200',
            )}
          >
            {renderActionIcon(card.action.kind)}
            <span>{actionLabel(card.action.kind)}</span>
          </button>
        )}
      </div>
    </aside>
  );
}

function renderActionIcon(kind: CardActionKind) {
  switch (kind) {
    case 'call':
      return <Phone className="h-3 w-3" />;
    case 'link':
      return <ExternalLink className="h-3 w-3" />;
    case 'share':
      return <Share2 className="h-3 w-3" />;
    case 'acknowledge':
    default:
      return <Check className="h-3 w-3" />;
  }
}

function actionLabel(kind: CardActionKind): string {
  switch (kind) {
    case 'call':
      return 'Call Now';
    case 'link':
      return 'Open';
    case 'share':
      return 'Share Link';
    case 'acknowledge':
    default:
      return 'Got it';
  }
}

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
      return `Got it — ${title}`;
  }
}
