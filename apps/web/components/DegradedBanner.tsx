'use client';

import type { HealthResponse } from '@/lib/useHealth';

/**
 * Honest surface of degraded capabilities. If the server can't be reached, or any
 * capability is running on a fallback, we say so plainly rather than pretending.
 * Soft-inset chip so it reads as a quiet status, not an alarm.
 */
export function DegradedBanner({ health }: { health: HealthResponse | null }) {
  const message = deriveMessage(health);
  if (!message) return null;

  return (
    <div
      className="mb-3 rounded-full bg-card px-4 py-2 text-center text-sm text-muted-foreground soft-inset"
      role="status"
    >
      {message}
    </div>
  );
}

function deriveMessage(health: HealthResponse | null): string | null {
  if (health === null) {
    return 'Connecting to Turtle…';
  }
  const caps = health.capabilities;
  const degraded: string[] = [];
  if (!caps.asr.live) degraded.push('typing');
  if (!caps.tts.live) degraded.push('text-only');
  if (!caps.llm.live) degraded.push('canned replies');
  if (degraded.length === 0) return null;
  return `Degraded mode: ${degraded.join(', ')}.`;
}
