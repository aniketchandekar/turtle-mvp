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
      className="my-2 flex items-center justify-center gap-2 rounded-full bg-[#eff6ff] border border-[#bfdbfe] px-3.5 py-1 text-center text-xs font-semibold text-[#1d4ed8]"
      role="status"
    >
      {health === null ? (
        <WifiOff className="h-3 w-3 text-[#f59e0b] animate-pulse" />
      ) : (
        <Info className="h-3 w-3 text-[#1d4ed8]" />
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
