import type {
  ConsentAction,
  ConsentRecord,
  OnboardingAnswer,
  OnboardingLocale,
  OnboardingProfile,
  OnboardingPrompt,
  OnboardingSection,
  OnboardingSnapshot,
  OnboardingStepId,
} from '@turtle/shared';
import type { Repositories } from '../store/repositories.js';
import { classifySafety } from '../orchestrator/safety.js';

export const ONBOARDING_DISCLOSURE_VERSION = 'caregiver-first-v1';

type StepDefinition = {
  id: OnboardingStepId;
  section: OnboardingSection;
  kind: OnboardingPrompt['kind'];
  question: Record<OnboardingLocale, string>;
  why: Record<OnboardingLocale, string>;
  choices?: Record<OnboardingLocale, string[]>;
  required: boolean;
  skippable: boolean;
};

const bilingual = (en: string, es: string): Record<OnboardingLocale, string> => ({ en, es });

const STEPS: StepDefinition[] = [
  {
    id: 'ai_data_consent', section: 'privacy', kind: 'consent', required: true, skippable: false,
    question: bilingual(
      "I'm Turtle, an AI companion—not a person or clinician. I can listen, organize, and connect you to human help, but I never diagnose, change medicines, interpret tests, give legal advice, or estimate time remaining. What you share is stored in your family's private record only to answer with context, notice changes, and help involve the right person. We don't sell it or use it for advertising. You can correct, export, or delete it. If something sounds dangerous, I'll tell you to contact a human right away. Do you agree to use Turtle and let us store what you choose to share?",
      'Soy Turtle, un acompañante de IA, no una persona ni un profesional clínico. Puedo escuchar, organizar y ayudarle a contactar apoyo humano, pero nunca diagnostico, cambio medicamentos, interpreto pruebas, doy asesoría legal ni calculo cuánto tiempo queda. Lo que comparta se guarda en el registro privado de su familia solo para responder con contexto, notar cambios y ayudar a involucrar a la persona correcta. No vendemos sus datos ni los usamos para publicidad. Puede corregirlos, exportarlos o borrarlos. Si algo parece peligroso, le diré que contacte a una persona de inmediato. ¿Acepta usar Turtle y permitirnos guardar lo que decida compartir?',
    ),
    why: bilingual('Your clear permission is required before anything personal is saved.', 'Necesitamos su permiso claro antes de guardar información personal.'),
    choices: { en: ['I agree', 'I do not agree'], es: ['Acepto', 'No acepto'] },
  },
  { id: 'caregiver_name', section: 'caregiver', kind: 'text', required: true, skippable: true, question: bilingual("First, what's your name?", 'Primero, ¿cómo se llama?'), why: bilingual("You're the person Turtle is here to support.", 'Usted es la persona a quien Turtle está aquí para apoyar.') },
  { id: 'caregiver_relationship', section: 'caregiver', kind: 'text', required: true, skippable: true, question: bilingual('How are you related to the person you care for?', '¿Qué relación tiene con la persona que cuida?'), why: bilingual('This starts the family map and helps Turtle speak naturally.', 'Esto inicia el mapa familiar y ayuda a Turtle a hablar de forma natural.') },
  { id: 'caregiver_distance', section: 'caregiver', kind: 'choice', required: true, skippable: true, question: bilingual('Do you live with them, nearby, or farther away?', '¿Vive con esa persona, cerca o lejos?'), why: bilingual('Distance changes what you may be able to observe directly.', 'La distancia cambia lo que quizá pueda observar directamente.'), choices: { en: ['Together', 'Nearby', 'Far away'], es: ['Juntos', 'Cerca', 'Lejos'] } },
  { id: 'language_preference', section: 'caregiver', kind: 'choice', required: true, skippable: true, question: bilingual('Would you prefer English, Spanish, or switching between both?', '¿Prefiere inglés, español o cambiar entre los dos?'), why: bilingual('Turtle should speak in the language you think in.', 'Turtle debe hablar en el idioma en que usted piensa.'), choices: { en: ['English', 'Spanish', 'Both are okay'], es: ['Inglés', 'Español', 'Ambos están bien'] } },
  { id: 'decision_maker', section: 'caregiver', kind: 'text', required: true, skippable: true, question: bilingual("If the patient couldn't make a medical decision tomorrow, who would make it? Is that you?", 'Si el paciente no pudiera tomar una decisión médica mañana, ¿quién la tomaría? ¿Sería usted?'), why: bilingual('This identifies whose permission counts and who clinicians should contact.', 'Esto identifica de quién cuenta el permiso y a quién debe contactar el equipo clínico.') },
  { id: 'caregiver_sleep', section: 'caregiver', kind: 'text', required: true, skippable: true, question: bilingual('One honest question: how have you been sleeping?', 'Una pregunta sincera: ¿cómo ha estado durmiendo?'), why: bilingual('Your wellbeing matters too; this is a baseline, not a diagnosis.', 'Su bienestar también importa; esto es una referencia, no un diagnóstico.') },
  { id: 'caregiver_review', section: 'caregiver', kind: 'review', required: true, skippable: false, question: bilingual('Here is what I heard about you. Confirm this section, or choose any answer to fix it.', 'Esto es lo que entendí sobre usted. Confirme esta sección o elija una respuesta para corregirla.'), why: bilingual('A quick review keeps the family record accurate.', 'Una revisión rápida mantiene preciso el registro familiar.') },
  { id: 'patient_authorization', section: 'authorization', kind: 'consent', required: true, skippable: false, question: bilingual('Before we discuss health details: has the patient, or their legal decision-maker, authorized you to set up this private record?', 'Antes de hablar de detalles de salud: ¿el paciente, o su representante legal, le autorizó a crear este registro privado?'), why: bilingual('Patient health information needs its own clear authorization.', 'La información de salud del paciente necesita una autorización clara.'), choices: { en: ['Yes, authorized', 'No, not authorized'], es: ['Sí, autorizado', 'No, no autorizado'] } },
  { id: 'patient_name', section: 'patient', kind: 'text', required: true, skippable: true, question: bilingual("What's the patient's name?", '¿Cómo se llama el paciente?'), why: bilingual('This personalizes future conversations.', 'Esto personaliza conversaciones futuras.') },
  { id: 'patient_age', section: 'patient', kind: 'text', required: true, skippable: true, question: bilingual('About how old are they?', '¿Aproximadamente cuántos años tiene?'), why: bilingual('A rough age is enough for context.', 'Una edad aproximada es suficiente para el contexto.') },
  { id: 'cancer_type', section: 'patient', kind: 'text', required: true, skippable: true, question: bilingual('What kind of cancer do they have?', '¿Qué tipo de cáncer tiene?'), why: bilingual('Turtle keeps your wording and never guesses a diagnosis.', 'Turtle conserva sus palabras y nunca adivina un diagnóstico.') },
  { id: 'care_phase', section: 'patient', kind: 'choice', required: true, skippable: true, question: bilingual('Where do things stand right now?', '¿En qué etapa se encuentra la atención ahora?'), why: bilingual('The care phase changes which questions and contacts are most useful.', 'La etapa de atención cambia qué preguntas y contactos son más útiles.'), choices: { en: ['Just diagnosed', 'In treatment', 'Between treatments', 'Finished treatment', 'Hospice'], es: ['Recién diagnosticado', 'En tratamiento', 'Entre tratamientos', 'Tratamiento terminado', 'Hospicio'] } },
  { id: 'last_treatment_date', section: 'patient', kind: 'text', required: true, skippable: true, question: bilingual('When was the last treatment? A date or “not started yet” is fine.', '¿Cuándo fue el último tratamiento? Una fecha o “aún no ha comenzado” está bien.'), why: bilingual('This anchors the treatment clock without interpreting symptoms.', 'Esto fija el reloj del tratamiento sin interpretar síntomas.') },
  { id: 'last_treatment_type', section: 'patient', kind: 'choice', required: true, skippable: true, question: bilingual('What kind of treatment was it?', '¿Qué tipo de tratamiento fue?'), why: bilingual('Treatment type gives the care team useful context.', 'El tipo de tratamiento da contexto útil al equipo de atención.'), choices: { en: ['Chemotherapy', 'Radiation', 'Surgery', 'Daily pills', 'Immunotherapy', 'Other'], es: ['Quimioterapia', 'Radiación', 'Cirugía', 'Pastillas diarias', 'Inmunoterapia', 'Otro'] } },
  { id: 'clinic', section: 'patient', kind: 'text', required: true, skippable: true, question: bilingual('What is the cancer clinic called?', '¿Cómo se llama la clínica oncológica?'), why: bilingual('This is part of the human escalation path.', 'Esto forma parte de la ruta de apoyo humano.') },
  { id: 'oncologist', section: 'patient', kind: 'text', required: true, skippable: true, question: bilingual("Who is the patient's oncologist?", '¿Quién es el oncólogo del paciente?'), why: bilingual('A named care contact makes follow-up clearer.', 'Un contacto clínico con nombre facilita el seguimiento.') },
  { id: 'after_hours_number', section: 'patient', kind: 'text', required: true, skippable: true, question: bilingual('What number did the clinic tell you to call after hours?', '¿Qué número indicó la clínica para llamar fuera de horario?'), why: bilingual('This digitizes the fridge-magnet escalation plan for urgent moments.', 'Esto digitaliza el plan de escalamiento para momentos urgentes.') },
  { id: 'baseline_pain', section: 'patient', kind: 'text', required: true, skippable: true, question: bilingual('On a normal day over the past two weeks, what is their usual pain—0 to 10 if you know?', 'En un día normal de las últimas dos semanas, ¿cuál es su dolor habitual, de 0 a 10 si lo sabe?'), why: bilingual('A baseline helps describe a change; Turtle does not interpret it.', 'Una referencia ayuda a describir un cambio; Turtle no lo interpreta.') },
  { id: 'baseline_breathing', section: 'patient', kind: 'text', required: true, skippable: true, question: bilingual('On a normal day, how is their breathing?', 'En un día normal, ¿cómo es su respiración?'), why: bilingual('Future changes are clearer when normal is recorded.', 'Los cambios futuros son más claros cuando se registra lo normal.') },
  { id: 'baseline_nutrition', section: 'patient', kind: 'text', required: true, skippable: true, question: bilingual('On a normal day, how are eating and drinking?', 'En un día normal, ¿cómo come y bebe?'), why: bilingual('This is a neutral baseline, not a clinical conclusion.', 'Esta es una referencia neutral, no una conclusión clínica.') },
  { id: 'baseline_alertness', section: 'patient', kind: 'text', required: true, skippable: true, question: bilingual('On a normal day, how alert are they?', 'En un día normal, ¿qué tan alerta está?'), why: bilingual('Knowing normal helps you describe a new change to a clinician.', 'Conocer lo normal ayuda a describir un cambio nuevo a un profesional clínico.') },
  { id: 'baseline_fever', section: 'patient', kind: 'text', required: true, skippable: true, question: bilingual('Over the past two weeks, have fevers or chills been normal for them?', 'En las últimas dos semanas, ¿ha sido normal que tenga fiebre o escalofríos?'), why: bilingual('Turtle records the baseline and escalates current danger signs.', 'Turtle registra la referencia y escala señales actuales de peligro.') },
  { id: 'medication_concern', section: 'patient', kind: 'text', required: true, skippable: true, question: bilingual('Which one medication worries you most?', '¿Qué medicamento le preocupa más?'), why: bilingual('Starting with one concern is safer than guessing from a long list.', 'Comenzar con una preocupación es más seguro que adivinar de una lista larga.') },
  { id: 'hospice_agency', section: 'patient', kind: 'text', required: true, skippable: true, question: bilingual('What is the hospice agency name?', '¿Cómo se llama la agencia de hospicio?'), why: bilingual('For hospice families, this becomes the first escalation path.', 'Para familias en hospicio, esta se convierte en la primera ruta de apoyo.') },
  { id: 'hospice_phone', section: 'patient', kind: 'text', required: true, skippable: true, question: bilingual("What is the hospice agency's 24-hour line?", '¿Cuál es la línea de 24 horas de la agencia de hospicio?'), why: bilingual('The hospice nurse line should be ready when help is needed.', 'La línea de enfermería del hospicio debe estar lista cuando se necesite ayuda.') },
  { id: 'patient_review', section: 'review', kind: 'review', required: true, skippable: false, question: bilingual('Here is the patient and safety context I heard. Confirm it, or choose any answer to fix it.', 'Este es el contexto del paciente y de seguridad que entendí. Confírmelo o elija una respuesta para corregirla.'), why: bilingual('Only confirmed facts become active context for Turtle.', 'Solo los datos confirmados se convierten en contexto activo para Turtle.') },
  { id: 'wrap_up', section: 'review', kind: 'info', required: true, skippable: false, question: bilingual("You're in control: you can fix, export, pause future calls, or delete this record anytime. No calls or messages have been scheduled. Finish setup now?", 'Usted tiene el control: puede corregir, exportar, pausar llamadas futuras o borrar este registro en cualquier momento. No se han programado llamadas ni mensajes. ¿Finalizar la configuración ahora?'), why: bilingual('Turtle will unlock regular conversations only when every required item is confirmed.', 'Turtle habilitará conversaciones normales solo cuando cada dato requerido esté confirmado.') },
  { id: 'complete', section: 'complete', kind: 'info', required: false, skippable: false, question: bilingual('Setup is complete. What feels most important today?', 'La configuración está completa. ¿Qué es lo más importante hoy?'), why: bilingual('Your confirmed context is ready.', 'Su contexto confirmado está listo.') },
];

const STEP_MAP = new Map(STEPS.map((step) => [step.id, step]));
const CAREGIVER_STEPS = STEPS.filter((step) => step.section === 'caregiver' && step.kind !== 'review').map((step) => step.id);
const PATIENT_STEPS = STEPS.filter((step) => step.section === 'patient').map((step) => step.id);
const REVIEWABLE = new Set([...CAREGIVER_STEPS, ...PATIENT_STEPS]);

export class OnboardingConflictError extends Error {}

export interface OnboardingMutationResult {
  snapshot: OnboardingSnapshot;
  safetyMessage?: string;
  safetyFlag?: 'crisis' | 'medical_refusal';
}

export function createOnboardingEngine(deps: { repos: Repositories; now?: () => Date }) {
  const clock = deps.now ?? (() => new Date());

  function iso(): string { return clock().toISOString(); }

  function createProfile(caregiverId: string): OnboardingProfile {
    const timestamp = iso();
    return {
      caregiverId,
      version: 1,
      status: 'not_started',
      locale: 'en',
      currentStep: 'ai_data_consent',
      revision: 1,
      answers: {},
      drafts: {},
      elapsedSeconds: 0,
      segmentElapsedSeconds: 0,
      activeSince: null,
      startedAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    };
  }

  function getOrCreate(caregiverId: string): OnboardingProfile {
    let caregiver = deps.repos.caregiver.get(caregiverId);
    if (!caregiver) caregiver = deps.repos.caregiver.create({ id: caregiverId, display_name: null });
    const existing = deps.repos.onboardingProfile.get(caregiverId);
    if (existing) return { ...existing, segmentElapsedSeconds: existing.segmentElapsedSeconds ?? 0 };
    const profile = createProfile(caregiverId);
    deps.repos.onboardingProfile.save(profile);
    return profile;
  }

  function touch(profile: OnboardingProfile): void {
    const timestamp = clock().getTime();
    if (profile.activeSince) {
      const delta = Math.max(0, Math.floor((timestamp - new Date(profile.activeSince).getTime()) / 1000));
      profile.elapsedSeconds += delta;
      profile.segmentElapsedSeconds += delta;
    }
    profile.activeSince = new Date(timestamp).toISOString();
    profile.updatedAt = profile.activeSince;
  }

  function checkCap(profile: OnboardingProfile): boolean {
    touch(profile);
    if (profile.segmentElapsedSeconds < 900) return false;
    profile.status = 'paused';
    profile.activeSince = null;
    profile.revision += 1;
    deps.repos.onboardingProfile.save(profile);
    return true;
  }

  function currentConsentActions(caregiverId: string): Partial<Record<ConsentRecord['consent_type'], ConsentAction>> {
    const actions: Partial<Record<ConsentRecord['consent_type'], ConsentAction>> = {};
    for (const record of deps.repos.consentRecord.list(caregiverId)) actions[record.consent_type] = record.action;
    return actions;
  }

  function requiresHospice(profile: OnboardingProfile): boolean {
    return profile.answers.care_phase?.normalized === 'hospice';
  }

  function activeSteps(profile: OnboardingProfile): StepDefinition[] {
    return STEPS.filter((step) => requiresHospice(profile) || !['hospice_agency', 'hospice_phone'].includes(step.id));
  }

  function missingRequired(profile: OnboardingProfile): OnboardingStepId[] {
    const consents = currentConsentActions(profile.caregiverId);
    return activeSteps(profile).flatMap((step) => {
      if (!step.required || ['caregiver_review', 'patient_review', 'wrap_up', 'complete'].includes(step.id)) return [];
      if (step.id === 'ai_data_consent') return consents.ai_data_processing === 'granted' ? [] : [step.id];
      if (step.id === 'patient_authorization') return consents.patient_information === 'granted' ? [] : [step.id];
      const answer = profile.answers[step.id];
      return answer && !answer.skipped && answer.confirmedAt ? [] : [step.id];
    });
  }

  function sectionStates(profile: OnboardingProfile): OnboardingSnapshot['sections'] {
    const labels: Record<OnboardingLocale, Record<OnboardingSection, string>> = {
      en: { privacy: 'Privacy', caregiver: 'About you', authorization: 'Permission', patient: 'About the patient', review: 'Review', complete: 'Ready' },
      es: { privacy: 'Privacidad', caregiver: 'Sobre usted', authorization: 'Permiso', patient: 'Sobre el paciente', review: 'Revisión', complete: 'Listo' },
    };
    const order: OnboardingSection[] = ['privacy', 'caregiver', 'authorization', 'patient', 'review', 'complete'];
    const activeIndex = order.indexOf(STEP_MAP.get(profile.currentStep)?.section ?? 'privacy');
    return order.map((section, index) => ({
      id: section,
      label: labels[profile.locale][section],
      state: index < activeIndex ? 'complete' : index === activeIndex ? (profile.currentStep.endsWith('review') ? 'review' : 'active') : 'upcoming',
    }));
  }

  function prompt(profile: OnboardingProfile): OnboardingPrompt | null {
    if (profile.status === 'paused' || profile.status === 'declined') return null;
    const step = STEP_MAP.get(profile.currentStep);
    if (!step) return null;
    const sequence = activeSteps(profile);
    const index = Math.max(0, sequence.findIndex((candidate) => candidate.id === step.id));
    const summaryIds = step.id === 'caregiver_review' ? CAREGIVER_STEPS : step.id === 'patient_review' ? PATIENT_STEPS : [];
    const summary: Partial<Record<OnboardingStepId, OnboardingAnswer>> = {};
    for (const id of summaryIds) {
      const answer = profile.answers[id];
      if (answer) summary[id] = answer;
    }
    return {
      id: `${step.id}:${profile.revision}`,
      stepId: step.id,
      section: step.section,
      kind: step.kind,
      question: step.question[profile.locale],
      why: step.why[profile.locale],
      choices: step.choices?.[profile.locale],
      inputMode: ['review', 'info', 'consent'].includes(step.kind) ? 'action_only' : 'voice_or_text',
      skippable: step.skippable,
      draft: profile.drafts[step.id] ?? profile.answers[step.id]?.raw ?? null,
      progress: { current: index + 1, total: sequence.length, percent: Math.min(100, Math.round((index / Math.max(1, sequence.length - 1)) * 100)) },
      locale: profile.locale,
      warning: profile.segmentElapsedSeconds >= 780
        ? (profile.locale === 'es' ? 'Quedan unos dos minutos. Puede pausar y volver en cualquier momento.' : 'About two minutes remain. You can pause and return anytime.')
        : null,
      summary: Object.keys(summary).length > 0 ? summary : undefined,
      complete: step.id === 'complete',
    };
  }

  function snapshot(profile: OnboardingProfile): OnboardingSnapshot {
    return {
      caregiverId: profile.caregiverId,
      version: profile.version,
      status: profile.status,
      locale: profile.locale,
      currentStep: profile.currentStep,
      prompt: prompt(profile),
      sections: sectionStates(profile),
      missingRequired: missingRequired(profile),
      consents: currentConsentActions(profile.caregiverId),
      answers: profile.answers,
      elapsedSeconds: profile.elapsedSeconds,
      completedAt: profile.completedAt,
    };
  }

  function assertPrompt(profile: OnboardingProfile, promptId: string): void {
    if (prompt(profile)?.id !== promptId) throw new OnboardingConflictError('This onboarding prompt is no longer active.');
  }

  function next(profile: OnboardingProfile): void {
    const steps = activeSteps(profile);
    const index = steps.findIndex((step) => step.id === profile.currentStep);
    profile.currentStep = steps[Math.min(index + 1, steps.length - 1)]?.id ?? 'complete';
    profile.revision += 1;
  }

  function appendConsent(profile: OnboardingProfile, type: ConsentRecord['consent_type'], action: ConsentAction, evidence: string, captureMethod: ConsentRecord['capture_method']): void {
    deps.repos.consentRecord.append({
      caregiver_id: profile.caregiverId,
      consent_type: type,
      action,
      actor: profile.answers.caregiver_name?.raw || 'caregiver',
      authority_basis: type === 'patient_information' ? (profile.answers.decision_maker?.raw ?? null) : null,
      subject: type === 'patient_information' ? (profile.answers.patient_name?.raw || 'patient') : 'family record',
      capture_method: captureMethod,
      disclosure_version: ONBOARDING_DISCLOSURE_VERSION,
      locale: profile.locale,
      evidence,
    });
  }

  function safetyMessage(value: string, profile: OnboardingProfile): string | null {
    const normalized = value.toLowerCase();
    const verdict = classifySafety(value);
    const chemoContext = profile.answers.last_treatment_type?.normalized === 'chemotherapy';
    const reportsFever = /fever|temperature|chills|fiebre|temperatura|escalofr[ií]os/.test(normalized)
      && !/\b(no|none|without|sin|ning[uú]n|ninguna)\b/.test(normalized);
    const redFlag = /trouble breathing|can'?t breathe|difficulty breathing|new confusion|suddenly confused|no puede respirar|dificultad.*respirar|confusi[oó]n nueva/.test(normalized)
      || (reportsFever && (chemoContext || /(chemo|chemotherapy|quimio)/.test(normalized)));
    if (verdict === 'none' && !redFlag) return null;
    return profile.locale === 'es'
      ? 'Esto puede ser urgente. No voy a limitarme a anotarlo. Llame ahora al equipo clínico o a la línea de hospicio; si hay peligro inmediato, llame a emergencias. Cuando esté a salvo, volveremos exactamente a esta pregunta.'
      : "This may be urgent. I won't just record it. Contact the clinical team or hospice line now; if there is immediate danger, call emergency services. When you're safe, we'll return to this exact question.";
  }

  function normalize(stepId: OnboardingStepId, raw: string): string | number | boolean | null {
    const value = raw.trim();
    const lower = value.toLowerCase();
    if (stepId === 'caregiver_distance') {
      if (/together|same home|live with|juntos|misma casa|vive? con/.test(lower)) return 'together';
      if (/near|nearby|close|cerca/.test(lower)) return 'nearby';
      if (/far|remote|another (city|state)|lejos|otra ciudad|otro estado/.test(lower)) return 'far_away';
      return null;
    }
    if (stepId === 'language_preference') {
      if (/both|switch|ambos|cambiar/.test(lower)) return 'bilingual';
      if (/spanish|español/.test(lower)) return 'es';
      if (/english|inglés|ingles/.test(lower)) return 'en';
      return null;
    }
    if (stepId === 'care_phase') {
      if (/hospice|hospicio/.test(lower)) return 'hospice';
      if (/between|entre/.test(lower)) return 'between_treatments';
      if (/finished|complete|terminado|completado/.test(lower)) return 'finished_treatment';
      if (/in treatment|treatment now|en tratamiento/.test(lower)) return 'in_treatment';
      if (/diagnos|diagnóst/.test(lower)) return 'newly_diagnosed';
      return 'unknown';
    }
    if (stepId === 'last_treatment_type') {
      if (/chemo|quimio/.test(lower)) return 'chemotherapy';
      if (/radiation|radiaci[oó]n/.test(lower)) return 'radiation';
      if (/surgery|cirug[ií]a/.test(lower)) return 'surgery';
      if (/pill|oral|pastilla/.test(lower)) return 'oral_medication';
      if (/immun|inmun/.test(lower)) return 'immunotherapy';
      if (/other|otro/.test(lower)) return 'other';
      return null;
    }
    if (stepId === 'baseline_pain') {
      const match = lower.match(/(?:^|\b)(10|[0-9])(?:\s*(?:out of|de)\s*10)?(?:\b|$)/);
      return match ? Number(match[1]) : null;
    }
    if (stepId === 'baseline_breathing') return category(lower, [['normal', /normal|usual|bien|igual/], ['limited', /short|difficult|labored|limit|falta|dif[ií]cil/]]);
    if (stepId === 'baseline_nutrition') return category(lower, [['normal', /normal|well|bien/], ['reduced', /less|little|poor|reduc|poco/], ['unable', /none|nothing|unable|nada|no puede/]]);
    if (stepId === 'baseline_alertness') return category(lower, [['alert', /alert|awake|normal|despiert|alerta/], ['drowsy', /drows|sleepy|somnol/], ['confused', /confus|desorient/]]);
    if (stepId === 'baseline_fever') return category(lower, [['none', /no|none|never|sin|nunca/], ['sometimes', /sometimes|occasional|a veces|ocasional/], ['usual', /usual|often|frequent|normal|frecuente/]]);
    if (stepId === 'caregiver_sleep') return category(lower, [['good', /good|well|fine|bien/], ['interrupted', /interrupt|wake|broken|despierto|interrump/], ['poor', /poor|bad|barely|not sleeping|mal|casi no/]]);
    if (stepId === 'last_treatment_date') {
      if (/not started|no treatment|a[uú]n no|sin tratamiento/.test(lower)) return 'not_started';
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
      const named = value.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+([0-3]?\d),?\s+(20\d{2})$/i);
      if (named) {
        const parsed = new Date(`${named[1]} ${named[2]}, ${named[3]} UTC`);
        return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
      }
      return null;
    }
    if (stepId === 'after_hours_number' || stepId === 'hospice_phone') {
      const digits = value.replace(/\D/g, '');
      return digits.length >= 10 && digits.length <= 15 ? `+${digits.length === 10 ? '1' : ''}${digits}` : null;
    }
    if (stepId === 'patient_age') {
      const age = lower.match(/\b(\d{1,3})\b/);
      if (age && Number(age[1]) <= 120) return Number(age[1]);
      const decade = lower.match(/\b(?:in (?:their|her|his) )?(\d{2})s\b/);
      return decade ? `${decade[1]}s` : null;
    }
    return value.length > 0 ? value : null;
  }

  function category(value: string, choices: Array<[string, RegExp]>): string {
    return choices.find(([, pattern]) => pattern.test(value))?.[0] ?? 'unknown';
  }

  function affirmative(value: string): boolean { return /^(yes|yep|yeah|i agree|agree|authorized|confirm|finish|sí|si|acepto|autorizado|confirmar|terminar)\b/i.test(value.trim()); }

  function mirrorPatient(profile: OnboardingProfile): void {
    const name = profile.answers.patient_name?.raw.trim();
    if (!name) return;
    const cancerType = profile.answers.cancer_type?.raw.trim() || null;
    const careTeam = {
      nurse_line: profile.answers.after_hours_number?.normalized?.toString() || profile.answers.after_hours_number?.raw,
      oncologist: profile.answers.oncologist?.raw,
      other: [
        ...(profile.answers.clinic?.raw ? [{ label: 'Cancer clinic', contact: profile.answers.clinic.raw }] : []),
        ...(profile.answers.hospice_agency?.raw ? [{ label: 'Hospice agency', contact: `${profile.answers.hospice_agency.raw}${profile.answers.hospice_phone?.raw ? ` — ${profile.answers.hospice_phone.raw}` : ''}` }] : []),
      ],
    };
    const existing = deps.repos.patient.getByCaregiver(profile.caregiverId);
    if (existing) {
      deps.repos.patient.update(existing.id, { ...existing, name, diagnosis: 'metastatic_cancer', diagnosis_notes: cancerType, care_team: careTeam });
    } else {
      deps.repos.patient.create({ caregiver_id: profile.caregiverId, name, diagnosis: 'metastatic_cancer', diagnosis_notes: cancerType, care_team: careTeam });
    }
  }

  function save(profile: OnboardingProfile, mirror = false): void {
    profile.updatedAt = iso();
    deps.repos.transaction(() => {
      deps.repos.onboardingProfile.save(profile);
      if (mirror) mirrorPatient(profile);
    });
  }

  return {
    getSnapshot(caregiverId: string): OnboardingSnapshot { return snapshot(getOrCreate(caregiverId)); },
    tick(caregiverId: string): OnboardingMutationResult {
      const profile = getOrCreate(caregiverId);
      if (!checkCap(profile)) save(profile);
      return { snapshot: snapshot(profile) };
    },
    resume(caregiverId: string): OnboardingSnapshot {
      const profile = getOrCreate(caregiverId);
      if (profile.status !== 'completed') {
        profile.status = 'in_progress';
        profile.activeSince = iso();
        profile.segmentElapsedSeconds = 0;
        profile.revision += 1;
        save(profile);
      }
      return snapshot(profile);
    },
    answer(caregiverId: string, promptId: string, value: string, captureMethod: 'voice' | 'typed'): OnboardingMutationResult {
      const profile = getOrCreate(caregiverId);
      assertPrompt(profile, promptId);
      if (checkCap(profile)) return { snapshot: snapshot(profile) };
      const danger = safetyMessage(value, profile);
      if (danger) {
        profile.revision += 1;
        save(profile);
        return {
          snapshot: snapshot(profile),
          safetyMessage: danger,
          safetyFlag: classifySafety(value) === 'crisis' ? 'crisis' : 'medical_refusal',
        };
      }
      const stepId = profile.currentStep;
      const timestamp = iso();
      if (stepId === 'ai_data_consent' || stepId === 'patient_authorization') {
        const granted = affirmative(value);
        appendConsent(profile, stepId === 'ai_data_consent' ? 'ai_data_processing' : 'patient_information', granted ? 'granted' : 'declined', value, captureMethod);
        if (!granted) {
          profile.status = 'declined';
          profile.activeSince = null;
        } else {
          if (stepId === 'ai_data_consent') deps.repos.caregiver.setConsent(caregiverId, timestamp);
          next(profile);
        }
        save(profile);
        return { snapshot: snapshot(profile) };
      }
      if (['caregiver_review', 'patient_review', 'wrap_up', 'complete'].includes(stepId)) {
        throw new OnboardingConflictError('Use the confirmation action for this step.');
      }
      const answer: OnboardingAnswer = {
        raw: value.trim().replace(/\s+/g, ' '),
        normalized: normalize(stepId, value),
        confirmedAt: stepId === 'decision_maker' ? timestamp : null,
        skipped: false,
        updatedAt: timestamp,
      };
      profile.answers[stepId] = answer;
      profile.drafts[stepId] = answer.raw;
      if (stepId === 'language_preference') {
        if (answer.normalized === 'es') profile.locale = 'es';
        if (answer.normalized === 'en') profile.locale = 'en';
      }
      next(profile);
      save(profile);
      return { snapshot: snapshot(profile) };
    },
    confirmSection(caregiverId: string, promptId: string): OnboardingMutationResult {
      const profile = getOrCreate(caregiverId);
      assertPrompt(profile, promptId);
      if (checkCap(profile)) return { snapshot: snapshot(profile) };
      const timestamp = iso();
      if (profile.currentStep === 'caregiver_review' || profile.currentStep === 'patient_review') {
        const ids = profile.currentStep === 'caregiver_review' ? CAREGIVER_STEPS : PATIENT_STEPS;
        for (const id of ids) {
          const answer = profile.answers[id];
          if (answer && !answer.skipped) answer.confirmedAt = timestamp;
        }
        const mirror = profile.currentStep === 'patient_review';
        next(profile);
        save(profile, mirror);
        return { snapshot: snapshot(profile) };
      }
      if (profile.currentStep === 'wrap_up') {
        const missing = missingRequired(profile);
        if (missing.length > 0) {
          profile.currentStep = missing[0] ?? 'caregiver_name';
          profile.revision += 1;
          save(profile);
          return { snapshot: snapshot(profile) };
        }
        profile.currentStep = 'complete';
        profile.status = 'completed';
        profile.completedAt = timestamp;
        profile.activeSince = null;
        profile.revision += 1;
        save(profile, true);
        return { snapshot: snapshot(profile) };
      }
      throw new OnboardingConflictError('This step cannot be confirmed.');
    },
    skip(caregiverId: string, promptId: string): OnboardingMutationResult {
      const profile = getOrCreate(caregiverId);
      assertPrompt(profile, promptId);
      const definition = STEP_MAP.get(profile.currentStep);
      if (!definition?.skippable) throw new OnboardingConflictError('This required consent or review cannot be skipped.');
      touch(profile);
      profile.answers[profile.currentStep] = { raw: '', normalized: null, confirmedAt: null, skipped: true, updatedAt: iso() };
      next(profile);
      save(profile);
      return { snapshot: snapshot(profile) };
    },
    back(caregiverId: string, promptId: string): OnboardingMutationResult {
      const profile = getOrCreate(caregiverId);
      assertPrompt(profile, promptId);
      touch(profile);
      const steps = activeSteps(profile);
      const index = steps.findIndex((step) => step.id === profile.currentStep);
      const previous = [...steps.slice(0, Math.max(index, 0))].reverse().find((step) => !['ai_data_consent', 'patient_authorization'].includes(step.id));
      if (previous) profile.currentStep = previous.id;
      profile.revision += 1;
      save(profile);
      return { snapshot: snapshot(profile) };
    },
    edit(caregiverId: string, promptId: string, stepId: OnboardingStepId): OnboardingMutationResult {
      const profile = getOrCreate(caregiverId);
      assertPrompt(profile, promptId);
      if (!REVIEWABLE.has(stepId)) throw new OnboardingConflictError('That item is not editable from this review.');
      touch(profile);
      profile.currentStep = stepId;
      profile.revision += 1;
      save(profile);
      return { snapshot: snapshot(profile) };
    },
    pause(caregiverId: string, promptId: string): OnboardingMutationResult {
      const profile = getOrCreate(caregiverId);
      assertPrompt(profile, promptId);
      touch(profile);
      profile.status = 'paused';
      profile.activeSince = null;
      profile.revision += 1;
      save(profile);
      return { snapshot: snapshot(profile) };
    },
    switchLanguage(caregiverId: string, promptId: string, locale: OnboardingLocale): OnboardingMutationResult {
      const profile = getOrCreate(caregiverId);
      assertPrompt(profile, promptId);
      touch(profile);
      profile.locale = locale;
      profile.revision += 1;
      save(profile);
      return { snapshot: snapshot(profile) };
    },
    correct(caregiverId: string, stepId: OnboardingStepId, value: string): OnboardingSnapshot {
      const profile = getOrCreate(caregiverId);
      if (!REVIEWABLE.has(stepId)) throw new OnboardingConflictError('That onboarding item cannot be edited.');
      const timestamp = iso();
      profile.answers[stepId] = { raw: value.trim(), normalized: normalize(stepId, value), confirmedAt: timestamp, skipped: false, updatedAt: timestamp };
      profile.drafts[stepId] = value.trim();
      profile.revision += 1;
      save(profile, true);
      return snapshot(profile);
    },
  };
}

export type OnboardingEngine = ReturnType<typeof createOnboardingEngine>;
