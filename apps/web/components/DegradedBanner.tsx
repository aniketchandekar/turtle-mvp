'use client';

import type { HealthResponse } from '@/lib/useHealth';
import { Info, WifiOff } from 'lucide-react';

/**
 * Modern degraded status indicator.
 */
export function DegradedBanner({ health }: { health: HealthResponse | null }) {
  const message = deriveMessage(health);
  if (!message) return null;

  return (
    <div
      className="mb-3 flex items-center justify-center gap-2 rounded-full glass-pill border border-amber-500/30 bg-amber-950/30 px-3.5 py-1.5 text-center text-xs font-medium text-amber-200 shadow-sm"
      role="status"
    >
      {health === null ? (
        <WifiOff className="h-3.5 w-3.5 text-amber-400 animate-pulse" />
      ) : (
        <Info className="h-3.5 w-3.5 text-amber-400" />
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
