'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Bot, User, Sparkles } from 'lucide-react';

export interface TranscriptLine {
  id: number;
  speaker: 'user' | 'assistant' | 'system';
  text: string;
  /** Interim ASR results render dimmed until finalized. */
  interim: boolean;
}

/**
 * Modern Transcript component with clean glassmorphic bubbles and role avatars.
 */
export function Transcript({ lines }: { lines: TranscriptLine[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [lines]);

  return (
    <div className="flex flex-col gap-4 py-2" role="log" aria-live="polite">
      {lines.map((line) => {
        if (line.speaker === 'system') {
          return (
            <div key={line.id} className="flex justify-center my-1">
              <span className="flex items-center gap-1.5 rounded-full glass-pill px-3 py-1 text-xs text-slate-400">
                <Sparkles className="h-3 w-3 text-teal-400" />
                <span>{line.text}</span>
              </span>
            </div>
          );
        }

        const isUser = line.speaker === 'user';

        return (
          <div
            key={line.id}
            className={cn(
              'flex items-end gap-2.5 max-w-[88%] transition-all duration-200',
              isUser ? 'self-end flex-row-reverse' : 'self-start flex-row',
              line.interim && 'opacity-60',
            )}
          >
            {/* Avatar */}
            <div
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs shadow-sm',
                isUser
                  ? 'bg-teal-500/20 text-teal-300 border border-teal-500/30'
                  : 'bg-slate-800 text-cyan-400 border border-white/10',
              )}
              aria-hidden="true"
            >
              {isUser ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
            </div>

            {/* Bubble */}
            <div
              className={cn(
                'rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-md',
                isUser
                  ? 'bg-gradient-to-tr from-teal-600 to-emerald-600 text-white rounded-br-xs'
                  : 'glass-card text-slate-100 rounded-bl-xs border border-white/10',
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
