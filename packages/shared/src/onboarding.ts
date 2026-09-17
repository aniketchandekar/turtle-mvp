import { z } from 'zod';

export const ONBOARDING_SECTIONS = [
  'privacy',
  'caregiver',
  'authorization',
  'patient',
  'review',
  'complete',
] as const;
export type OnboardingSection = (typeof ONBOARDING_SECTIONS)[number];

export const ONBOARDING_STEP_IDS = [
  'ai_data_consent',
  'caregiver_name',
  'caregiver_relationship',
  'caregiver_distance',
  'language_preference',
  'decision_maker',
  'caregiver_sleep',
  'caregiver_review',
  'patient_authorization',
  'patient_name',
  'patient_age',
  'cancer_type',
  'care_phase',
  'last_treatment_date',
  'last_treatment_type',
  'clinic',
  'oncologist',
  'after_hours_number',
  'baseline_pain',
  'baseline_breathing',
  'baseline_nutrition',
  'baseline_alertness',
  'baseline_fever',
  'medication_concern',
  'hospice_agency',
  'hospice_phone',
  'patient_review',
  'wrap_up',
  'complete',
] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

export const ONBOARDING_STATUSES = [
  'not_started',
  'in_progress',
  'paused',
  'declined',
  'completed',
] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export const ONBOARDING_LOCALES = ['en', 'es'] as const;
export type OnboardingLocale = (typeof ONBOARDING_LOCALES)[number];

export const onboardingAnswerSchema = z.object({
  raw: z.string(),
  normalized: z.union([z.string(), z.number(), z.boolean()]).nullable(),
  confirmedAt: z.string().datetime().nullable(),
  skipped: z.boolean().default(false),
  updatedAt: z.string().datetime(),
});
export type OnboardingAnswer = z.infer<typeof onboardingAnswerSchema>;

export const onboardingProgressSchema = z.object({
  current: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  percent: z.number().min(0).max(100),
});

export const onboardingPromptSchema = z.object({
  id: z.string().min(1),
  stepId: z.enum(ONBOARDING_STEP_IDS),
  section: z.enum(ONBOARDING_SECTIONS),
  kind: z.enum(['consent', 'text', 'choice', 'review', 'info']),
  question: z.string().min(1),
  why: z.string().min(1),
  choices: z.array(z.string().min(1)).optional(),
  inputMode: z.enum(['voice_or_text', 'action_only']),
  skippable: z.boolean(),
  draft: z.string().nullable(),
  progress: onboardingProgressSchema,
  locale: z.enum(ONBOARDING_LOCALES),
  warning: z.string().nullable().optional(),
  summary: z.record(onboardingAnswerSchema).optional(),
  value: z.string().optional(),
  // Transitional aliases keep older consumers readable while `stepId` is the source.
  step: z.enum(['name', 'diagnosis', 'complete']).optional(),
  confirmation: z.boolean().optional(),
  complete: z.boolean().optional(),
});
export type OnboardingPrompt = z.infer<typeof onboardingPromptSchema>;

export const onboardingSectionStateSchema = z.object({
  id: z.enum(ONBOARDING_SECTIONS),
  label: z.string(),
  state: z.enum(['upcoming', 'active', 'review', 'complete']),
});

export const consentTypeSchema = z.enum([
  'ai_data_processing',
  'patient_information',
  'outbound_ai_call',
]);
export type ConsentType = z.infer<typeof consentTypeSchema>;

export const consentActionSchema = z.enum(['granted', 'declined', 'revoked']);
export type ConsentAction = z.infer<typeof consentActionSchema>;

export const consentRecordSchema = z.object({
  id: z.string(),
  caregiver_id: z.string(),
  consent_type: consentTypeSchema,
  action: consentActionSchema,
  actor: z.string(),
  authority_basis: z.string().nullable(),
  subject: z.string(),
  capture_method: z.enum(['voice', 'typed', 'system']),
  disclosure_version: z.string(),
  locale: z.enum(ONBOARDING_LOCALES),
  captured_at: z.string().datetime(),
  evidence: z.string(),
});
export type ConsentRecord = z.infer<typeof consentRecordSchema>;

export const onboardingSnapshotSchema = z.object({
  caregiverId: z.string(),
  version: z.number().int().positive(),
  status: z.enum(ONBOARDING_STATUSES),
  locale: z.enum(ONBOARDING_LOCALES),
  currentStep: z.enum(ONBOARDING_STEP_IDS),
  prompt: onboardingPromptSchema.nullable(),
  sections: z.array(onboardingSectionStateSchema),
  missingRequired: z.array(z.enum(ONBOARDING_STEP_IDS)),
  consents: z.record(consentActionSchema).default({}),
  answers: z.record(onboardingAnswerSchema).default({}),
  elapsedSeconds: z.number().int().nonnegative(),
  completedAt: z.string().datetime().nullable(),
});
export type OnboardingSnapshot = z.infer<typeof onboardingSnapshotSchema>;

/** Encrypted-at-rest server record. The browser receives only its snapshot projection. */
export interface OnboardingProfile {
  caregiverId: string;
  version: number;
  status: OnboardingStatus;
  locale: OnboardingLocale;
  currentStep: OnboardingStepId;
  revision: number;
  answers: Partial<Record<OnboardingStepId, OnboardingAnswer>>;
  drafts: Partial<Record<OnboardingStepId, string>>;
  elapsedSeconds: number;
  segmentElapsedSeconds: number;
  activeSince: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export const onboardingCorrectionSchema = z.object({
  stepId: z.enum(ONBOARDING_STEP_IDS),
  value: z.string().min(1).max(2000),
  captureMethod: z.enum(['voice', 'typed']).default('typed'),
});

export const consentMutationSchema = z.object({
  action: z.enum(['granted', 'declined', 'revoked']),
  evidence: z.string().min(1).max(2000),
  actor: z.string().min(1).default('caregiver'),
  authorityBasis: z.string().max(500).nullable().optional(),
  subject: z.string().min(1).default('family record'),
  captureMethod: z.enum(['voice', 'typed']).default('typed'),
  locale: z.enum(ONBOARDING_LOCALES).default('en'),
});
