'use client';

import { useState } from 'react';
import { Transcript, type TranscriptLine } from '@/components/Transcript';

interface Props {
  lines: TranscriptLine[];
  onSend: (text: string) => void;
  disabled?: boolean;
}

/**
 * The text surface: the same conversation, typed. Both the accessibility path (full voice
 * parity in reverse) and the ASR-down fallback (text-in, voice-out). Soft-inset input.
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
    <div className="flex flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-1 py-2">
        <Transcript lines={lines} />
      </div>

      <form
        className="flex items-end gap-2.5 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor="text-input" className="sr-only">
          Type your message to Turtle
        </label>
        <textarea
          id="text-input"
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="Type to Turtle…"
          className="min-h-12 flex-1 resize-none rounded-2xl bg-card px-4 py-3 text-foreground soft-inset outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="submit"
          disabled={disabled || value.trim().length === 0}
          className="h-12 rounded-2xl bg-primary px-5 font-bold text-primary-foreground soft transition-all duration-200 hover:scale-[1.02] active:scale-95 disabled:opacity-50 disabled:hover:scale-100"
        >
          Send
        </button>
      </form>
    </div>
  );
}
