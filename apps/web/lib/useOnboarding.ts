'use client';

import { useCallback, useEffect, useState } from 'react';
import type { OnboardingSnapshot } from '@turtle/shared';

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:8787';
const CAREGIVER_ID = process.env.NEXT_PUBLIC_CAREGIVER_ID ?? 'local-caregiver';

export interface OnboardingApi {
  status: OnboardingSnapshot | null;
  refresh(): Promise<void>;
}

/**
 * Loads the persisted state for the detailed conversational onboarding flow.
 * Answers and consent are handled only through the live onboarding session.
 */
export function useOnboarding(): OnboardingApi {
  const [status, setStatus] = useState<OnboardingSnapshot | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `${SERVER_URL}/onboarding/status?caregiver_id=${encodeURIComponent(CAREGIVER_ID)}`,
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as OnboardingSnapshot;
      setStatus(data);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, refresh };
}
