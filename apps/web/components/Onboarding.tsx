'use client';

import { useState, useEffect } from 'react';
import { DIAGNOSES, type Diagnosis } from '@turtle/shared';
import type { Disclosure, OnboardingSubmission, PatientInfo } from '@/lib/useOnboarding';
import { PrivacyControls } from '@/components/PrivacyControls';
import { ArrowLeft, ArrowRight, HeartHandshake, Keyboard, Mic, X } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  disclosure: Disclosure | null;
  existingPatient?: PatientInfo | null;
  submitting: boolean;
  error: string | null;
  onSubmit: (input: OnboardingSubmission) => Promise<boolean>;
  /** First-run setup cannot be dismissed: Turtle needs this context before chatting. */
  required?: boolean;
  /** Begin the voice-first guided setup, leaving the form as an accessible fallback. */
  onStartVoice?: () => void;
}

const DIAGNOSIS_LABELS: Record<Diagnosis, string> = {
  metastatic_cancer: 'Metastatic Cancer',
};

/**
 * Care Profile & Settings Drawer (ElevenLabs minimalist dark style).
 * Allows the caregiver to view or edit patient profile, diagnosis, care team contacts,
 * and check-in preferences anytime.
 */
export function Onboarding({
  isOpen,
  onClose,
  disclosure,
  existingPatient,
  submitting,
  error,
  onSubmit,
  required = false,
  onStartVoice,
}: Props) {
  const [patientName, setPatientName] = useState(existingPatient?.name ?? '');
  const [diagnosis, setDiagnosis] = useState<Diagnosis>(existingPatient?.diagnosis ?? DIAGNOSES[0]);
  const [nurseLine, setNurseLine] = useState('');
  const [oncologist, setOncologist] = useState('');
  const [socialWorker, setSocialWorker] = useState('');
  const [nextApptAt, setNextApptAt] = useState('');
  const [nextApptTitle, setNextApptTitle] = useState('');
  const [checkinTime, setCheckinTime] = useState('09:00');
  const [showTypingSetup, setShowTypingSetup] = useState(false);

  useEffect(() => {
    if (!isOpen) setShowTypingSetup(false);
  }, [isOpen]);

  useEffect(() => {
    // A late status refresh must not overwrite fields the caregiver has already
    // started typing during required first-run setup.
    if (existingPatient && !required) {
      setPatientName(existingPatient.name);
      setDiagnosis(existingPatient.diagnosis);
      const careTeam = existingPatient.care_team ?? {};
      setNurseLine(typeof careTeam.nurse_line === 'string' ? careTeam.nurse_line : '');
      setOncologist(typeof careTeam.oncologist === 'string' ? careTeam.oncologist : '');
      setSocialWorker(typeof careTeam.social_worker === 'string' ? careTeam.social_worker : '');
    }
  }, [existingPatient, required]);

  if (!isOpen) return null;

  const canSave = patientName.trim().length > 0 && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    const ok = await onSubmit({
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
    });
    if (ok) onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="profile-drawer-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#0b192c]/65 px-4 py-6 overflow-y-auto backdrop-blur-md"
      onClick={() => {
        if (!required) onClose();
      }}
    >
      <div
        className="my-auto max-h-[calc(100dvh-3rem)] w-full max-w-xl overflow-y-auto rounded-[32px] border border-[#cbd5e1] bg-white p-6 text-[#0b192c] shadow-[0_24px_80px_rgba(11,25,44,0.25)] sm:p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#e2e8f0] pb-4 mb-4">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#eff6ff] text-[#1d4ed8]">
              <HeartHandshake className="h-5 w-5" />
            </span>
            <div>
              <h2 id="profile-drawer-title" className="text-2xl font-extrabold tracking-tight text-[#0b192c] m-0">
                {required ? (showTypingSetup ? 'Set up Turtle' : 'Welcome to Turtle') : 'Care Profile'}
              </h2>
              <p className="mt-1 text-sm leading-5 text-[#475569] m-0">
                {required
                  ? showTypingSetup
                    ? 'Add the care details Turtle should remember.'
                    : 'A steady voice for the hard days of caregiving.'
                  : 'Care recipient context and contacts'}
              </p>
            </div>
          </div>
          {!required ? (
            <button
              onClick={onClose}
              aria-label="Close profile modal"
              className="text-[#64748b] hover:text-[#0b192c] p-1.5 rounded-full hover:bg-[#f1f5f9] transition-colors cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>

        {/* AI Disclosure Note */}
        {disclosure && (!required || !showTypingSetup) && (
          <div className="mt-4 rounded-2xl bg-[#f8fafc] border border-[#e2e8f0] p-4 text-xs text-[#0b192c] space-y-1.5 shadow-xs">
            <p className="m-0 font-extrabold text-[#1d4ed8]">{disclosure.what_i_am}</p>
            <p className="m-0 leading-relaxed text-[#475569]">{disclosure.what_i_do}</p>
            <p className="m-0 leading-relaxed text-[#64748b]">{disclosure.what_i_never_do}</p>
          </div>
        )}

        {required && onStartVoice && !showTypingSetup ? (
          <div className="mt-5 rounded-2xl border border-[#bfdbfe] bg-[#eff6ff] p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#1d4ed8] text-white">
                <Mic className="h-4 w-4 text-[#fbbf24]" />
              </span>
              <div>
                <p className="m-0 text-sm font-bold text-[#0b192c]">Start with your voice</p>
                <p className="mt-1 m-0 text-xs leading-5 text-[#475569]">
                  I’ll introduce myself, then ask two simple questions about the person you’re caring for. You can answer naturally.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onStartVoice}
              className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#1d4ed8] px-4 text-sm font-bold text-white shadow-sm transition hover:bg-[#1e40af] active:scale-[0.99] cursor-pointer"
            >
              Meet Turtle by voice <ArrowRight className="h-4 w-4 text-[#fbbf24]" />
            </button>
          </div>
        ) : null}

        {required && !showTypingSetup ? (
          <div className="mt-4">
            <div className="mb-4 flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-[#e2e8f0]" />
              <span className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-[#94a3b8]">or</span>
              <span className="h-px flex-1 bg-[#e2e8f0]" />
            </div>
            <button
              type="button"
              onClick={() => setShowTypingSetup(true)}
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-[#cbd5e1] bg-white px-4 text-sm font-bold text-[#0b192c] transition hover:border-[#93c5fd] hover:bg-[#f8fafc] active:scale-[0.99] cursor-pointer"
            >
              <Keyboard className="h-4 w-4 text-[#1d4ed8]" /> Set up by typing
            </button>
          </div>
        ) : null}

        {!required || showTypingSetup ? (
        <form className="mt-4 flex flex-col gap-3.5" onSubmit={handleSubmit}>
          {required ? (
            <button
              type="button"
              onClick={() => setShowTypingSetup(false)}
              className="mb-1 inline-flex w-fit items-center gap-1.5 text-xs font-bold text-[#475569] transition hover:text-[#1d4ed8] cursor-pointer"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back to voice setup
            </button>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Care Recipient Name" htmlFor="ob-name" required>
              <input
                id="ob-name"
                type="text"
                required
                value={patientName}
                onChange={(e) => setPatientName(e.target.value)}
                placeholder="e.g. Mom, Eleanor"
                className={inputCls}
              />
            </Field>

            <Field label="Primary Diagnosis" htmlFor="ob-diagnosis">
              <select
                id="ob-diagnosis"
                value={diagnosis}
                onChange={(e) => setDiagnosis(e.target.value as Diagnosis)}
                className={inputCls}
              >
                {DIAGNOSES.map((d) => (
                  <option key={d} value={d} className="bg-white text-[#0b192c]">
                    {DIAGNOSIS_LABELS[d]}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {required ? (
            <p className="-mt-1 text-xs leading-relaxed text-[#64748b]">
              Start with the name or relationship you use for them and their primary diagnosis. Care-team contacts and appointments can be added now or later.
            </p>
          ) : null}

          <div className="space-y-2 pt-1">
            <span className="text-xs font-extrabold uppercase tracking-wider text-[#1d4ed8] block">Care Team Contacts</span>
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
          </div>

          <div className="space-y-2 pt-1">
            <span className="text-xs font-extrabold uppercase tracking-wider text-[#1d4ed8] block">Next Appointment</span>
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
              <Field label="Purpose" htmlFor="ob-appt-title">
                <input
                  id="ob-appt-title"
                  type="text"
                  value={nextApptTitle}
                  onChange={(e) => setNextApptTitle(e.target.value)}
                  placeholder="e.g. Oncology follow-up"
                  className={inputCls}
                />
              </Field>
            </div>
          </div>

          <div className="space-y-2 pt-1">
            <span className="text-xs font-extrabold uppercase tracking-wider text-[#1d4ed8] block">Preferences</span>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Check-in Time" htmlFor="ob-checkin">
                <input
                  id="ob-checkin"
                  type="time"
                  value={checkinTime}
                  onChange={(e) => setCheckinTime(e.target.value)}
                  className={inputCls}
                />
              </Field>
            </div>
          </div>

          {error && (
            <p role="alert" className="m-0 rounded-xl bg-rose-50 border border-rose-200 p-2.5 text-xs font-semibold text-rose-700">
              {error}
            </p>
          )}

          <div className="flex items-center justify-between pt-4 border-t border-[#e2e8f0] mt-2">
            <PrivacyControls label="Start over" />

            <div className="flex items-center gap-2">
              {!required ? (
                <button
                  type="button"
                  onClick={onClose}
                  className="h-10 rounded-xl px-3.5 text-xs font-bold text-[#475569] hover:text-[#0b192c] hover:bg-[#f1f5f9] transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              ) : null}
              <button
                type="submit"
                disabled={!canSave}
                className="h-10 rounded-xl bg-[#1d4ed8] px-5 text-xs font-bold text-white transition-colors hover:bg-[#1e40af] disabled:opacity-40 cursor-pointer shadow-sm"
              >
                {submitting ? 'Saving…' : required ? 'Start' : existingPatient ? 'Save changes' : 'Save'}
              </button>
            </div>
          </div>
        </form>
        ) : null}
      </div>
    </div>
  );
}

const inputCls =
  'h-10 w-full rounded-xl bg-[#f8fafc] border border-[#cbd5e1] px-3.5 text-xs font-medium text-[#0b192c] placeholder:text-[#94a3b8] outline-none focus:border-[#1d4ed8] focus:bg-white focus:ring-1 focus:ring-[#1d4ed8] transition-colors';

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
      <label htmlFor={htmlFor} className="text-xs font-bold text-[#0b192c]">
        {label} {required && <span className="text-[#f59e0b]">*</span>}
      </label>
      {children}
    </div>
  );
}
