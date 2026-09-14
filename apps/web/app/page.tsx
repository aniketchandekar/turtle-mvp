'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssistantState, Card, OnboardingPrompt } from '@turtle/shared';
import {
  Activity,
  ArrowRight,
  Check,
  ChevronRight,
  FileText,
  GraduationCap,
  Mic2,
  PhoneCall,
  ShieldCheck,
  User,
  Volume2,
  X,
} from 'lucide-react';
import { VoiceView } from '@/components/VoiceView';
import { TextView } from '@/components/TextView';
import { Tabs } from '@/components/ui/tabs';
import { type TranscriptLine } from '@/components/Transcript';
import { CardSurface } from '@/components/CardSurface';
import { DegradedBanner } from '@/components/DegradedBanner';
import { useHealth } from '@/lib/useHealth';
import { useOnboarding } from '@/lib/useOnboarding';
import { Onboarding } from '@/components/Onboarding';
import { OnboardingCard } from '@/components/OnboardingCard';
import { useSession } from '@/lib/useSession';
import { Orb, type AgentState } from '@/components/ui/orb';
import { TurtleLogo } from '@/components/TurtleLogo';
import { cn } from '@/lib/utils';

type Mode = 'voice' | 'text';

const CAREGIVER_STARTERS = [
  'What can you help me with today?',
  'I want to log an update.',
  'Help me prepare for our next visit.',
  'What does metastatic cancer mean?',
] as const;

const SUPPORT_AREAS = [
  {
    icon: PhoneCall,
    number: '01',
    title: 'A familiar voice, anytime',
    body: 'Turtle calls to check in and answers when the night feels long—giving caregivers a calm place to start.',
  },
  {
    icon: GraduationCap,
    number: '02',
    title: 'Training for the care itself',
    body: 'Plain-language coaching for the practical tasks families are asked to perform without enough preparation.',
  },
  {
    icon: Activity,
    number: '03',
    title: 'The caregiver gets watched, too',
    body: 'Conversational burden check-ins notice strain, sleep loss, isolation, and when human support may help.',
  },
  {
    icon: FileText,
    number: '04',
    title: 'Paperwork, made less daunting',
    body: 'Education and step-by-step navigation for advance directives, healthcare proxies, and family coordination.',
  },
] as const;

const CARE_PHASES = [
  ['Active treatment', 'Check-ins, visit preparation, care logs, and practical coaching.'],
  ['Palliative care', 'Goals-of-care education and help preparing questions for the clinical team.'],
  ['Hospice', 'Calm orientation, comfort-care education, and connection to the hospice nurse.'],
  ['Bereavement', 'Gentle follow-up, grief resources, and help with the practical next steps.'],
] as const;

function toAgentState(state: AssistantState, capturing: boolean): AgentState {
  if (capturing || state === 'LISTENING') return 'listening';
  if (state === 'THINKING') return 'thinking';
  if (state === 'SPEAKING' || state === 'CLOSING') return 'talking';
  return null;
}

export default function Home() {
  const [demoOpen, setDemoOpen] = useState(false);

  return (
    <main className="marketing-page min-h-screen overflow-hidden bg-white text-[#0b192c]">
      <header className="relative z-20 mx-auto flex w-full max-w-[1180px] items-center justify-between px-5 py-5 sm:px-8 lg:px-10">
        <a href="#top" className="flex items-center gap-2.5 text-[#0b192c] no-underline" aria-label="Turtle home">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#1d4ed8] text-[#fbbf24] shadow-sm shadow-blue-500/20">
            <TurtleLogo className="h-5 w-5 fill-current" />
          </span>
          <span className="text-xl font-extrabold tracking-tight text-[#0b192c]">Turtle</span>
        </a>

        <nav className="hidden items-center gap-8 text-sm font-semibold text-[#475569] md:flex" aria-label="Primary navigation">
          <a href="#how-it-helps" className="transition hover:text-[#1d4ed8]">How it helps</a>
          <a href="#journey" className="transition hover:text-[#1d4ed8]">The care journey</a>
          <a href="#safety" className="transition hover:text-[#1d4ed8]">Safety</a>
        </nav>

        <button
          type="button"
          onClick={() => setDemoOpen(true)}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-[#1d4ed8] px-4 text-sm font-bold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-[#1e40af] focus-visible:outline-[#1d4ed8] cursor-pointer"
        >
          <Mic2 className="h-4 w-4 text-[#fbbf24]" /> Try Turtle
        </button>
      </header>

      <section id="top" className="relative mx-auto grid min-h-[640px] w-full max-w-[1260px] items-center gap-8 px-5 pb-12 pt-8 sm:px-8 lg:grid-cols-[1.08fr_0.92fr] lg:px-10 lg:pb-16 lg:pt-10">
        <div className="relative z-10 max-w-2xl marketing-reveal">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#bfdbfe] bg-[#eff6ff] px-4 py-2 text-[11px] font-extrabold uppercase tracking-[0.16em] text-[#1d4ed8]">
            <span className="h-2 w-2 rounded-full bg-[#f59e0b] shadow-[0_0_8px_rgba(245,158,11,0.6)]" /> For family caregivers navigating cancer
          </p>
          <h1 className="m-0 text-[clamp(3rem,5.6vw,5.4rem)] font-extrabold leading-[0.92] tracking-[-0.04em] text-[#0b192c]">
            Caregiving is hard.
            <span className="mt-2 block text-[#1d4ed8]">You shouldn’t do it alone.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-7 text-[#475569] sm:text-xl font-normal">
            Turtle is an AI voice companion for the family caregivers of people with cancer—here to call, listen, coach, organize, and stay through every phase of care.
          </p>
          <div className="mt-7 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={() => setDemoOpen(true)}
              className="group inline-flex h-14 items-center gap-3 rounded-full bg-[#1d4ed8] px-7 text-base font-bold text-white shadow-[0_12px_32px_rgba(29,78,216,0.32)] transition hover:-translate-y-1 hover:bg-[#1e40af] cursor-pointer"
            >
              Try the live voice demo
              <ArrowRight className="h-4 w-4 text-[#fbbf24] transition-transform group-hover:translate-x-1" />
            </button>
            <span className="text-sm font-medium leading-5 text-[#64748b]">No account needed<br />Microphone optional</span>
          </div>
        </div>

        <div className="relative mx-auto flex min-h-[540px] w-full max-w-[560px] items-center justify-center marketing-reveal marketing-delay-1 lg:justify-end" aria-label="Turtle call preview">
          <div className="absolute left-[4%] top-[5%] h-[82%] w-[82%] rounded-[48%_52%_46%_54%/58%_42%_58%_42%] bg-[#dbeafe]/70" />
          <div className="absolute right-[2%] top-[2%] h-24 w-24 rounded-full border border-[#bfdbfe]" />

          {/* Floating Yellow Badge Overlapping on the Left Side */}
          <div className="absolute bottom-[4%] left-0 sm:left-[-4%] rounded-2xl bg-[#fef08a] border border-[#facc15] px-5 py-4 shadow-[0_14px_30px_rgba(202,138,4,0.18)] z-20 transition hover:-translate-y-0.5">
            <p className="m-0 text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#b45309]">Caregiver first</p>
            <p className="mt-1 m-0 text-sm font-bold text-[#713f12]">“How are you doing today?”</p>
          </div>

          <div className="relative z-10 w-[88%] max-w-[470px] overflow-hidden rounded-[32px] border border-blue-900/50 bg-[#0b192c] p-5 text-white shadow-[0_40px_90px_rgba(11,25,44,0.45)] sm:p-7">
            <div className="flex items-center justify-between">
              <span className="rounded-full border border-blue-400/30 bg-blue-500/10 px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-[0.16em] text-blue-300">Voice companion</span>
              <span className="flex items-center gap-1.5 text-xs font-semibold text-blue-200"><Volume2 className="h-3.5 w-3.5 animate-pulse text-[#fbbf24]" /> Turtle is speaking</span>
            </div>

            {/* Seamless White Fluid Orb with No Outer Stroke */}
            <div className="relative left-1/2 my-6 h-48 w-48 -translate-x-1/2 overflow-hidden rounded-full bg-[#0b192c] shadow-[0_0_60px_rgba(255,255,255,0.22)] sm:h-56 sm:w-56" aria-hidden="true">
              <Orb
                agentState="talking"
                colors={['#ffffff', '#ffffff']}
                inverted={true}
                bgColor="#0b192c"
                seed={11}
                className="absolute inset-0 h-full w-full"
              />
            </div>

            <p className="mx-auto max-w-xs text-center text-xl font-bold leading-7 text-white">
              “Before we talk about the appointment—how are <span className="text-[#fbbf24]">you</span> holding up?”
            </p>
            <div className="mt-8 flex items-center justify-center gap-1.5" aria-hidden="true">
              {[8, 16, 25, 12, 30, 20, 10, 22, 14, 7].map((height, index) => (
                <span key={index} className="w-1.5 rounded-full bg-[#fbbf24]" style={{ height }} />
              ))}
            </div>
            <div className="mt-6 flex justify-center">
              <span className="grid h-14 w-14 place-items-center rounded-full bg-[#1d4ed8] text-white shadow-lg shadow-blue-600/30"><Mic2 className="h-5 w-5 text-[#fbbf24]" /></span>
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-blue-900/30 bg-[#0b192c] text-white">
        <div className="mx-auto grid max-w-[1180px] divide-y divide-blue-800/40 px-5 sm:grid-cols-3 sm:divide-x sm:divide-y-0 sm:px-8 lg:px-10">
          <ProofPoint value="24/7" label="A calm place to start" />
          <ProofPoint value="Caregiver-first" label="Your wellbeing matters, too" />
          <ProofPoint value="Whole journey" label="Treatment through bereavement" />
        </div>
      </section>

      <section id="how-it-helps" className="mx-auto max-w-[1180px] px-5 py-24 sm:px-8 lg:px-10 lg:py-32">
        <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
          <div>
            <p className="section-kicker">Care for the caregiver</p>
            <h2 className="mt-5 text-4xl font-extrabold leading-[1.05] tracking-[-0.03em] sm:text-5xl text-[#0b192c]">The person holding everything together needs support, too.</h2>
            <p className="mt-6 max-w-md text-base leading-7 text-[#475569]">
              Turtle begins where most healthcare tools stop: with the spouse, child, sibling, or friend doing the daily work of care.
            </p>
          </div>
          <div className="grid gap-px overflow-hidden rounded-[28px] border border-[#e2e8f0] bg-[#e2e8f0] sm:grid-cols-2">
            {SUPPORT_AREAS.map(({ icon: Icon, number, title, body }) => (
              <article key={number} className="group min-h-64 bg-white p-7 transition hover:bg-[#f8fafc] sm:p-8">
                <div className="flex items-center justify-between">
                  <span className="grid h-11 w-11 place-items-center rounded-xl bg-[#eff6ff] text-[#1d4ed8] transition group-hover:bg-[#fef08a] group-hover:text-[#b45309] shadow-xs"><Icon className="h-5 w-5" /></span>
                  <span className="text-xl font-extrabold text-[#94a3b8]">{number}</span>
                </div>
                <h3 className="mt-10 text-xl font-bold tracking-[-0.02em] text-[#0b192c]">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-[#64748b]">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="journey" className="relative bg-[#f0f7ff] px-5 py-24 sm:px-8 lg:py-32 border-y border-[#e2e8f0]">
        <div className="mx-auto max-w-[1180px]">
          <div className="max-w-3xl">
            <p className="section-kicker">One companion, every phase</p>
            <h2 className="mt-5 text-4xl font-extrabold leading-[1.05] tracking-[-0.03em] sm:text-5xl text-[#0b192c]">Care changes. Turtle changes with it.</h2>
          </div>
          <div className="mt-16 grid gap-4 lg:grid-cols-4">
            {CARE_PHASES.map(([title, body], index) => (
              <article key={title} className="relative flex min-h-64 flex-col rounded-[24px] border border-[#cbd5e1] bg-white p-6 shadow-sm hover:shadow-md transition-shadow">
                <span className="grid h-8 w-8 place-items-center rounded-xl bg-[#1d4ed8] text-xs font-bold text-white shadow-xs">{index + 1}</span>
                {index < CARE_PHASES.length - 1 ? <ChevronRight className="absolute -right-3 top-7 z-10 hidden h-5 w-5 text-[#94a3b8] lg:block" /> : null}
                <h3 className="mt-auto pt-12 text-xl font-bold text-[#0b192c]">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-[#64748b]">{body}</p>
              </article>
            ))}
          </div>
          <p className="mt-6 text-xs leading-5 text-[#64748b]">The current demo focuses on the active-treatment experience. Later-phase modules represent the product roadmap and require clinical and legal review before release.</p>
        </div>
      </section>

      <section id="safety" className="bg-white px-5 py-24 sm:px-8 lg:py-32">
        <div className="mx-auto grid max-w-[1180px] overflow-hidden rounded-[32px] bg-[#0b192c] text-white shadow-2xl border border-blue-950 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="relative min-h-[360px] overflow-hidden bg-gradient-to-br from-[#1d4ed8] to-[#1e3a8a] p-8 sm:p-12">
            <div className="absolute -bottom-32 -right-28 h-80 w-80 rounded-full border-[50px] border-[#fbbf24]/20" />
            <ShieldCheck className="relative h-12 w-12 text-[#fbbf24]" />
            <p className="section-kicker relative mt-20 !text-[#fef08a]">Safety by design</p>
            <h2 className="relative mt-4 max-w-md text-3xl sm:text-4xl font-extrabold leading-[1.08] tracking-[-0.03em] text-white">A companion, never a clinician or lawyer.</h2>
          </div>
          <div className="p-8 sm:p-12 lg:p-14">
            <p className="max-w-xl text-lg leading-8 text-blue-100">Turtle listens, explains, organizes, coaches, and connects. High-stakes decisions always stay with qualified people.</p>
            <ul className="mt-10 space-y-5">
              {[
                'No diagnosis, medication dosing, treatment, or prognosis advice',
                'No legal advice or interpretation of family documents',
                'Conservative escalation when symptoms or caregiver safety raise concern',
                'Clear AI disclosure and caregiver control over what is saved',
              ].map((item) => (
                <li key={item} className="flex gap-3 text-sm leading-6 text-blue-50 font-medium"><Check className="mt-0.5 h-5 w-5 shrink-0 text-[#fbbf24]" />{item}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="px-5 pb-24 pt-8 text-center sm:px-8 lg:pb-32">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#eff6ff] text-[#1d4ed8] shadow-xs">
          <TurtleLogo className="h-8 w-8 fill-current text-[#1d4ed8]" />
        </span>
        <h2 className="mx-auto mt-6 max-w-3xl text-4xl font-extrabold leading-[1.08] tracking-[-0.03em] sm:text-5xl text-[#0b192c]">Try the companion we’re building for caregivers.</h2>
        <p className="mx-auto mt-6 max-w-xl text-base leading-7 text-[#475569]">Talk naturally, prepare for a visit, log a care update, or ask Turtle to explain metastatic cancer in plain language.</p>
        <button type="button" onClick={() => setDemoOpen(true)} className="mt-8 inline-flex h-14 items-center gap-3 rounded-full bg-[#1d4ed8] px-8 text-base font-bold text-white shadow-[0_12px_32px_rgba(29,78,216,0.3)] transition hover:-translate-y-1 hover:bg-[#1e40af] cursor-pointer">
          Open the live demo <ArrowRight className="h-4 w-4 text-[#fbbf24]" />
        </button>
      </section>

      <footer className="border-t border-[#e2e8f0] bg-white px-5 py-8 sm:px-8">
        <div className="mx-auto flex max-w-[1180px] flex-col items-center justify-between gap-4 text-xs text-[#64748b] sm:flex-row">
          <a href="#top" className="inline-flex items-center gap-2 text-[#0b192c] no-underline" aria-label="Turtle home">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-[#1d4ed8] text-[#fbbf24]">
              <TurtleLogo className="h-4 w-4 fill-current" />
            </span>
            <span className="font-extrabold text-sm text-[#0b192c]">Turtle</span>
          </a>
          <span>Prototype for testing · Not medical or legal advice</span>
          <span>Made for the people who care</span>
        </div>
      </footer>

      {demoOpen ? <TurtleDemo onClose={() => setDemoOpen(false)} /> : null}
    </main>
  );
}

function ProofPoint({ value, label }: { value: string; label: string }) {
  return (
    <div className="px-4 py-8 text-center sm:py-10">
      <p className="m-0 text-3xl font-extrabold text-[#fbbf24]">{value}</p>
      <p className="mt-1.5 m-0 text-xs font-semibold uppercase tracking-[0.14em] text-blue-200">{label}</p>
    </div>
  );
}

function TurtleDemo({ onClose }: { onClose: () => void }) {
  const health = useHealth();
  const onboarding = useOnboarding();
  const [mode, setMode] = useState<Mode>('voice');
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [card, setCard] = useState<Card | null>(null);
  const [onboardingPrompt, setOnboardingPrompt] = useState<OnboardingPrompt | null>(null);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const seq = useRef(0);
  const interimIdRef = useRef<number | null>(null);

  const addLine = useCallback((line: Omit<TranscriptLine, 'id'>): number => {
    seq.current += 1;
    const id = seq.current;
    setLines((prev) => [...prev, { ...line, id }]);
    return id;
  }, []);

  const upsertInterim = useCallback((text: string) => {
    setLines((prev) => {
      const id = interimIdRef.current;
      if (id != null) return prev.map((line) => (line.id === id ? { ...line, text } : line));
      seq.current += 1;
      interimIdRef.current = seq.current;
      return [...prev, { id: seq.current, speaker: 'user', text, interim: true }];
    });
  }, []);

  const commitFinal = useCallback((text: string) => {
    setLines((prev) => {
      const id = interimIdRef.current;
      interimIdRef.current = null;
      if (id != null) return prev.map((line) => (line.id === id ? { ...line, text, interim: false } : line));
      seq.current += 1;
      return [...prev, { id: seq.current, speaker: 'user', text, interim: false }];
    });
  }, []);

  const session = useSession({
    onTranscriptInterim: upsertInterim,
    onTranscriptFinal: commitFinal,
    onContract: (contract) => {
      if (contract.say) addLine({ speaker: 'assistant', text: contract.say, interim: false });
    },
    onCard: setCard,
    onOnboardingPrompt: (prompt) => {
      setCard(null);
      setOnboardingPrompt(prompt);
      if (prompt.complete) void onboarding.refresh().finally(() => setOnboardingPrompt(null));
    },
    onError: (_code, message, degraded) => {
      if (degraded) addLine({ speaker: 'system', text: message, interim: false });
    },
  });

  const agentState = useMemo(() => toAgentState(session.assistantState, session.capturing), [session.assistantState, session.capturing]);
  const latestAssistantPrompt = useMemo(() => [...lines].reverse().find((line) => line.speaker === 'assistant')?.text ?? null, [lines]);

  const normalCard = card ? (
    <CardSurface
      card={card}
      className="!mt-0"
      onAction={(cardId, kind) => {
        session.sendCardAction(cardId, kind);
        setCard(null);
      }}
      onDismiss={(cardId) => {
        session.sendCardAction(cardId, 'acknowledge');
        setCard(null);
      }}
    />
  ) : null;

  const onboardingCard = onboardingPrompt && !onboardingPrompt.complete ? (
    <OnboardingCard
      prompt={onboardingPrompt}
      onAnswer={session.sendOnboardingAnswer}
      onConfirm={session.confirmOnboarding}
      onEdit={session.editOnboarding}
    />
  ) : null;

  const activeCardNode = onboardingCard ?? normalCard;

  const [displayedCard, setDisplayedCard] = useState<React.ReactNode | null>(null);
  const [isExiting, setIsExiting] = useState(false);
  const exitTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (activeCardNode) {
      if (exitTimeoutRef.current) {
        clearTimeout(exitTimeoutRef.current);
        exitTimeoutRef.current = null;
      }
      setDisplayedCard(activeCardNode);
      setIsExiting(false);
    } else if (displayedCard && !isExiting) {
      setIsExiting(true);
      exitTimeoutRef.current = setTimeout(() => {
        setDisplayedCard(null);
        setIsExiting(false);
      }, 300);
    }
  }, [activeCardNode, displayedCard, isExiting]);

  const hasSideCard = Boolean(displayedCard);

  return (
    <div
      className="fixed inset-0 z-50 bg-[#0b192c]/70 backdrop-blur-md flex items-center justify-center p-4 sm:p-6 overflow-x-hidden overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Try Turtle voice demo"
    >
      <button
        type="button"
        onClick={onClose}
        className="fixed right-4 top-4 z-[70] grid h-10 w-10 place-items-center rounded-full border border-[#cbd5e1] bg-white text-[#475569] shadow-md transition hover:bg-[#eff6ff] hover:text-[#1d4ed8] cursor-pointer"
        aria-label="Close demo"
      >
        <X className="h-4 w-4" />
      </button>

      {/* Animated Stage: Main Modal Shifts to the Left when Question Card Pops Up on the Right */}
      <div
        className={cn(
          'flex flex-col lg:flex-row items-center justify-center gap-6 w-full transition-all duration-500 ease-out',
          hasSideCard ? 'max-w-5xl' : 'max-w-xl',
        )}
      >
        {/* Main Turtle Modal Card (Contains Only Pure Blue Voice Orb in Voice Mode) */}
        <div
          className={cn(
            'flex h-[88vh] sm:h-[84vh] max-h-[820px] w-full flex-col overflow-hidden bg-white text-[#0b192c] rounded-[32px] border border-[#e2e8f0] shadow-[0_24px_80px_rgba(11,25,44,0.25)] px-4 py-3 sm:px-6 transition-all duration-500 ease-out',
            hasSideCard ? 'lg:w-[500px] shrink-0' : 'max-w-xl mx-auto',
          )}
          aria-label="Turtle"
        >
          <header className="flex shrink-0 items-center justify-between py-2 pr-12 border-b border-[#f1f5f9] mb-1">
            <div className="flex items-center gap-2.5">
              <span className="grid h-8 w-8 place-items-center rounded-xl bg-[#1d4ed8] text-[#fbbf24] shadow-xs">
                <TurtleLogo className="h-4.5 w-4.5 fill-current" />
              </span>
              <span className="text-xl font-extrabold tracking-tight text-[#0b192c]">Turtle</span>
              <span className="rounded-full border border-[#bfdbfe] bg-[#eff6ff] px-2.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#1d4ed8]">Live demo</span>
            </div>
            <div className="flex items-center gap-2">
              <Tabs items={[{ value: 'voice', label: 'Voice' }, { value: 'text', label: 'Text' }]} value={mode} onValueChange={(value) => setMode(value as Mode)} />
              <button
                onClick={() => setProfileModalOpen(true)}
                aria-label="Care profile and settings"
                title="Care profile and settings"
                className="flex h-8 w-8 items-center justify-center rounded-full border border-[#cbd5e1] bg-[#f8fafc] text-[#475569] transition hover:bg-[#eff6ff] hover:text-[#1d4ed8] cursor-pointer"
              >
                <User className="h-4 w-4" />
              </button>
            </div>
          </header>

          <div className="shrink-0"><DegradedBanner health={health} /></div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {mode === 'voice' ? (
              <VoiceView
                agentState={agentState}
                listening={session.capturing}
                micError={session.micError}
                onToggleCapture={session.toggleCapture}
                prompt={latestAssistantPrompt}
                hasSideCard={hasSideCard}
              />
            ) : (
              <TextView lines={lines} onSend={session.sendText} suggestions={CAREGIVER_STARTERS} />
            )}
          </div>
        </div>

        {/* Side Question Card (Outside the Modal, Animated on Right with Entrance & Exit Transitions) */}
        {displayedCard ? (
          <div
            className={cn(
              'w-full max-w-md shrink-0 transition-all duration-300',
              isExiting ? 'question-card-exit' : 'question-card-enter',
            )}
          >
            {displayedCard}
          </div>
        ) : null}
      </div>

      <Onboarding
        isOpen={profileModalOpen}
        required={false}
        onClose={() => setProfileModalOpen(false)}
        disclosure={onboarding.disclosure}
        existingPatient={onboarding.status?.patient}
        submitting={onboarding.submitting}
        error={onboarding.error}
        onSubmit={async (input) => {
          const saved = await onboarding.submit(input);
          if (saved) setOnboardingPrompt(null);
          return saved;
        }}
      />
    </div>
  );
}
