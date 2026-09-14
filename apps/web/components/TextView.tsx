'use client';

import { useState } from 'react';
import { Transcript, type TranscriptLine } from '@/components/Transcript';
import { ArrowUp } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  lines: TranscriptLine[];
  onSend: (text: string) => void;
  disabled?: boolean;
  suggestions?: readonly string[];
}

/**
 * ElevenLabs-style minimalist Text View with sleek transcript and rounded input bar.
 */
export function TextView({ lines, onSend, disabled, suggestions = [] }: Props) {
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
      <div className="flex-1 overflow-y-auto px-1 py-3">
        <Transcript lines={lines} />
      </div>

      {suggestions.length > 0 ? (
        <div className="mb-2 flex gap-2 overflow-x-auto pb-1" aria-label="Conversation starters">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              disabled={disabled}
              onClick={() => onSend(suggestion)}
              className="shrink-0 rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white disabled:opacity-50"
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}

      {/* Minimalist Message Composer Bar */}
      <form
        className="mt-2 flex items-center gap-2 rounded-full bg-[#121214] p-1.5 pl-4 border border-zinc-800/90 focus-within:border-zinc-600 transition-colors"
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
          className="flex-1 bg-transparent text-sm text-white placeholder:text-zinc-500 outline-none"
        />
        <button
          type="submit"
          disabled={disabled || value.trim().length === 0}
          aria-label="Send message"
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-all duration-150 cursor-pointer',
            value.trim().length > 0
              ? 'bg-white text-black hover:bg-zinc-200 active:scale-95'
              : 'bg-zinc-800/80 text-zinc-500 cursor-not-allowed opacity-40',
          )}
        >
          <ArrowUp className="h-4 w-4 stroke-[2.5]" />
        </button>
      </form>
    </div>
  );
}
