'use client';

import { cn } from '@/lib/utils';
import { Mic, MessageSquare } from 'lucide-react';

export interface TabItem {
  value: string;
  label: string;
  icon?: 'voice' | 'text';
}

interface TabsProps {
  items: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
}

/**
 * Modern segmented glass tab switcher.
 */
export function Tabs({ items, value, onValueChange, className }: TabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Conversation mode"
      className={cn('inline-flex items-center gap-1 rounded-full glass-pill p-1 shadow-inner', className)}
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
              'flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold tracking-wide transition-all duration-200',
              selected
                ? 'bg-gradient-to-r from-teal-500 to-emerald-500 text-slate-950 shadow-md glow-primary font-bold'
                : 'text-slate-400 hover:text-slate-100 hover:bg-white/5',
            )}
          >
            {item.value === 'voice' && <Mic className="h-3.5 w-3.5" />}
            {item.value === 'text' && <MessageSquare className="h-3.5 w-3.5" />}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
