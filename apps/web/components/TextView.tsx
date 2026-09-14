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
              className="shrink-0 rounded-full border border-[#bfdbfe] bg-[#eff6ff] px-3.5 py-1.5 text-xs font-bold text-[#1d4ed8] transition-all hover:bg-[#dbeafe] hover:border-[#93c5fd] disabled:opacity-50 cursor-pointer shadow-xs"
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}

      {/* Minimalist Message Composer Bar */}
      <form
        className="mt-2 flex items-center gap-2 rounded-full bg-[#f8fafc] p-1.5 pl-4 border border-[#cbd5e1] focus-within:border-[#1d4ed8] focus-within:bg-white shadow-xs transition-colors"
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
          className="flex-1 bg-transparent text-sm font-medium text-[#0b192c] placeholder:text-[#94a3b8] outline-none"
        />
        <button
          type="submit"
          disabled={disabled || value.trim().length === 0}
          aria-label="Send message"
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-all duration-150 cursor-pointer',
            value.trim().length > 0
              ? 'bg-[#1d4ed8] text-white hover:bg-[#1e40af] active:scale-95 shadow-xs'
              : 'bg-[#f1f5f9] text-[#94a3b8] cursor-not-allowed opacity-50',
          )}
        >
          <ArrowUp className="h-4 w-4 stroke-[2.5]" />
        </button>
      </form>
    </div>
  );
}
