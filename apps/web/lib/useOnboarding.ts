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

export interface PatientInfo {
  id: string;
  name: string;
  diagnosis: Diagnosis;
  diagnosis_notes?: string | null;
  care_team?: Record<string, unknown>;
}

export interface OnboardingStatus {
  caregiver_id: string;
  needsOnboarding: boolean;
  hasConsent: boolean;
  hasProfile: boolean;
  patient?: PatientInfo | null;
  consent_at: string | null;
  prefs: CaregiverPrefs;
  disclosure: Disclosure;
}

export interface CareTeamInput {
  nurse_line?: string;
  social_worker?: string;
  oncologist?: string;
}

export interface OnboardingSubmission {
  patientName: string;
  diagnosis: Diagnosis;
  careTeam: CareTeamInput;
  nextAppointmentAt?: string;
  nextAppointmentTitle?: string;
  checkinTime?: string;
  voiceId?: string;
}

export interface OnboardingApi {
  status: OnboardingStatus | null;
  loading: boolean;
  complete: boolean;
  disclosure: Disclosure | null;
  submit(input: OnboardingSubmission): Promise<boolean>;
  ensureConsent(): Promise<boolean>;
  autoExtractAndSave(text: string): Promise<boolean>;
  refresh(): Promise<void>;
  submitting: boolean;
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
 * Conversational Onboarding Hook.
 * Manages consent, patient profile extraction, and preferences.
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
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ensureConsent = useCallback(async (): Promise<boolean> => {
    try {
      const res = await postJson(`/caregivers/${encodeURIComponent(CAREGIVER_ID)}/consent`);
      if (res.ok) {
        await refresh();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [refresh]);

  const submit = useCallback(
    async (input: OnboardingSubmission): Promise<boolean> => {
      setSubmitting(true);
      setError(null);
      try {
        await ensureConsent();

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

        if (input.nextAppointmentAt) {
          await postJson('/appointments', {
            patient_id: patient.id,
            title: input.nextAppointmentTitle?.trim() || 'Appointment',
            at: input.nextAppointmentAt,
          });
        }

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
    [ensureConsent, refresh],
  );

  /**
   * Intelligently parses conversational speech/text during onboarding to create the profile automatically.
   */
  const autoExtractAndSave = useCallback(
    async (text: string): Promise<boolean> => {
      if (status?.hasProfile) return true;
      await ensureConsent();

      // Simple heuristic extraction: name or relative ("mom", "dad", "Sarah", etc.)
      const lower = text.toLowerCase();
      let extractedName = 'My Loved One';
      const nameMatch = text.match(/(?:caring for|taking care of|look after|helping)\s+([A-Z][a-z]+|my\s+[a-z]+)/i);
      if (nameMatch && nameMatch[1]) {
        extractedName = nameMatch[1].trim();
      } else if (lower.includes('mom') || lower.includes('mother')) {
        extractedName = 'Mom';
      } else if (lower.includes('dad') || lower.includes('father')) {
        extractedName = 'Dad';
      } else if (lower.includes('wife') || lower.includes('husband') || lower.includes('partner')) {
        extractedName = 'Partner';
      }

      return submit({
        patientName: extractedName,
        diagnosis: 'metastatic_cancer',
        careTeam: {},
      });
    },
    [status?.hasProfile, ensureConsent, submit],
  );

  return {
    status,
    loading,
    complete: status != null && !status.needsOnboarding,
    disclosure: status?.disclosure ?? null,
    submit,
    ensureConsent,
    autoExtractAndSave,
    refresh,
    submitting,
    error,
  };
}
