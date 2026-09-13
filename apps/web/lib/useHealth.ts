'use client';

import { useEffect, useState } from 'react';

export interface Capability {
  live: boolean;
  fallback: string;
}

export interface DisabledCapability {
  capability: string;
  reason: string;
}

export interface HealthResponse {
  ok: boolean;
  /** 'ok' when all providers are live, 'degraded' when one or more are disabled. */
  status?: 'ok' | 'degraded';
  degraded?: boolean;
  disabledCapabilities?: DisabledCapability[];
  capabilities: {
    asr: Capability;
    tts: Capability;
    llm: Capability;
    embeddings: Capability;
  };
}

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:8787';

/**
 * Polls the server /health once on mount so the client can honestly surface which
 * capabilities are degraded. Returns null while loading or if the server is unreachable.
 */
export function useHealth(): HealthResponse | null {
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${SERVER_URL}/health`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setHealth(data);
      })
      .catch(() => {
        if (!cancelled) setHealth(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return health;
}
