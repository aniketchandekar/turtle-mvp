'use client';

import { useState } from 'react';
import { Transcript, type TranscriptLine } from '@/components/Transcript';
import { Send } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  lines: TranscriptLine[];
  onSend: (text: string) => void;
  disabled?: boolean;
}

/**
 * Modern Text View with smooth scrolling transcript and floating glass message composer.
 */
export function TextView({ lines, onSend, disabled }: Props) {
  const [value, setValue] = useState('');

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue('');
  };

  return (
    <div className="flex flex-1 flex-col h-full min-h-0">
      {/* Scrollable conversation transcript */}
      <div className="flex-1 overflow-y-auto px-1 py-3 scrollbar-thin">
        <Transcript lines={lines} />
      </div>

      {/* Floating Glass Message Composer */}
      <form
        className="mt-2 flex items-center gap-2 rounded-2xl glass-panel p-2 shadow-2xl border border-white/10"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor="text-input" className="sr-only">
          Type your message to Turtle
        </label>
        <input
          id="text-input"
          type="text"
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Ask Turtle or note an update…"
          autoComplete="off"
          className="flex-1 bg-transparent px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 outline-none"
        />
        <button
          type="submit"
          disabled={disabled || value.trim().length === 0}
          aria-label="Send message"
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-all duration-200 cursor-pointer',
            value.trim().length > 0
              ? 'bg-gradient-to-tr from-teal-500 to-emerald-500 text-slate-950 shadow-md glow-primary hover:scale-105 active:scale-95'
              : 'bg-slate-800/80 text-slate-500 cursor-not-allowed opacity-50',
          )}
        >
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}
