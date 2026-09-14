'use client';

import { cn } from '@/lib/utils';
import { Mic, MessageSquare } from 'lucide-react';

export interface TabItem {
  value: string;
  label: string;
}

interface TabsProps {
  items: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
}

/**
 * Minimalist icon-only tab switch (ElevenLabs style).
 */
export function Tabs({ items, value, onValueChange, className }: TabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Conversation mode"
      className={cn('inline-flex items-center gap-1 rounded-full bg-[#f1f5f9] p-1 border border-[#cbd5e1]', className)}
    >
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            role="tab"
            aria-selected={selected}
            aria-label={item.label}
            title={item.label}
            tabIndex={selected ? 0 : -1}
            onClick={() => onValueChange(item.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                const dir = e.key === 'ArrowRight' ? 1 : -1;
                const next = items[(index + dir + items.length) % items.length];
                if (next) onValueChange(next.value);
              }
            }}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-full transition-all duration-150 cursor-pointer',
              selected
                ? 'bg-[#1d4ed8] text-white shadow-xs'
                : 'text-[#64748b] hover:text-[#0b192c] hover:bg-[#e2e8f0]',
            )}
          >
            {item.value === 'voice' ? (
              <Mic className={cn('h-4 w-4', selected && 'text-[#fbbf24]')} />
            ) : (
              <MessageSquare className="h-4 w-4" />
            )}
          </button>
        );
      })}
    </div>
  );
}
