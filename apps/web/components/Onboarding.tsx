'use client';

import { useState, useEffect } from 'react';
import { DIAGNOSES, type Diagnosis } from '@turtle/shared';
import type { Disclosure, OnboardingSubmission, PatientInfo } from '@/lib/useOnboarding';
import { PrivacyControls } from '@/components/PrivacyControls';
import { User, X } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  disclosure: Disclosure | null;
  existingPatient?: PatientInfo | null;
  submitting: boolean;
  error: string | null;
  onSubmit: (input: OnboardingSubmission) => Promise<boolean>;
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
}: Props) {
  const [patientName, setPatientName] = useState(existingPatient?.name ?? '');
  const [diagnosis, setDiagnosis] = useState<Diagnosis>(existingPatient?.diagnosis ?? DIAGNOSES[0]);
  const [nurseLine, setNurseLine] = useState('');
  const [oncologist, setOncologist] = useState('');
  const [socialWorker, setSocialWorker] = useState('');
  const [nextApptAt, setNextApptAt] = useState('');
  const [nextApptTitle, setNextApptTitle] = useState('');
  const [checkinTime, setCheckinTime] = useState('09:00');
  const [voiceId, setVoiceId] = useState('');

  useEffect(() => {
    if (existingPatient) {
      setPatientName(existingPatient.name);
      setDiagnosis(existingPatient.diagnosis);
    }
  }, [existingPatient]);

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
      voiceId: voiceId.trim() || undefined,
    });
    if (ok) onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="profile-drawer-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm px-4 py-6 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-[#0e0e11] border border-zinc-800 p-6 shadow-2xl my-auto text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 pb-4 mb-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300">
              <User className="h-4 w-4" />
            </span>
            <div>
              <h2 id="profile-drawer-title" className="text-base font-semibold text-white m-0">
                Care Profile
              </h2>
              <p className="text-xs text-zinc-500 m-0">Care recipient context and contacts</p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close profile modal"
            className="text-zinc-500 hover:text-white p-1 rounded-md hover:bg-zinc-800 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* AI Disclosure Note */}
        {disclosure && (
          <div className="rounded-xl bg-zinc-900/60 border border-zinc-800/80 p-3 mb-4 text-xs text-zinc-400 space-y-1">
            <p className="m-0 font-medium text-zinc-300">{disclosure.what_i_am}</p>
            <p className="m-0 text-zinc-500">{disclosure.what_i_do}</p>
          </div>
        )}

        <form className="flex flex-col gap-3.5" onSubmit={handleSubmit}>
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
                  <option key={d} value={d} className="bg-zinc-900 text-white">
                    {DIAGNOSIS_LABELS[d]}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="space-y-2 pt-1">
            <span className="text-xs font-semibold text-zinc-400 block">Care Team Contacts</span>
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
            <span className="text-xs font-semibold text-zinc-400 block">Next Appointment</span>
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
            <span className="text-xs font-semibold text-zinc-400 block">Preferences</span>
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
              <Field label="Custom Voice ID (Optional)" htmlFor="ob-voice">
                <input
                  id="ob-voice"
                  type="text"
                  value={voiceId}
                  onChange={(e) => setVoiceId(e.target.value)}
                  placeholder="Default voice"
                  className={inputCls}
                />
              </Field>
            </div>
          </div>

          {error && (
            <p role="alert" className="m-0 rounded-lg bg-rose-950/50 border border-rose-800/50 p-2.5 text-xs text-rose-300">
              {error}
            </p>
          )}

          <div className="flex items-center justify-between pt-4 border-t border-zinc-800 mt-2">
            <PrivacyControls />

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-9 rounded-lg px-3 text-xs font-medium text-zinc-400 hover:text-white transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSave}
                className="h-9 rounded-lg bg-white px-4 text-xs font-semibold text-black transition-colors hover:bg-zinc-200 disabled:opacity-40 cursor-pointer"
              >
                {submitting ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputCls =
  'h-9 w-full rounded-lg bg-[#18181b] border border-zinc-800 px-3 text-xs text-white placeholder:text-zinc-500 outline-none focus:border-zinc-500 transition-colors';

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
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-zinc-300">
        {label} {required && <span className="text-zinc-500">*</span>}
      </label>
      {children}
    </div>
  );
}
