'use client';

import { useEffect, useState } from 'react';
import type { OnboardingPrompt } from '@turtle/shared';
import { Check, Mic, Pencil } from 'lucide-react';

interface Props {
  prompt: OnboardingPrompt;
  onAnswer(value: string): void;
  onConfirm(): void;
  onEdit(): void;
}

/**
 * The focused, one-question-at-a-time first-run surface. It is intentionally not a
 * form for the entire profile: the server decides which single field is active and
 * the caregiver reviews each spoken or typed answer before anything is saved.
 */
export function OnboardingCard({ prompt, onAnswer, onConfirm, onEdit }: Props) {
  const [draft, setDraft] = useState(prompt.value ?? '');

  useEffect(() => {
    setDraft(prompt.value ?? '');
  }, [prompt.step, prompt.value, prompt.confirmation]);

  if (prompt.complete) return null;

  const stepLabel = prompt.step === 'name' ? 'Step 1 of 2 · Care recipient' : 'Step 2 of 2 · Care journey';
  const fieldLabel = prompt.step === 'name' ? 'Who are you caring for?' : 'Primary diagnosis';
  const placeholder = prompt.step === 'name' ? 'e.g. Mom, Elena, or James' : 'e.g. Metastatic cancer';
  const canSubmit = draft.trim().length > 0;

  return (
    <section
      aria-label="Guided onboarding"
      className="mx-auto w-full max-w-md rounded-[24px] border border-[#cbd5e1] bg-white p-5 shadow-[0_16px_48px_rgba(11,25,44,0.12)] text-[#0b192c]"
    >
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#eff6ff] border border-[#bfdbfe] px-2.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#1d4ed8]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#f59e0b] animate-pulse" />
          {stepLabel}
        </span>
        <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#f59e0b]">
          <Mic className="h-3 w-3 animate-pulse" aria-hidden="true" /> Voice Guided
        </span>
      </div>

      <p className="m-0 text-xs sm:text-sm font-semibold leading-relaxed text-[#0b192c]">{prompt.question}</p>

      {prompt.confirmation ? (
        <div className="mt-3.5">
          <div className="rounded-xl border border-blue-200 bg-[#eff6ff] p-3 text-center">
            <p className="m-0 text-[10px] font-extrabold uppercase tracking-wider text-[#1d4ed8]">Recognized entry</p>
            <p className="mt-0.5 m-0 text-base font-extrabold text-[#0b192c]">
              “{prompt.value}”
            </p>
          </div>

          <div className="mt-2.5 rounded-xl bg-[#f8fafc] border border-[#e2e8f0] p-2.5 text-center">
            <p className="m-0 text-xs font-semibold text-[#1e293b]">
              Say <span className="text-[#1d4ed8] font-extrabold">“Yes”</span> or <span className="text-[#1d4ed8] font-extrabold">“Correct”</span> to confirm.
            </p>
            <p className="mt-0.5 m-0 text-[10px] text-[#64748b]">
              Or speak a correction out loud (no button clicks needed).
            </p>
          </div>

          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              onClick={onEdit}
              className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-[#cbd5e1] bg-[#f1f5f9] px-2.5 text-[11px] font-bold text-[#475569] transition hover:bg-[#e2e8f0] hover:text-[#0b192c] active:scale-95 cursor-pointer"
            >
              <Pencil className="h-3 w-3" aria-hidden="true" /> Edit manually
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#1d4ed8] px-2.5 text-[11px] font-bold text-white transition hover:bg-[#1e40af] active:scale-95 cursor-pointer shadow-xs"
            >
              <Check className="h-3 w-3 text-[#fbbf24]" aria-hidden="true" /> Confirm
            </button>
          </div>
        </div>
      ) : (
        <form
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) onAnswer(draft.trim());
          }}
        >
          <label htmlFor="guided-onboarding-answer" className="sr-only">
            {fieldLabel}
          </label>
          <div className="flex gap-2">
            <input
              id="guided-onboarding-answer"
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={placeholder}
              className="h-9 min-w-0 flex-1 rounded-xl border border-[#cbd5e1] bg-[#f8fafc] px-3 text-xs font-medium text-[#0b192c] outline-none placeholder:text-[#94a3b8] focus:border-[#1d4ed8] focus:bg-white focus:ring-1 focus:ring-[#1d4ed8]"
            />
            <button
              type="submit"
              disabled={!canSubmit}
              className="h-9 rounded-xl bg-[#1d4ed8] px-3.5 text-[11px] font-bold text-white transition hover:bg-[#1e40af] disabled:cursor-not-allowed disabled:opacity-40 active:scale-95 cursor-pointer"
            >
              Send
            </button>
          </div>
          {prompt.choices?.length ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {prompt.choices.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  onClick={() => {
                    setDraft(choice);
                    onAnswer(choice);
                  }}
                  className="rounded-full border border-[#bfdbfe] bg-[#eff6ff] px-3 py-1 text-[11px] font-bold text-[#1d4ed8] transition hover:bg-[#dbeafe] hover:border-[#93c5fd] active:scale-95 cursor-pointer shadow-xs"
                >
                  {choice}
                </button>
              ))}
            </div>
          ) : null}
          <div className="mt-2.5 flex items-center justify-center gap-1.5 text-center text-[11px] font-semibold text-[#1d4ed8]">
            <Mic className="h-3 w-3 text-[#f59e0b] animate-pulse" />
            <span>Speak your answer out loud whenever you are ready</span>
          </div>
        </form>
      )}
    </section>
  );
}
