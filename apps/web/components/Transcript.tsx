'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

export interface TranscriptLine {
  id: number;
  speaker: 'user' | 'assistant' | 'system';
  text: string;
  /** Interim ASR results render dimmed until finalized. */
  interim: boolean;
}

/**
 * The transcript pane. Interim (in-progress) user speech renders dimmed; committed lines
 * render normally. Soft bubbles, auto-scroll to newest.
 */
export function Transcript({ lines }: { lines: TranscriptLine[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [lines]);

  return (
    <div className="flex flex-col gap-3.5" role="log" aria-live="polite">
      {lines.map((line) => (
        <div
          key={line.id}
          className={cn(
            'flex max-w-[85%]',
            line.speaker === 'user' && 'self-end',
            line.speaker === 'assistant' && 'self-start',
            line.speaker === 'system' && 'max-w-full self-center',
          )}
        >
          <span
            className={cn(
              'rounded-2xl px-4 py-2.5 whitespace-pre-wrap',
              line.speaker === 'user' && 'bg-primary text-primary-foreground soft',
              line.speaker === 'assistant' && 'bg-card text-card-foreground soft',
              line.speaker === 'system' && 'text-center text-sm italic text-muted-foreground',
              line.interim && 'opacity-50',
            )}
          >
            {line.text}
          </span>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
