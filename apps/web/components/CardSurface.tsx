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
  /** Placement is owned by the parent surface (bottom for text, beside the orb for voice). */
  className?: string;
}

/**
 * ElevenLabs-style minimalist CardSurface for Actionable, Safety, and Retained cards.
 */
export function CardSurface({ card, onAction, onDismiss, className }: Props) {
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
  const hasLinks = Boolean(card.links?.length);

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
        'w-full max-w-md rounded-[24px] bg-white border border-[#cbd5e1] p-5 shadow-[0_16px_48px_rgba(11,25,44,0.12)] transition-all duration-200 text-[#0b192c]',
        isSafety && 'border-[#facc15] bg-[#fefce8] shadow-[0_16px_48px_rgba(202,138,4,0.16)]',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-xs font-bold',
              isSafety && 'bg-[#fef08a] text-[#b45309]',
              isActionable && 'bg-[#eff6ff] text-[#1d4ed8]',
              isRetained && 'bg-[#eff6ff] text-[#1d4ed8]',
            )}
          >
            {isSafety && <AlertTriangle className="h-3.5 w-3.5" />}
            {isActionable && <Calendar className="h-3.5 w-3.5" />}
            {isRetained && <FileText className="h-3.5 w-3.5" />}
          </span>
          <h2 id="card-title" className="m-0 text-sm font-bold text-[#0b192c]">
            {card.title}
          </h2>
        </div>

        <button
          onClick={dismiss}
          aria-label={`Dismiss ${card.title}`}
          className="text-[#64748b] hover:text-[#0b192c] p-1 rounded-md hover:bg-[#f1f5f9] transition-colors cursor-pointer"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <p id="card-body" className="m-0 mb-3 text-xs text-[#475569] leading-relaxed pl-8">
        {card.body}
      </p>

      {hasLinks ? (
        <div className="mb-3 space-y-1.5 pl-8">
          {card.links!.map((link) => (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              onClick={() => {
                if (cardId) onAction?.(cardId, 'link');
              }}
              className="group flex items-center justify-between gap-3 rounded-lg border border-[#cbd5e1] bg-white px-3 py-1.5 text-xs text-[#0b192c] font-semibold transition hover:border-[#1d4ed8] hover:bg-[#eff6ff]"
            >
              <span className="truncate">{link.title}</span>
              <ExternalLink className="h-3 w-3 shrink-0 text-[#64748b] transition group-hover:text-[#1d4ed8]" aria-hidden="true" />
            </a>
          ))}
        </div>
      ) : null}

      <div className="flex justify-end gap-2 pt-1">
        <button
          ref={dismissRef}
          type="button"
          onClick={dismiss}
          disabled={!cardId}
          className="h-8 rounded-lg bg-[#f1f5f9] border border-[#cbd5e1] px-3 text-[11px] font-bold text-[#475569] transition-colors hover:text-[#0b192c] hover:bg-[#e2e8f0] active:scale-95 disabled:opacity-50 cursor-pointer"
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
              'flex items-center gap-1.5 h-8 rounded-lg px-3.5 text-[11px] font-bold transition-all active:scale-95 disabled:opacity-50 cursor-pointer shadow-xs',
              isSafety
                ? 'bg-[#f59e0b] hover:bg-[#d97706] text-[#0b192c] shadow-[0_4px_14px_rgba(245,158,11,0.3)]'
                : 'bg-[#1d4ed8] hover:bg-[#1e40af] text-white',
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
