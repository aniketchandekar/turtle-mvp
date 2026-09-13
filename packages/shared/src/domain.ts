import { z } from 'zod';
import { CARD_TYPES, LOG_CATEGORIES } from './contract.js';

/**
 * Data-model types (§18 of the technical spec). SQLite-backed for MVP,
 * kept Postgres-migratable. JSON columns are typed here.
 */

// Diagnosis vertical. MVP seeds one: metastatic cancer.
export const DIAGNOSES = ['metastatic_cancer'] as const;
export type Diagnosis = (typeof DIAGNOSES)[number];

export const APPOINTMENT_STATUSES = ['upcoming', 'done', 'cancelled'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const CARD_STATUSES = ['active', 'dismissed', 'done'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export const SPEAKERS = ['user', 'assistant'] as const;
export type Speaker = (typeof SPEAKERS)[number];

export const careTeamSchema = z.object({
  nurse_line: z.string().optional(),
  social_worker: z.string().optional(),
  oncologist: z.string().optional(),
  other: z.array(z.object({ label: z.string(), contact: z.string() })).default([]),
});
export type CareTeam = z.infer<typeof careTeamSchema>;

export const caregiverPrefsSchema = z.object({
  voice_id: z.string().optional(),
  pace: z.number().min(0.7).max(1.2).optional(),
  checkin_time: z.string().optional(),
});
export type CaregiverPrefs = z.infer<typeof caregiverPrefsSchema>;

export interface Caregiver {
  id: string;
  display_name: string | null;
  created_at: string;
  consent_at: string | null;
  prefs: CaregiverPrefs;
}

export interface Patient {
  id: string;
  caregiver_id: string;
  name: string;
  diagnosis: Diagnosis;
  diagnosis_notes: string | null;
  care_team: CareTeam;
}

export interface Appointment {
  id: string;
  patient_id: string;
  title: string;
  with_whom: string | null;
  at: string;
  purpose: string | null;
  status: AppointmentStatus;
}

export interface LogEntry {
  id: string;
  patient_id: string;
  at: string;
  category: (typeof LOG_CATEGORIES)[number];
  text: string;
  structured: Record<string, unknown> | null;
}

export interface Session {
  id: string;
  caregiver_id: string;
  started_at: string;
  ended_at: string | null;
  mode_transitions: string[];
  flags: string[];
  recap_card_id: string | null;
}

export interface Turn {
  id: string;
  session_id: string;
  seq: number;
  speaker: Speaker;
  text: string;
  asr_conf: number | null;
  retrieved_chunk_ids: string[];
  flag: string | null;
  latency_ms: number | null;
}

export interface CardRecord {
  id: string;
  session_id: string;
  type: (typeof CARD_TYPES)[number];
  title: string;
  body: string;
  action: { kind: string; target?: string } | null;
  status: CardStatus;
  created_at: string;
}

export interface KbChunk {
  id: string;
  diagnosis: Diagnosis;
  source_url: string | null;
  title: string | null;
  content_md: string;
  embedding: number[] | null;
}
