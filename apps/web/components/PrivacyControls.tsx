'use client';

import { useEffect, useRef, useState } from 'react';
import { useDeleteEverything } from '@/lib/useDeleteEverything';
import { Trash2, X, AlertTriangle } from 'lucide-react';

/**
 * Minimalist Privacy Controls with dark dialog for data deletion.
 */
export function PrivacyControls() {
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
        aria-label="Delete all data"
        className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-rose-400 transition-colors cursor-pointer"
      >
        <Trash2 className="h-3 w-3" />
        <span>Delete all data</span>
      </button>

      {confirming && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/80 backdrop-blur-sm px-5"
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
            className="w-full max-w-md rounded-2xl bg-[#0e0e11] border border-zinc-800 p-6 shadow-2xl text-white"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-500/10 text-rose-400 border border-rose-500/20">
                  <AlertTriangle className="h-4 w-4" />
                </span>
                <h2 id="delete-title" className="m-0 text-base font-semibold text-white">
                  Delete everything?
                </h2>
              </div>
              <button
                onClick={() => !deleting && setConfirming(false)}
                className="text-zinc-500 hover:text-white p-1 rounded-md hover:bg-zinc-800 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p id="delete-body" className="m-0 mb-5 text-xs text-zinc-400 leading-relaxed">
              This permanently wipes all recorded conversations, care logs, appointments, contacts, and personal preferences from this device. This action cannot be undone.
            </p>

            {error && (
              <p className="m-0 mb-4 rounded-lg bg-rose-950/50 border border-rose-800/50 p-2.5 text-xs text-rose-300" role="alert">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2.5">
              <button
                ref={cancelRef}
                type="button"
                onClick={() => setConfirming(false)}
                disabled={deleting}
                className="h-9 rounded-lg bg-zinc-900 border border-zinc-800 px-4 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white active:scale-95 disabled:opacity-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={deleting}
                aria-label="Confirm delete everything"
                className="flex items-center gap-1.5 h-9 rounded-lg bg-rose-600 px-4 text-xs font-semibold text-white transition-colors hover:bg-rose-500 active:scale-95 disabled:opacity-50 cursor-pointer"
              >
                <Trash2 className="h-3 w-3" />
                <span>{deleting ? 'Deleting…' : 'Erase All Data'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
