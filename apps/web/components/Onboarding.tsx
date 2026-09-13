'use client';

import { useState } from 'react';
import { DIAGNOSES, type Diagnosis } from '@turtle/shared';
import type { Disclosure, OnboardingSubmission } from '@/lib/useOnboarding';

interface Props {
  disclosure: Disclosure | null;
  submitting: boolean;
  error: string | null;
  onSubmit: (input: OnboardingSubmission) => void;
}

/** Human-readable labels for the fixed diagnosis list (MVP seeds one vertical). */
const DIAGNOSIS_LABELS: Record<Diagnosis, string> = {
  metastatic_cancer: 'Metastatic cancer',
};

/**
 * First-run onboarding, consent, and AI disclosure (Task 33, R16.10).
 *
 * A single calm screen shown before the first session. It:
 *   1. Introduces Turtle honestly as software — what it IS (an AI), what it DOES, and
 *      what it NEVER does (no medical/dosing/prognosis advice). Copy comes from the
 *      server's shared AI disclosure so the spoken and shown wording stay in sync.
 *   2. Collects the minimal patient profile: name, diagnosis (fixed list), an optional
 *      key date, and care-team contacts.
 *   3. Lets the caregiver pick a check-in time and voice preference.
 *   4. Captures EXPLICIT consent to recording/storage via a required checkbox — the
 *      Start button stays disabled until it is checked (consent before the first
 *      session).
 *
 * Accessible: labelled fields, large tap targets, readable type, and a dialog role so a
 * screen reader announces it as the first thing.
 */
export function Onboarding({ disclosure, submitting, error, onSubmit }: Props) {
  const [patientName, setPatientName] = useState('');
  const [diagnosis, setDiagnosis] = useState<Diagnosis>(DIAGNOSES[0]);
  const [nurseLine, setNurseLine] = useState('');
  const [oncologist, setOncologist] = useState('');
  const [socialWorker, setSocialWorker] = useState('');
  const [nextApptAt, setNextApptAt] = useState('');
  const [nextApptTitle, setNextApptTitle] = useState('');
  const [checkinTime, setCheckinTime] = useState('09:00');
  const [voiceId, setVoiceId] = useState('');
  const [consent, setConsent] = useState(false);

  const canStart = consent && patientName.trim().length > 0 && !submitting;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canStart) return;
    onSubmit({
      patientName: patientName.trim(),
      diagnosis,
      careTeam: {
        nurse_line: nurseLine.trim() || undefined,
        oncologist: oncologist.trim() || undefined,
        social_worker: socialWorker.trim() || undefined,
      },
      nextAppointmentAt: nextApptAt ? new Date(nextApptAt).toISOString() : undefined,
      nextAppointmentTitle: nextApptTitle.trim() || undefined,
      checkinTime: checkinTime || undefined,
      voiceId: voiceId.trim() || undefined,
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      className="mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col gap-6 overflow-y-auto px-5 py-8 sm:px-6"
    >
      <header className="flex flex-col gap-2">
        <h1 id="onboarding-title" className="m-0 text-2xl font-bold tracking-tight">
          Welcome to Turtle
        </h1>
        {/* AI disclosure — honest, spoken AND shown (R16.10). */}
        <div className="rounded-2xl bg-card p-4 text-sm leading-relaxed soft-inset">
          <p className="m-0 font-bold text-foreground">{disclosure?.what_i_am}</p>
          <p className="m-0 mt-2 text-muted-foreground">{disclosure?.what_i_do}</p>
          <p className="m-0 mt-2 text-muted-foreground">{disclosure?.what_i_never_do}</p>
        </div>
      </header>

      <form className="flex flex-col gap-5" onSubmit={handleSubmit}>
        <fieldset className="flex flex-col gap-4 border-0 p-0">
          <legend className="mb-1 text-lg font-bold">Who are you caring for?</legend>

          <Field label="Their name" htmlFor="ob-name">
            <input
              id="ob-name"
              type="text"
              required
              value={patientName}
              onChange={(e) => setPatientName(e.target.value)}
              className={inputCls}
              autoComplete="off"
            />
          </Field>

          <Field label="Diagnosis" htmlFor="ob-diagnosis">
            <select
              id="ob-diagnosis"
              value={diagnosis}
              onChange={(e) => setDiagnosis(e.target.value as Diagnosis)}
              className={inputCls}
            >
              {DIAGNOSES.map((d) => (
                <option key={d} value={d}>
                  {DIAGNOSIS_LABELS[d]}
                </option>
              ))}
            </select>
          </Field>
        </fieldset>

        <fieldset className="flex flex-col gap-4 border-0 p-0">
          <legend className="mb-1 text-lg font-bold">Care team</legend>
          <Field label="Nurse line" htmlFor="ob-nurse">
            <input id="ob-nurse" type="tel" value={nurseLine} onChange={(e) => setNurseLine(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Oncologist" htmlFor="ob-onc">
            <input id="ob-onc" type="text" value={oncologist} onChange={(e) => setOncologist(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Social worker" htmlFor="ob-sw">
            <input id="ob-sw" type="text" value={socialWorker} onChange={(e) => setSocialWorker(e.target.value)} className={inputCls} />
          </Field>
        </fieldset>

        <fieldset className="flex flex-col gap-4 border-0 p-0">
          <legend className="mb-1 text-lg font-bold">Key date (optional)</legend>
          <Field label="Next appointment" htmlFor="ob-appt-at">
            <input id="ob-appt-at" type="datetime-local" value={nextApptAt} onChange={(e) => setNextApptAt(e.target.value)} className={inputCls} />
          </Field>
          <Field label="What is it for?" htmlFor="ob-appt-title">
            <input id="ob-appt-title" type="text" value={nextApptTitle} onChange={(e) => setNextApptTitle(e.target.value)} className={inputCls} placeholder="e.g. Oncology follow-up" />
          </Field>
        </fieldset>

        <fieldset className="flex flex-col gap-4 border-0 p-0">
          <legend className="mb-1 text-lg font-bold">Preferences</legend>
          <Field label="Daily check-in time" htmlFor="ob-checkin">
            <input id="ob-checkin" type="time" value={checkinTime} onChange={(e) => setCheckinTime(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Voice (optional)" htmlFor="ob-voice">
            <input id="ob-voice" type="text" value={voiceId} onChange={(e) => setVoiceId(e.target.value)} className={inputCls} placeholder="Leave blank for the default voice" />
          </Field>
        </fieldset>

        {/* Explicit consent to recording/storage — required before the first session. */}
        <label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-card p-4 soft-inset">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-1 h-5 w-5 accent-[var(--primary)]"
            aria-describedby="consent-text"
          />
          <span id="consent-text" className="text-sm leading-relaxed text-muted-foreground">
            I understand Turtle records what I say to transcribe it, and stores my
            transcripts, care log, and contacts securely. I consent to this. I can delete
            everything at any time.
          </span>
        </label>

        {error && (
          <p role="alert" className="m-0 text-sm text-destructive">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={!canStart}
          className="h-12 rounded-xl bg-primary px-4 text-base font-bold text-primary-foreground soft transition-all duration-200 hover:scale-[1.01] active:scale-95 disabled:opacity-50 disabled:hover:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {submitting ? 'Setting up…' : 'Start'}
        </button>
      </form>
    </div>
  );
}

const inputCls =
  'h-12 w-full rounded-xl bg-card px-4 text-base text-foreground soft-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-bold text-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
