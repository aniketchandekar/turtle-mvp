'use client';

import { useEffect, useRef, useState } from 'react';
import { useDeleteEverything } from '@/lib/useDeleteEverything';
import { RotateCcw, Trash2, X, AlertTriangle } from 'lucide-react';

/**
 * Minimalist Privacy Controls with dark dialog for data deletion.
 */
export function PrivacyControls({ label = 'Start over' }: { label?: string }) {
  const [confirming, setConfirming] = useState(false);
  const { deleting, done, error, deleteEverything } = useDeleteEverything();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

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
        aria-label={label}
        className="flex items-center gap-1.5 text-xs text-[#64748b] hover:text-rose-600 transition-colors cursor-pointer font-semibold"
      >
        <RotateCcw className="h-3 w-3" />
        <span>{label}</span>
      </button>

      {confirming && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-[#0b192c]/65 backdrop-blur-md px-5"
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
            className="w-full max-w-md rounded-2xl bg-white border border-[#cbd5e1] p-6 shadow-2xl text-[#0b192c]"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-50 text-rose-600 border border-rose-200">
                  <AlertTriangle className="h-4 w-4" />
                </span>
                <h2 id="delete-title" className="m-0 text-base font-extrabold text-[#0b192c]">
                  Start this demo over?
                </h2>
              </div>
              <button
                onClick={() => !deleting && setConfirming(false)}
                className="text-[#64748b] hover:text-[#0b192c] p-1 rounded-md hover:bg-[#f1f5f9] transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p id="delete-body" className="m-0 mb-5 text-xs text-[#475569] leading-relaxed">
              This permanently wipes the local demo profile, conversations, care logs, appointments, contacts, and preferences. Turtle will then introduce itself and ask for care-recipient context again. This cannot be undone.
            </p>

            {error && (
              <p className="m-0 mb-4 rounded-lg bg-rose-50 border border-rose-200 p-2.5 text-xs text-rose-700 font-medium" role="alert">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2.5">
              <button
                ref={cancelRef}
                type="button"
                onClick={() => setConfirming(false)}
                disabled={deleting}
                className="h-9 rounded-lg bg-[#f1f5f9] border border-[#cbd5e1] px-4 text-xs font-bold text-[#475569] transition-colors hover:bg-[#e2e8f0] hover:text-[#0b192c] active:scale-95 disabled:opacity-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={deleting}
                aria-label="Confirm delete everything"
                className="flex items-center gap-1.5 h-9 rounded-lg bg-rose-600 px-4 text-xs font-bold text-white transition-colors hover:bg-rose-700 active:scale-95 disabled:opacity-50 cursor-pointer shadow-sm"
              >
                <Trash2 className="h-3 w-3" />
                <span>{deleting ? 'Resetting…' : 'Start Over'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
