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
 * Modern floating glass CardSurface for Actionable, Safety, and Retained cards.
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
        'mt-4 rounded-2xl glass-panel p-5 shadow-2xl transition-all duration-300 border-t-2',
        isSafety && 'border-t-rose-500 bg-rose-950/40 glow-destructive',
        isActionable && 'border-t-teal-400 bg-slate-900/80 glow-primary',
        isRetained && 'border-t-emerald-400 bg-slate-900/80 glow-accent',
      )}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold shadow-sm',
              isSafety && 'bg-rose-500/20 text-rose-300 border border-rose-500/30',
              isActionable && 'bg-teal-500/20 text-teal-300 border border-teal-500/30',
              isRetained && 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
            )}
          >
            {isSafety && <AlertTriangle className="h-4 w-4" />}
            {isActionable && <Calendar className="h-4 w-4" />}
            {isRetained && <FileText className="h-4 w-4" />}
          </span>
          <h2 id="card-title" className="m-0 text-base font-bold text-slate-100">
            {card.title}
          </h2>
        </div>

        <button
          onClick={dismiss}
          aria-label={`Dismiss ${card.title}`}
          className="text-slate-400 hover:text-slate-100 p-1 rounded-lg hover:bg-white/10 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <p id="card-body" className="m-0 mb-4 line-clamp-3 text-sm text-slate-300 leading-relaxed pl-9">
        {card.body}
      </p>

      <div className="flex justify-end gap-2.5 pt-1">
        <button
          ref={dismissRef}
          type="button"
          onClick={dismiss}
          disabled={!cardId}
          className="h-9 rounded-xl glass-pill px-4 text-xs font-semibold text-slate-300 transition-all duration-200 hover:text-white hover:bg-white/10 active:scale-95 disabled:opacity-50"
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
              'flex items-center gap-1.5 h-9 rounded-xl px-4 text-xs font-bold transition-all duration-200 shadow-md active:scale-95 disabled:opacity-50',
              isSafety
                ? 'bg-rose-600 hover:bg-rose-500 text-white'
                : 'bg-gradient-to-r from-teal-500 to-emerald-500 text-slate-950 hover:opacity-95',
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
      return <Phone className="h-3.5 w-3.5" />;
    case 'link':
      return <ExternalLink className="h-3.5 w-3.5" />;
    case 'share':
      return <Share2 className="h-3.5 w-3.5" />;
    case 'acknowledge':
    default:
      return <Check className="h-3.5 w-3.5" />;
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
