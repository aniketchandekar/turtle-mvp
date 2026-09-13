'use client';

import type { HealthResponse } from '@/lib/useHealth';
import { Info, WifiOff } from 'lucide-react';

/**
 * Minimalist degraded status indicator (ElevenLabs dark style).
 */
export function DegradedBanner({ health }: { health: HealthResponse | null }) {
  const message = deriveMessage(health);
  if (!message) return null;

  return (
    <div
      className="my-2 flex items-center justify-center gap-2 rounded-full bg-zinc-900 border border-zinc-800 px-3 py-1 text-center text-xs font-normal text-zinc-400"
      role="status"
    >
      {health === null ? (
        <WifiOff className="h-3 w-3 text-zinc-400 animate-pulse" />
      ) : (
        <Info className="h-3 w-3 text-zinc-400" />
      )}
      <span>{message}</span>
    </div>
  );
}

function deriveMessage(health: HealthResponse | null): string | null {
  if (health === null) {
    return 'Connecting to Turtle…';
  }
  const caps = health.capabilities;
  const degraded: string[] = [];
  if (!caps.asr.live) degraded.push('typed input');
  if (!caps.tts.live) degraded.push('text-only');
  if (!caps.llm.live) degraded.push('canned responses');
  if (degraded.length === 0) return null;
  return `Operating in fallback mode (${degraded.join(', ')}).`;
}
