'use client';

import { useEffect, useRef, useState } from 'react';
import { useDeleteEverything } from '@/lib/useDeleteEverything';
import { ShieldAlert, Trash2, X, AlertTriangle } from 'lucide-react';

/**
 * Modern Privacy Controls with glass dialog for data deletion.
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
        aria-label="Privacy and data controls"
        className="flex items-center gap-1.5 rounded-full glass-pill px-2.5 py-1 text-xs font-medium text-slate-400 transition-all duration-200 hover:text-rose-400 hover:border-rose-500/30 hover:bg-rose-950/20 cursor-pointer"
      >
        <ShieldAlert className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Privacy</span>
      </button>

      {confirming && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-slate-950/70 backdrop-blur-md px-5"
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
            className="w-full max-w-md rounded-2xl glass-panel p-6 shadow-2xl border border-rose-500/20"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-rose-500/20 text-rose-400 border border-rose-500/30">
                  <AlertTriangle className="h-5 w-5" />
                </span>
                <h2 id="delete-title" className="m-0 text-lg font-bold text-slate-100">
                  Delete everything?
                </h2>
              </div>
              <button
                onClick={() => !deleting && setConfirming(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-white/10"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p id="delete-body" className="m-0 mb-5 text-sm text-slate-300 leading-relaxed">
              This permanently wipes all recorded conversations, care logs, appointments, contacts, and personal preferences from this device. This action cannot be undone.
            </p>

            {error && (
              <p className="m-0 mb-4 rounded-lg bg-rose-950/50 border border-rose-500/30 p-2.5 text-xs text-rose-300" role="alert">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2.5">
              <button
                ref={cancelRef}
                type="button"
                onClick={() => setConfirming(false)}
                disabled={deleting}
                className="h-10 rounded-xl glass-pill px-4 text-xs font-semibold text-slate-300 transition-all hover:bg-white/10 hover:text-white active:scale-95 disabled:opacity-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={deleting}
                aria-label="Confirm delete everything"
                className="flex items-center gap-1.5 h-10 rounded-xl bg-rose-600 px-4 text-xs font-bold text-white shadow-md glow-destructive transition-all hover:bg-rose-500 active:scale-95 disabled:opacity-50 cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>{deleting ? 'Deleting…' : 'Erase All Data'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
