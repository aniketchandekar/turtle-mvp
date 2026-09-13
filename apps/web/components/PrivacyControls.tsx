'use client';

import { useEffect, useRef, useState } from 'react';
import { useDeleteEverything } from '@/lib/useDeleteEverything';

/**
 * One-click "delete everything" privacy control (Task 37, R16.7).
 *
 * A quiet text button in the header opens a small confirmation dialog; confirming calls
 * DELETE /everything, which wipes every stored record (sessions, transcripts, cards, log
 * entries, patient profile, appointments, contacts). Deletion is irreversible, so the
 * destructive action is always behind an explicit confirm step — never a single stray tap.
 *
 * After a successful wipe the page reloads so the app returns to the first-run onboarding
 * + consent flow with a clean store (no stale session or profile lingering in memory).
 *
 * Accessibility: the confirm sheet is a labelled `role="dialog"`; the (non-destructive)
 * Cancel button takes focus on open so a stray Enter does not delete; Escape cancels;
 * large tap targets and readable type throughout.
 */
export function PrivacyControls() {
  const [confirming, setConfirming] = useState(false);
  const { deleting, done, error, deleteEverything } = useDeleteEverything();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Focus the safe (Cancel) control when the confirm sheet opens.
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  // On a successful wipe, reload so onboarding + consent restart against a clean store.
  useEffect(() => {
    if (done) window.location.reload();
  }, [done]);

  const onConfirm = () => {
    void deleteEverything();
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-full px-2.5 py-1 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Delete my data
      </button>

      {confirming && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/30 px-5"
          onClick={() => !deleting && setConfirming(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            aria-describedby="delete-body"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !deleting) {
                e.preventDefault();
                setConfirming(false);
              }
            }}
            className="w-full max-w-md rounded-2xl bg-card p-5 soft"
          >
            <h2 id="delete-title" className="m-0 mb-2 text-lg font-bold">
              Delete everything?
            </h2>
            <p id="delete-body" className="m-0 mb-4 text-muted-foreground">
              This permanently erases all of your conversations, notes, appointments, and
              contacts from this device. It cannot be undone.
            </p>

            {error && (
              <p className="m-0 mb-3 text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2.5">
              <button
                ref={cancelRef}
                type="button"
                onClick={() => setConfirming(false)}
                disabled={deleting}
                className="h-11 rounded-xl bg-card px-4 font-bold text-foreground soft transition-all duration-200 hover:scale-[1.02] active:scale-95 disabled:opacity-50 disabled:hover:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={deleting}
                aria-label="Confirm delete everything"
                className="h-11 rounded-xl bg-destructive px-4 font-bold text-destructive-foreground soft transition-all duration-200 hover:scale-[1.02] active:scale-95 disabled:opacity-50 disabled:hover:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {deleting ? 'Deleting…' : 'Delete everything'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
