'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { OnboardingLocale, OnboardingPrompt, OnboardingSnapshot, OnboardingStepId } from '@turtle/shared';
import {
  ArrowLeft, Check, CheckCircle2, ChevronRight, Keyboard, Languages, LockKeyhole,
  Mic, Pause, Pencil, SkipForward, Sparkles, Volume2, X,
} from 'lucide-react';
import { TurtleLogo } from './TurtleLogo';
import { Orb, type AgentState } from './ui/orb';
import { MicrophoneWaveform } from './ui/waveform';
import { cn } from '@/lib/utils';

interface Props {
  prompt: OnboardingPrompt;
  snapshot: OnboardingSnapshot | null;
  liveAnswer?: string;
  capturing: boolean;
  agentState: AgentState;
  micError?: string | null;
  voiceFallback?: boolean;
  onReplayPrompt(promptId: string): Promise<void>;
  onToggleVoice(): void;
  onAnswer(promptId: string, value: string, captureMethod?: 'voice' | 'typed'): void;
  onConfirm(promptId: string): void;
  onEdit(promptId: string, stepId: OnboardingStepId): void;
  onSkip(promptId: string): void;
  onBack(promptId: string): void;
  onPause(promptId: string): void;
  onLanguage(promptId: string, locale: OnboardingLocale): void;
  onClose?(): void;
}

const LABELS: Partial<Record<OnboardingStepId, { en: string; es: string }>> = {
  caregiver_name: { en: 'Your name', es: 'Su nombre' }, caregiver_relationship: { en: 'Relationship', es: 'Relación' },
  caregiver_distance: { en: 'Where you live', es: 'Dónde vive' }, language_preference: { en: 'Language', es: 'Idioma' },
  decision_maker: { en: 'Decision-maker', es: 'Persona que decide' }, caregiver_sleep: { en: 'Your sleep', es: 'Su sueño' },
  patient_name: { en: 'Patient name', es: 'Nombre del paciente' }, patient_age: { en: 'Rough age', es: 'Edad aproximada' },
  cancer_type: { en: 'Cancer type', es: 'Tipo de cáncer' }, care_phase: { en: 'Care phase', es: 'Etapa de atención' },
  last_treatment_date: { en: 'Last treatment', es: 'Último tratamiento' }, last_treatment_type: { en: 'Treatment type', es: 'Tipo de tratamiento' },
  clinic: { en: 'Clinic', es: 'Clínica' }, oncologist: { en: 'Oncologist', es: 'Oncólogo' },
  after_hours_number: { en: 'After-hours line', es: 'Línea fuera de horario' }, baseline_pain: { en: 'Usual pain', es: 'Dolor habitual' },
  baseline_breathing: { en: 'Usual breathing', es: 'Respiración habitual' }, baseline_nutrition: { en: 'Eating & drinking', es: 'Comida y bebida' },
  baseline_alertness: { en: 'Usual alertness', es: 'Estado de alerta habitual' }, baseline_fever: { en: 'Fevers & chills', es: 'Fiebre y escalofríos' },
  medication_concern: { en: 'Medication concern', es: 'Medicamento que preocupa' }, hospice_agency: { en: 'Hospice agency', es: 'Agencia de hospicio' },
  hospice_phone: { en: 'Hospice 24-hour line', es: 'Línea de hospicio 24 horas' },
};

const CAREGIVER_FIELDS: OnboardingStepId[] = [
  'caregiver_name', 'caregiver_relationship', 'caregiver_distance', 'language_preference', 'decision_maker', 'caregiver_sleep',
];
const PATIENT_FIELDS: OnboardingStepId[] = [
  'patient_name', 'patient_age', 'cancer_type', 'care_phase', 'last_treatment_date', 'last_treatment_type',
  'clinic', 'oncologist', 'after_hours_number', 'baseline_pain', 'baseline_breathing', 'baseline_nutrition',
  'baseline_alertness', 'baseline_fever', 'medication_concern', 'hospice_agency', 'hospice_phone',
];

function statusCopy(agentState: AgentState, capturing: boolean, locale: OnboardingLocale) {
  if (locale === 'es') {
    if (capturing) return ['Turtle está escuchando', 'Hable con naturalidad. Toque cuando termine.'];
    if (agentState === 'talking') return ['Turtle está hablando', 'Escuche; podrá responder en un momento.'];
    if (agentState === 'thinking') return ['Guardando su respuesta', 'Turtle está completando su perfil.'];
    return ['Su turno', 'Toque el micrófono y responda con naturalidad.'];
  }
  if (capturing) return ['Turtle is listening', 'Speak naturally. Tap when you’re finished.'];
  if (agentState === 'talking') return ['Turtle is speaking', 'Listen in—then answer when you’re ready.'];
  if (agentState === 'thinking') return ['Saving what you said', 'Turtle is updating your care profile.'];
  return ['Your turn', 'Tap the microphone and answer naturally.'];
}

export function OnboardingCard(props: Props) {
  const { prompt } = props;
  const locale = prompt.locale;
  const [value, setValue] = useState(prompt.draft ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [showKeyboard, setShowKeyboard] = useState(false);
  const [voiceStarted, setVoiceStarted] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isAction = prompt.kind === 'review' || prompt.kind === 'info';

  useEffect(() => {
    setValue(prompt.draft ?? '');
    setSubmitting(false);
    setShowKeyboard(false);
  }, [prompt.id, prompt.draft]);

  useEffect(() => {
    if (showKeyboard) window.setTimeout(() => inputRef.current?.focus(), 80);
  }, [showKeyboard]);

  const speakWithDevice = () => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(prompt.question);
    utterance.lang = locale === 'es' ? 'es-US' : 'en-US';
    utterance.rate = 0.96;
    window.speechSynthesis.speak(utterance);
  };

  useEffect(() => {
    if (voiceStarted && props.voiceFallback) speakWithDevice();
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    };
  }, [prompt.id, props.voiceFallback, voiceStarted]);

  const answers = props.snapshot?.answers ?? {};
  const completedCount = Object.values(answers).filter((answer) => answer && !answer.skipped).length;
  const [stateTitle, stateHint] = statusCopy(props.agentState, props.capturing, locale);
  const copy = locale === 'es' ? {
    title: 'Configuración por voz', pause: 'Pausar', skip: 'Omitir', type: 'Escriba su respuesta', send: 'Enviar',
    back: 'Atrás', profile: 'Perfil de atención', profileHint: 'Se completa mientras habla', you: 'Usted dijo',
    start: 'Comenzar conversación por voz', startHint: 'Turtle se presentará y hará una pregunta a la vez.',
    keyboard: 'Prefiero escribir', closeKeyboard: 'Ocultar teclado', quick: 'O toque una respuesta rápida',
    confirm: 'Sí, todo está correcto', finish: 'Finalizar configuración', saved: 'guardados', waiting: 'Por completar',
    private: 'Privado y bajo su control', edit: 'Editar', caregiver: 'Sobre usted', patient: 'Paciente y atención',
    permissions: 'Permisos', permitted: 'Autorizado', notYet: 'Aún no autorizado', replay: 'Repetir pregunta', deviceVoice: 'Voz del dispositivo',
  } : {
    title: 'Voice setup', pause: 'Pause', skip: 'Skip', type: 'Type your answer', send: 'Send',
    back: 'Back', profile: 'Care profile', profileHint: 'Fills in while you talk', you: 'You said',
    start: 'Start voice conversation', startHint: 'Turtle will introduce itself and ask one question at a time.',
    keyboard: 'I’d rather type', closeKeyboard: 'Hide keyboard', quick: 'Or tap a quick answer',
    confirm: 'Yes, everything is right', finish: 'Finish setup', saved: 'saved', waiting: 'Waiting to learn',
    private: 'Private and in your control', edit: 'Edit', caregiver: 'About you', patient: 'Patient & care',
    permissions: 'Permissions', permitted: 'Authorized', notYet: 'Not authorized yet', replay: 'Replay question', deviceVoice: 'Device voice',
  };
  const displayedStateTitle = voiceStarted ? stateTitle : (locale === 'es' ? 'Listo para comenzar' : 'Ready to begin');

  const profileGroups = useMemo(() => [
    { title: copy.caregiver, fields: CAREGIVER_FIELDS },
    { title: copy.patient, fields: PATIENT_FIELDS },
  ], [copy.caregiver, copy.patient]);

  const submit = () => {
    const answer = value.trim();
    if (answer && !submitting) {
      setSubmitting(true);
      props.onAnswer(prompt.id, answer, 'typed');
    }
  };
  const startVoice = () => {
    setVoiceStarted(true);
    if (!props.voiceFallback) void props.onReplayPrompt(prompt.id);
  };
  const replayQuestion = () => {
    if (props.voiceFallback) speakWithDevice();
    else void props.onReplayPrompt(prompt.id);
  };
  const toggleVoice = () => {
    if (!voiceStarted) startVoice();
    props.onToggleVoice();
  };

  return (
    <section className="fixed inset-0 z-[80] overflow-y-auto bg-[#07111f] text-white" aria-label={copy.title}>
      <div className="pointer-events-none fixed inset-0 opacity-70 [background:radial-gradient(circle_at_20%_12%,rgba(37,99,235,.24),transparent_28rem),radial-gradient(circle_at_76%_86%,rgba(245,158,11,.09),transparent_30rem)]" />
      <div className="relative mx-auto flex min-h-full w-full max-w-[1440px] flex-col px-4 py-4 sm:px-6 sm:py-5 lg:h-dvh lg:px-8">
        <header className="flex shrink-0 items-center justify-between gap-3 pb-4">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-2xl bg-[#2563eb] text-[#fbbf24] shadow-[0_8px_30px_rgba(37,99,235,.32)]"><TurtleLogo className="h-5 w-5 fill-current" /></span>
            <div><p className="m-0 text-lg font-extrabold tracking-tight">Turtle</p><p className="m-0 text-[10px] font-bold uppercase tracking-[.18em] text-slate-400">{copy.title}</p></div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => props.onLanguage(prompt.id, locale === 'en' ? 'es' : 'en')} className="inline-flex h-10 items-center gap-2 rounded-full border border-white/10 bg-white/[.06] px-3 text-xs font-bold text-slate-200 transition hover:bg-white/10 cursor-pointer" aria-label={locale === 'en' ? 'Cambiar a español' : 'Switch to English'}><Languages className="h-4 w-4" /><span className="hidden sm:inline">{locale === 'en' ? 'Español' : 'English'}</span></button>
            <button type="button" onClick={() => props.onPause(prompt.id)} className="inline-flex h-10 items-center gap-2 rounded-full border border-white/10 bg-white/[.06] px-3 text-xs font-bold text-slate-200 transition hover:bg-white/10 cursor-pointer" aria-label={copy.pause}><Pause className="h-4 w-4" /><span className="hidden sm:inline">{copy.pause}</span></button>
            {props.onClose ? (
              <button type="button" onClick={props.onClose} className="grid h-10 w-10 place-items-center rounded-full border border-white/10 bg-white/[.06] text-slate-200 transition hover:bg-white/10 hover:text-white cursor-pointer" aria-label="Close demo">
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </header>

        <div className="mb-4 flex shrink-0 items-center gap-3" aria-label={`${prompt.progress.percent}% complete`}>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-[#2563eb] to-[#f5b82e] transition-[width] duration-700" style={{ width: `${Math.max(2, prompt.progress.percent)}%` }} /></div>
          <span className="text-[10px] font-extrabold uppercase tracking-[.14em] text-slate-400">{prompt.progress.percent}%</span>
        </div>

        <main className="grid min-h-0 flex-1 gap-4 pb-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(380px,.8fr)]">
          <div className="relative flex min-h-[620px] flex-col overflow-hidden rounded-[32px] border border-white/10 bg-[#0b192c]/80 p-5 shadow-[0_30px_100px_rgba(0,0,0,.34)] backdrop-blur-xl sm:p-7 lg:min-h-0">
            <div className="flex items-center justify-between gap-4">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[.06] px-3 py-1.5 text-[11px] font-bold text-slate-300"><span className={cn('h-2 w-2 rounded-full', props.capturing ? 'animate-pulse bg-[#f5b82e]' : voiceStarted && props.agentState === 'talking' ? 'animate-pulse bg-[#60a5fa]' : 'bg-emerald-400')} />{displayedStateTitle}</div>
              <span className="text-[11px] font-semibold text-slate-500">{prompt.progress.current} of {prompt.progress.total}</span>
            </div>

            {prompt.warning ? <p className="mt-4 rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-xs font-semibold text-amber-100" role="status">{prompt.warning}</p> : null}

            <div className="flex flex-1 flex-col items-center justify-center py-5 sm:py-7">
              <div className="relative grid h-40 w-40 shrink-0 place-items-center sm:h-52 sm:w-52 lg:h-56 lg:w-56" aria-hidden="true">
                <div className={cn('absolute inset-[12%] rounded-full blur-3xl transition-colors duration-500', props.capturing ? 'bg-amber-400/15' : 'bg-blue-500/20')} />
                <div className={cn('absolute inset-[19%] rounded-full bg-[radial-gradient(circle_at_32%_28%,#60a5fa_0%,#2563eb_38%,#102a70_72%,#08152b_100%)] shadow-[inset_-18px_-22px_38px_rgba(1,8,22,.6),0_0_70px_rgba(37,99,235,.24)] transition duration-500', props.capturing && 'scale-105 bg-[radial-gradient(circle_at_32%_28%,#fcd34d_0%,#2563eb_42%,#102a70_75%,#08152b_100%)]')} />
                <Orb agentState={props.capturing ? 'listening' : props.agentState} colors={props.capturing ? ['#2563eb', '#f5b82e'] : ['#1d4ed8', '#60a5fa']} inverted bgColor="#0b192c" />
              </div>
              <div className="mt-2 max-w-2xl text-center">
                <div className="mb-3 flex flex-wrap items-center justify-center gap-2 text-[10px] font-extrabold uppercase tracking-[.18em] text-blue-300"><span className="inline-flex items-center gap-2"><Volume2 className="h-3.5 w-3.5" />Turtle</span>{props.voiceFallback ? <span className="rounded-full border border-amber-300/20 bg-amber-300/10 px-2 py-1 text-[8px] tracking-[.08em] text-amber-200">{copy.deviceVoice}</span> : null}{voiceStarted ? <button type="button" onClick={replayQuestion} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[.06] px-2.5 py-1 text-[9px] tracking-[.08em] text-slate-300 transition hover:border-blue-300/40 hover:text-white" aria-label={copy.replay}><Volume2 className="h-3 w-3" />{copy.replay}</button> : null}</div>
                <h1 id="onboarding-question" className={cn('m-0 font-bold tracking-[-.02em] text-white', prompt.kind === 'consent' ? 'text-base leading-[1.45] sm:text-lg' : 'text-xl leading-[1.35] sm:text-2xl')}>{prompt.question}</h1>
                <p className="mx-auto mt-3 max-w-xl text-xs leading-5 text-slate-400">{prompt.why}</p>
              </div>
              {props.liveAnswer ? <div className="mt-4 max-w-xl rounded-2xl rounded-tr-sm border border-blue-400/20 bg-blue-500/15 px-4 py-2.5 text-center text-sm leading-6 text-blue-50" aria-live="polite"><span className="mr-2 text-[9px] font-extrabold uppercase tracking-[.15em] text-blue-300">{copy.you}</span>{props.liveAnswer}</div> : null}
            </div>

            {!voiceStarted ? (
              <div className="mx-auto w-full max-w-md rounded-[24px] border border-blue-400/25 bg-blue-500/10 p-4 text-center">
                <button type="button" onClick={startVoice} className="inline-flex h-14 w-full items-center justify-center gap-3 rounded-2xl bg-white px-5 text-sm font-extrabold text-[#0b192c] shadow-[0_12px_32px_rgba(0,0,0,.22)] transition hover:-translate-y-0.5 hover:bg-blue-50"><span className="grid h-8 w-8 place-items-center rounded-full bg-[#2563eb] text-white"><Volume2 className="h-4 w-4" /></span>{copy.start}<ChevronRight className="h-4 w-4 text-[#2563eb]" /></button>
                <p className="mb-0 mt-2.5 text-[11px] leading-5 text-slate-400">{copy.startHint}</p>
              </div>
            ) : isAction ? (
              <div className="mx-auto w-full max-w-md">
                <div className="flex items-center justify-center gap-3">
                  <button type="button" onClick={toggleVoice} disabled={submitting || props.agentState === 'talking'} className={cn('grid h-14 w-14 shrink-0 place-items-center rounded-full border transition disabled:cursor-not-allowed disabled:opacity-40', props.capturing ? 'border-amber-300 bg-[#f5b82e] text-[#0b192c] shadow-[0_0_30px_rgba(245,184,46,.28)]' : 'border-white/20 bg-white/10 text-white hover:bg-white/15')} aria-label={props.capturing ? 'Stop and send' : 'Confirm by voice'}><Mic className="h-5 w-5" /></button>
                  <button type="button" disabled={submitting} onClick={() => { setSubmitting(true); props.onConfirm(prompt.id); }} className="inline-flex h-14 flex-1 items-center justify-center gap-2 rounded-2xl bg-[#2563eb] px-5 text-sm font-extrabold text-white shadow-[0_12px_30px_rgba(37,99,235,.3)] transition hover:bg-[#1d4ed8] disabled:opacity-50"><Check className="h-4 w-4 text-[#fbbf24]" />{prompt.stepId === 'wrap_up' ? copy.finish : copy.confirm}</button>
                </div>
                <p className="mb-0 mt-2 text-center text-[11px] text-slate-500">{locale === 'es' ? 'También puede decir “sí, correcto”.' : 'You can also say “yes, that’s right.”'}</p>
              </div>
            ) : (
              <div className="mx-auto w-full max-w-xl">
                <div className="flex items-center justify-center gap-4">
                  <div className="hidden h-7 flex-1 overflow-hidden sm:block"><MicrophoneWaveform active={props.capturing} height={28} barColor={props.capturing ? '#f5b82e' : '#3b82f6'} className="w-full opacity-80" /></div>
                  <button type="button" disabled={submitting || props.agentState === 'talking'} onClick={toggleVoice} className={cn('grid h-[72px] w-[72px] shrink-0 place-items-center rounded-full border-4 border-[#0b192c] transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40', props.capturing ? 'scale-105 bg-[#f5b82e] text-[#0b192c] shadow-[0_0_0_5px_rgba(245,184,46,.18),0_0_36px_rgba(245,184,46,.28)]' : 'bg-[#2563eb] text-white shadow-[0_0_0_5px_rgba(59,130,246,.15),0_14px_30px_rgba(0,0,0,.28)] hover:bg-[#1d4ed8]')} aria-pressed={props.capturing} aria-label={props.capturing ? 'Stop and send your answer' : 'Tap to answer by voice'}><Mic className="h-7 w-7" /></button>
                  <div className="hidden h-7 flex-1 overflow-hidden sm:block"><MicrophoneWaveform active={props.capturing} height={28} barColor={props.capturing ? '#f5b82e' : '#3b82f6'} className="w-full opacity-80" /></div>
                </div>
                <p className={cn('mb-0 mt-2 text-center text-xs font-bold', props.micError ? 'text-rose-300' : props.capturing ? 'text-amber-200' : 'text-slate-300')}>{props.micError ?? stateHint}</p>
                {prompt.choices?.length ? <div className="mt-4"><p className="mb-2 text-center text-[9px] font-extrabold uppercase tracking-[.17em] text-slate-500">{copy.quick}</p><div className="flex flex-wrap justify-center gap-2">{prompt.choices.map((choice) => <button key={choice} type="button" disabled={submitting} onClick={() => { setSubmitting(true); props.onAnswer(prompt.id, choice, 'typed'); }} className="rounded-full border border-white/10 bg-white/[.06] px-3.5 py-2 text-xs font-bold text-slate-200 transition hover:border-blue-400/40 hover:bg-blue-400/10 hover:text-white disabled:opacity-40">{choice}</button>)}</div></div> : null}
                <div className="mt-3 text-center"><button type="button" onClick={() => setShowKeyboard((current) => !current)} className="inline-flex items-center gap-2 px-3 py-1.5 text-[11px] font-bold text-slate-400 transition hover:text-white"><Keyboard className="h-3.5 w-3.5" />{showKeyboard ? copy.closeKeyboard : copy.keyboard}</button></div>
                {showKeyboard ? <form onSubmit={(event) => { event.preventDefault(); submit(); }} className="mt-2 flex gap-2"><input ref={inputRef} disabled={submitting} value={value} onChange={(event) => setValue(event.target.value)} placeholder={copy.type} aria-label={copy.type} className="h-12 min-w-0 flex-1 rounded-xl border border-white/15 bg-black/20 px-4 text-sm text-white outline-none placeholder:text-slate-600 focus:border-blue-400 focus:ring-2 focus:ring-blue-400/20" /><button type="submit" disabled={!value.trim() || submitting} className="h-12 rounded-xl bg-white px-5 text-xs font-extrabold text-[#0b192c] disabled:opacity-40">{copy.send}</button></form> : null}
              </div>
            )}
          </div>

          <aside className="flex min-h-[520px] flex-col overflow-hidden rounded-[32px] border border-[#d9e1ec] bg-[#f8fafc] text-[#0b192c] shadow-[0_30px_100px_rgba(0,0,0,.24)] lg:min-h-0" aria-label={copy.profile}>
            <div className="flex items-start justify-between gap-4 border-b border-[#e2e8f0] bg-white px-5 py-5 sm:px-6">
              <div><div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-[#2563eb]" /><h2 className="m-0 text-lg font-extrabold tracking-tight">{copy.profile}</h2></div><p className="mb-0 mt-1 text-xs text-[#64748b]">{copy.profileHint}</p></div>
              <span className="rounded-full bg-[#eff6ff] px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-[.12em] text-[#2563eb]">{completedCount} {copy.saved}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
              <div className="mb-5 grid grid-cols-2 gap-2">
                <div className="rounded-2xl border border-[#dbeafe] bg-[#eff6ff] p-3"><div className="flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[.11em] text-[#1d4ed8]"><LockKeyhole className="h-3.5 w-3.5" />{copy.permissions}</div><p className="mb-0 mt-2 text-xs font-bold text-[#0b192c]">{props.snapshot?.consents.ai_data_processing === 'granted' ? copy.permitted : copy.notYet}</p></div>
                <div className="rounded-2xl border border-[#e2e8f0] bg-white p-3"><div className="flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[.11em] text-[#64748b]"><CheckCircle2 className="h-3.5 w-3.5" />{copy.private}</div><p className="mb-0 mt-2 text-xs font-bold text-[#0b192c]">{locale === 'es' ? 'Puede editarlo todo' : 'Everything is editable'}</p></div>
              </div>
              <div className="space-y-6">
                {profileGroups.map((group) => {
                  const isActiveGroup = (prompt.section === 'caregiver' && group.fields === CAREGIVER_FIELDS) || (['patient', 'authorization', 'review'].includes(prompt.section) && group.fields === PATIENT_FIELDS);
                  const visibleFields = group.fields.filter((stepId) => answers[stepId] || stepId === prompt.stepId || isActiveGroup);
                  if (visibleFields.length === 0) return null;
                  return <section key={group.title}><h3 className="m-0 text-[10px] font-extrabold uppercase tracking-[.16em] text-[#64748b]">{group.title}</h3><div className="mt-2 overflow-hidden rounded-2xl border border-[#e2e8f0] bg-white">{visibleFields.map((stepId) => {
                    const answer = answers[stepId];
                    const active = stepId === prompt.stepId;
                    return <div key={stepId} className={cn('group flex min-h-[58px] items-center gap-3 border-b border-[#eef2f7] px-3.5 py-2.5 last:border-b-0 transition', active && 'bg-[#eff6ff]')}>
                      <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-full border text-[10px] font-extrabold', answer && !answer.skipped ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : active ? 'border-blue-200 bg-blue-100 text-blue-700' : 'border-slate-200 bg-slate-50 text-slate-400')}>{answer && !answer.skipped ? <Check className="h-3.5 w-3.5" /> : active ? <Mic className="h-3.5 w-3.5" /> : '·'}</span>
                      <span className="min-w-0 flex-1"><span className="block text-[9px] font-extrabold uppercase tracking-[.1em] text-[#64748b]">{LABELS[stepId]?.[locale] ?? stepId.replaceAll('_', ' ')}</span><span className={cn('mt-0.5 block truncate text-xs font-semibold', answer?.skipped ? 'italic text-amber-700' : answer?.raw ? 'text-[#0b192c]' : active ? 'text-[#2563eb]' : 'text-[#b2bdca]')}>{answer?.skipped ? copy.waiting : answer?.raw || (active ? displayedStateTitle : copy.waiting)}</span></span>
                      {answer && !answer.skipped ? <button type="button" onClick={() => props.onEdit(prompt.id, stepId)} className="grid h-8 w-8 place-items-center rounded-full text-[#94a3b8] opacity-0 transition hover:bg-[#eff6ff] hover:text-[#2563eb] group-hover:opacity-100 focus:opacity-100" aria-label={`${copy.edit} ${LABELS[stepId]?.[locale] ?? stepId}`}><Pencil className="h-3.5 w-3.5" /></button> : null}
                    </div>;
                  })}</div></section>;
                })}
                {completedCount === 0 && !['caregiver', 'patient'].includes(prompt.section) ? <div className="rounded-2xl border border-dashed border-[#cbd5e1] bg-white/60 px-5 py-8 text-center"><Mic className="mx-auto h-5 w-5 text-[#2563eb]" /><p className="mb-0 mt-3 text-sm font-bold text-[#334155]">{locale === 'es' ? 'Su perfil aparecerá aquí' : 'Your profile will take shape here'}</p><p className="mb-0 mt-1 text-xs leading-5 text-[#94a3b8]">{locale === 'es' ? 'Turtle completa cada dato después de escucharlo.' : 'Turtle fills each detail after hearing it from you.'}</p></div> : null}
              </div>
            </div>
          </aside>
        </main>

        <footer className="flex shrink-0 items-center justify-between gap-4 pt-1 text-slate-400">
          <button type="button" onClick={() => props.onBack(prompt.id)} disabled={prompt.stepId === 'ai_data_consent'} className="inline-flex items-center gap-2 px-1 py-2 text-xs font-bold transition hover:text-white disabled:invisible"><ArrowLeft className="h-4 w-4" />{copy.back}</button>
          <div className="hidden items-center gap-2 text-[10px] font-semibold sm:flex"><LockKeyhole className="h-3.5 w-3.5" />{locale === 'es' ? 'No se programan llamadas ni mensajes sin su permiso.' : 'No calls or messages are scheduled without your permission.'}</div>
          {prompt.skippable ? <button type="button" onClick={() => props.onSkip(prompt.id)} className="inline-flex items-center gap-2 px-1 py-2 text-xs font-bold transition hover:text-amber-200">{copy.skip}<SkipForward className="h-4 w-4" /></button> : <span />}
        </footer>
      </div>
    </section>
  );
}
