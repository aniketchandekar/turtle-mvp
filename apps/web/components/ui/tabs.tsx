'use client';

import { cn } from '@/lib/utils';

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
 * A calm segmented tab switch (soft-UI). The track is gently recessed; the active tab is
 * a raised soft pill. Keyboard: arrow keys move between tabs.
 */
export function Tabs({ items, value, onValueChange, className }: TabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Conversation mode"
      className={cn('inline-flex gap-1 rounded-full bg-card p-1 soft-inset', className)}
    >
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            role="tab"
            aria-selected={selected}
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
              'min-w-20 rounded-full px-4 py-1.5 text-sm font-bold transition-all duration-200',
              selected
                ? 'bg-primary text-primary-foreground soft'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
