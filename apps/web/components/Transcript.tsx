'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Bot, User } from 'lucide-react';

export interface TranscriptLine {
  id: number;
  speaker: 'user' | 'assistant' | 'system';
  text: string;
  /** Interim ASR results render dimmed until finalized. */
  interim: boolean;
}

/**
 * ElevenLabs-inspired minimalist Transcript component with clean dark bubbles.
 */
export function Transcript({ lines }: { lines: TranscriptLine[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [lines]);

  return (
    <div className="flex flex-col gap-3.5 py-2" role="log" aria-live="polite">
      {lines.map((line) => {
        if (line.speaker === 'system') {
          return (
            <div key={line.id} className="flex justify-center my-1">
              <span className="rounded-full bg-zinc-900 border border-zinc-800 px-3 py-1 text-xs text-zinc-400">
                {line.text}
              </span>
            </div>
          );
        }

        const isUser = line.speaker === 'user';

        return (
          <div
            key={line.id}
            className={cn(
              'flex items-start gap-2.5 max-w-[85%] transition-opacity duration-150',
              isUser ? 'self-end flex-row-reverse' : 'self-start flex-row',
              line.interim && 'opacity-60',
            )}
          >
            {/* Avatar icon */}
            <div
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs mt-0.5',
                isUser
                  ? 'bg-zinc-800 text-zinc-300 border border-zinc-700'
                  : 'bg-zinc-900 text-zinc-400 border border-zinc-800',
              )}
              aria-hidden="true"
            >
              {isUser ? <User className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
            </div>

            {/* Message Bubble */}
            <div
              className={cn(
                'rounded-2xl px-3.5 py-2 text-sm leading-relaxed',
                isUser
                  ? 'bg-zinc-800 text-white rounded-tr-xs'
                  : 'bg-[#121215] border border-zinc-800/80 text-zinc-100 rounded-tl-xs',
              )}
            >
              <p className="m-0 whitespace-pre-wrap">{line.text}</p>
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
