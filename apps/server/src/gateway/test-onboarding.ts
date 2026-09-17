import type { OnboardingProfile } from '@turtle/shared';
import type { Repositories } from '../store/repositories.js';

/** Test fixture helper: regular gateway tests begin after the required setup is complete. */
export function seedCompletedOnboarding(repos: Repositories, caregiverId: string): void {
  const timestamp = new Date().toISOString();
  const profile: OnboardingProfile = {
    caregiverId,
    version: 1,
    status: 'completed',
    locale: 'en',
    currentStep: 'complete',
    revision: 1,
    answers: {},
    drafts: {},
    elapsedSeconds: 0,
    segmentElapsedSeconds: 0,
    activeSince: null,
    startedAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
  };
  repos.onboardingProfile.save(profile);
  repos.consentRecord.append({
    caregiver_id: caregiverId,
    consent_type: 'ai_data_processing',
    action: 'granted',
    actor: 'test caregiver',
    authority_basis: null,
    subject: 'test family record',
    capture_method: 'system',
    disclosure_version: 'test',
    locale: 'en',
    evidence: 'test fixture',
  });
  repos.consentRecord.append({
    caregiver_id: caregiverId,
    consent_type: 'patient_information',
    action: 'granted',
    actor: 'test caregiver',
    authority_basis: 'test fixture',
    subject: 'test patient',
    capture_method: 'system',
    disclosure_version: 'test',
    locale: 'en',
    evidence: 'test fixture',
  });
}
