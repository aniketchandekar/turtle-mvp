'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CaregiverPrefs, Diagnosis } from '@turtle/shared';

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:8787';
const CAREGIVER_ID = process.env.NEXT_PUBLIC_CAREGIVER_ID ?? 'local-caregiver';

/** The AI disclosure copy served by the onboarding status endpoint (shared constants). */
export interface Disclosure {
  spoken: string;
  what_i_am: string;
  what_i_do: string;
  what_i_never_do: string;
}

export interface OnboardingStatus {
  caregiver_id: string;
  /** True until BOTH explicit consent and a patient profile exist (R16.10). */
  needsOnboarding: boolean;
  hasConsent: boolean;
  hasProfile: boolean;
  consent_at: string | null;
  prefs: CaregiverPrefs;
  disclosure: Disclosure;
}

/** A care-team contact captured in the minimal onboarding form. */
export interface CareTeamInput {
  nurse_line?: string;
  social_worker?: string;
  oncologist?: string;
}

/** The minimal onboarding form payload (name, diagnosis, dates, care team, prefs). */
export interface OnboardingSubmission {
  patientName: string;
  diagnosis: Diagnosis;
  careTeam: CareTeamInput;
  /** ISO date string for the next appointment, optional (a "key date"). */
  nextAppointmentAt?: string;
  nextAppointmentTitle?: string;
  checkinTime?: string;
  voiceId?: string;
}

export interface OnboardingApi {
  /** null while loading; the resolved status once fetched. */
  status: OnboardingStatus | null;
  /** True while the initial status fetch is in flight. */
  loading: boolean;
  /** True once onboarding is complete (no longer needed). */
  complete: boolean;
  /** The AI disclosure copy, once loaded. */
  disclosure: Disclosure | null;
  /** Submit consent + profile + prefs, then re-check status. Returns true on success. */
  submit(input: OnboardingSubmission): Promise<boolean>;
  /** Set to true while a submission is in flight. */
  submitting: boolean;
  /** Last submission error, or null. */
  error: string | null;
}

async function postJson(path: string, body?: unknown): Promise<Response> {
  return fetch(`${SERVER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function patchJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${SERVER_URL}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * First-run onboarding gate (Task 33, R16.10). Fetches whether the local caregiver has
 * completed onboarding (explicit consent to recording/storage AND a patient profile),
 * and exposes a single `submit` that runs the three writes in order:
 *
 *   1. POST /caregivers/:id/consent      — explicit consent BEFORE the first session
 *   2. POST /patients                    — the minimal profile (name, diagnosis, care team)
 *   3. POST /appointments (optional)     — a key date, if supplied
 *   4. PATCH /caregivers/:id/prefs       — check-in time + voice preference
 *
 * The main app is gated behind `complete`, so a caregiver cannot talk until consent is
 * captured and the profile exists. Local single-user MVP: the caregiver id is fixed and
 * the row is created lazily server-side.
 */
export function useOnboarding(): OnboardingApi {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `${SERVER_URL}/onboarding/status?caregiver_id=${encodeURIComponent(CAREGIVER_ID)}`,
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as OnboardingStatus;
      setStatus(data);
    } catch {
      // Server unreachable: leave status null so the gate shows a connecting state
      // rather than skipping consent. The main app also surfaces the degraded banner.
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = useCallback(
    async (input: OnboardingSubmission): Promise<boolean> => {
      setSubmitting(true);
      setError(null);
      try {
        // 1) Explicit consent to recording/storage BEFORE the first session (R16.10).
        const consent = await postJson(`/caregivers/${encodeURIComponent(CAREGIVER_ID)}/consent`);
        if (!consent.ok) throw new Error('Could not record consent.');

        // 2) Minimal patient profile (name, diagnosis from the fixed list, care team).
        const care_team = {
          ...(input.careTeam.nurse_line ? { nurse_line: input.careTeam.nurse_line } : {}),
          ...(input.careTeam.social_worker ? { social_worker: input.careTeam.social_worker } : {}),
          ...(input.careTeam.oncologist ? { oncologist: input.careTeam.oncologist } : {}),
          other: [],
        };
        const patientRes = await postJson('/patients', {
          caregiver_id: CAREGIVER_ID,
          name: input.patientName,
          diagnosis: input.diagnosis,
          care_team,
        });
        if (!patientRes.ok) throw new Error('Could not save the profile.');
        const patient = (await patientRes.json()) as { id: string };

        // 3) Optional key date: seed the next appointment if one was provided.
        if (input.nextAppointmentAt) {
          await postJson('/appointments', {
            patient_id: patient.id,
            title: input.nextAppointmentTitle?.trim() || 'Appointment',
            at: input.nextAppointmentAt,
          });
        }

        // 4) Check-in time + voice preference.
        const prefs: Partial<CaregiverPrefs> = {};
        if (input.checkinTime) prefs.checkin_time = input.checkinTime;
        if (input.voiceId) prefs.voice_id = input.voiceId;
        if (Object.keys(prefs).length > 0) {
          await patchJson(`/caregivers/${encodeURIComponent(CAREGIVER_ID)}/prefs`, prefs);
        }

        await refresh();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Something went wrong.');
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [refresh],
  );

  return {
    status,
    loading,
    complete: status != null && !status.needsOnboarding,
    disclosure: status?.disclosure ?? null,
    submit,
    submitting,
    error,
  };
}
