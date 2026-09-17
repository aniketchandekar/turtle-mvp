'use client';

import { useCallback, useState } from 'react';

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:8787';
const CAREGIVER_ID = process.env.NEXT_PUBLIC_CAREGIVER_ID ?? 'local-caregiver';

export interface DeleteEverythingApi {
  /** True while the wipe request is in flight. */
  deleting: boolean;
  /** True once a wipe has completed successfully (until reset). */
  done: boolean;
  /** Last error message, or null. */
  error: string | null;
  /**
   * Wipe ALL stored caregiver data via DELETE /everything (R16.7). Resolves true on
   * success. The server clears sessions, turns, cards, log entries, patients,
   * appointments, and the caregiver row in a single transaction.
   */
  deleteEverything(): Promise<boolean>;
  /** Clear the done/error flags (e.g. after the caller has re-run onboarding). */
  reset(): void;
}

/**
 * One-click "delete everything" control (Task 37, R16.7).
 *
 * Calls the privacy endpoint that wipes every stored record for the local caregiver.
 * Deliberately narrow: it owns only the request + its transient status. The caller
 * gates it behind an explicit confirmation and decides what to do once the wipe lands
 * (Turtle reloads so the first-run onboarding + consent flow starts clean).
 */
export function useDeleteEverything(): DeleteEverythingApi {
  const [deleting, setDeleting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deleteEverything = useCallback(async (): Promise<boolean> => {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`${SERVER_URL}/caregivers/${encodeURIComponent(CAREGIVER_ID)}/everything`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`delete failed: ${res.status}`);
      setDone(true);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete your data.');
      return false;
    } finally {
      setDeleting(false);
    }
  }, []);

  const reset = useCallback(() => {
    setDone(false);
    setError(null);
  }, []);

  return { deleting, done, error, deleteEverything, reset };
}
