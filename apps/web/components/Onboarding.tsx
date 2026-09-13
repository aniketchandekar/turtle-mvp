'use client';

import { useState } from 'react';
import { DIAGNOSES, type Diagnosis } from '@turtle/shared';
import type { Disclosure, OnboardingSubmission } from '@/lib/useOnboarding';
import {
  Heart,
  User,
  Phone,
  Calendar,
  Clock,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  Info,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  disclosure: Disclosure | null;
  submitting: boolean;
  error: string | null;
  onSubmit: (input: OnboardingSubmission) => void;
}

const DIAGNOSIS_LABELS: Record<Diagnosis, string> = {
  metastatic_cancer: 'Metastatic Cancer',
};

/**
 * Modern, compassionate Onboarding screen for caregivers.
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
      className="mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col gap-6 overflow-y-auto px-4 py-8 sm:px-6"
    >
      {/* Header with glowing badge */}
      <header className="flex flex-col items-center text-center gap-3">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-tr from-teal-500 to-emerald-500 text-slate-950 shadow-xl glow-primary">
          <Heart className="h-7 w-7 fill-slate-950/20" />
        </div>
        <div>
          <h1 id="onboarding-title" className="text-2xl font-bold tracking-tight text-slate-100 sm:text-3xl">
            Welcome to Turtle
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            A voice-first companion designed for caregivers
          </p>
        </div>

        {/* AI Disclosure Card */}
        <div className="w-full mt-2 rounded-2xl glass-panel p-5 text-left text-xs leading-relaxed border border-teal-500/20 shadow-xl">
          <div className="flex items-center gap-2 mb-2 text-teal-300 font-bold text-sm">
            <Info className="h-4 w-4" />
            <span>{disclosure?.what_i_am ?? 'Turtle is an AI caregiver companion'}</span>
          </div>
          <div className="space-y-2 text-slate-300">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400 mt-0.5" />
              <span>{disclosure?.what_i_do ?? 'Helps you log symptoms, prepare for doctor visits, and recall notes by voice.'}</span>
            </div>
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
              <span>{disclosure?.what_i_never_do ?? 'Never provides medical diagnoses, dosing instructions, or replaces emergency care.'}</span>
            </div>
          </div>
        </div>
      </header>

      <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
        {/* Section 1: Patient Profile */}
        <section className="rounded-2xl glass-card p-5 space-y-4 shadow-lg border border-white/10">
          <div className="flex items-center gap-2 text-teal-300 font-bold text-sm border-b border-white/5 pb-2">
            <User className="h-4 w-4" />
            <span>Care Recipient Profile</span>
          </div>

          <Field label="Who are you caring for?" htmlFor="ob-name" required>
            <input
              id="ob-name"
              type="text"
              required
              value={patientName}
              onChange={(e) => setPatientName(e.target.value)}
              placeholder="e.g. Mom, Dad, Sarah"
              className={inputCls}
              autoComplete="off"
            />
          </Field>

          <Field label="Primary Condition" htmlFor="ob-diagnosis">
            <select
              id="ob-diagnosis"
              value={diagnosis}
              onChange={(e) => setDiagnosis(e.target.value as Diagnosis)}
              className={inputCls}
            >
              {DIAGNOSES.map((d) => (
                <option key={d} value={d} className="bg-slate-900 text-slate-100">
                  {DIAGNOSIS_LABELS[d]}
                </option>
              ))}
            </select>
          </Field>
        </section>

        {/* Section 2: Care Team */}
        <section className="rounded-2xl glass-card p-5 space-y-4 shadow-lg border border-white/10">
          <div className="flex items-center gap-2 text-teal-300 font-bold text-sm border-b border-white/5 pb-2">
            <Phone className="h-4 w-4" />
            <span>Care Team Contacts (Optional)</span>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Nurse Line" htmlFor="ob-nurse">
              <input
                id="ob-nurse"
                type="tel"
                value={nurseLine}
                onChange={(e) => setNurseLine(e.target.value)}
                placeholder="555-0199"
                className={inputCls}
              />
            </Field>
            <Field label="Oncologist" htmlFor="ob-onc">
              <input
                id="ob-onc"
                type="text"
                value={oncologist}
                onChange={(e) => setOncologist(e.target.value)}
                placeholder="Dr. Chen"
                className={inputCls}
              />
            </Field>
            <Field label="Social Worker" htmlFor="ob-sw">
              <input
                id="ob-sw"
                type="text"
                value={socialWorker}
                onChange={(e) => setSocialWorker(e.target.value)}
                placeholder="Maria"
                className={inputCls}
              />
            </Field>
          </div>
        </section>

        {/* Section 3: Upcoming Appointment */}
        <section className="rounded-2xl glass-card p-5 space-y-4 shadow-lg border border-white/10">
          <div className="flex items-center gap-2 text-teal-300 font-bold text-sm border-b border-white/5 pb-2">
            <Calendar className="h-4 w-4" />
            <span>Next Key Appointment (Optional)</span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Date & Time" htmlFor="ob-appt-at">
              <input
                id="ob-appt-at"
                type="datetime-local"
                value={nextApptAt}
                onChange={(e) => setNextApptAt(e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Appointment Purpose" htmlFor="ob-appt-title">
              <input
                id="ob-appt-title"
                type="text"
                value={nextApptTitle}
                onChange={(e) => setNextApptTitle(e.target.value)}
                placeholder="e.g. Chemo cycle 3 review"
                className={inputCls}
              />
            </Field>
          </div>
        </section>

        {/* Section 4: Daily Check-in */}
        <section className="rounded-2xl glass-card p-5 space-y-4 shadow-lg border border-white/10">
          <div className="flex items-center gap-2 text-teal-300 font-bold text-sm border-b border-white/5 pb-2">
            <Clock className="h-4 w-4" />
            <span>Daily Routine</span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Preferred Check-in Time" htmlFor="ob-checkin">
              <input
                id="ob-checkin"
                type="time"
                value={checkinTime}
                onChange={(e) => setCheckinTime(e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Custom Voice ID (Optional)" htmlFor="ob-voice">
              <input
                id="ob-voice"
                type="text"
                value={voiceId}
                onChange={(e) => setVoiceId(e.target.value)}
                placeholder="Leave blank for default"
                className={inputCls}
              />
            </Field>
          </div>
        </section>

        {/* Consent Card */}
        <label className="flex cursor-pointer items-start gap-3 rounded-2xl glass-panel p-5 border border-teal-500/30 transition-all hover:bg-slate-900/90 shadow-xl">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-1 h-5 w-5 rounded border-slate-700 accent-teal-500"
            aria-describedby="consent-text"
          />
          <div className="text-xs leading-relaxed text-slate-300">
            <span className="font-bold text-slate-100 block mb-0.5">Explicit Caregiver Consent</span>
            <span id="consent-text">
              I understand Turtle records voice input to transcribe speech and securely stores care logs, appointments, and contacts locally. I can delete everything at any time from the Privacy controls.
            </span>
          </div>
        </label>

        {error && (
          <p role="alert" className="m-0 rounded-xl bg-rose-950/50 border border-rose-500/30 p-3 text-xs text-rose-300">
            {error}
          </p>
        )}

        {/* Submit Hero Button */}
        <button
          type="submit"
          disabled={!canStart}
          className={cn(
            'flex items-center justify-center gap-2 h-14 rounded-2xl font-bold text-slate-950 transition-all duration-300 shadow-xl cursor-pointer',
            canStart
              ? 'bg-gradient-to-r from-teal-400 via-emerald-400 to-teal-400 bg-size-200 hover:scale-[1.02] active:scale-95 glow-primary'
              : 'bg-slate-800 text-slate-500 cursor-not-allowed opacity-50',
          )}
        >
          <Sparkles className="h-5 w-5" />
          <span>{submitting ? 'Setting up Companion…' : 'Start Using Turtle'}</span>
        </button>
      </form>
    </div>
  );
}

const inputCls =
  'h-11 w-full rounded-xl glass-input px-3.5 text-sm text-slate-100 placeholder:text-slate-500 outline-none transition-all';

function Field({
  label,
  htmlFor,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-semibold text-slate-300">
        {label} {required && <span className="text-teal-400">*</span>}
      </label>
      {children}
    </div>
  );
}
