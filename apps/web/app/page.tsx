'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssistantState, Card } from '@turtle/shared';
import { VoiceView } from '@/components/VoiceView';
import { TextView } from '@/components/TextView';
import { Tabs } from '@/components/ui/tabs';
import { type TranscriptLine } from '@/components/Transcript';
import { CardSurface } from '@/components/CardSurface';
import { DegradedBanner } from '@/components/DegradedBanner';
import { useHealth } from '@/lib/useHealth';
import { useOnboarding } from '@/lib/useOnboarding';
import { Onboarding } from '@/components/Onboarding';
import { useSession } from '@/lib/useSession';
import type { AgentState } from '@/components/ui/orb';
import { User } from 'lucide-react';

type Mode = 'voice' | 'text';

/** Map the server assistant state machine to the orb's visual agent state. */
function toAgentState(state: AssistantState, capturing: boolean): AgentState {
  if (capturing || state === 'LISTENING') return 'listening';
  if (state === 'THINKING') return 'thinking';
  if (state === 'SPEAKING' || state === 'CLOSING') return 'talking';
  return null;
}

/**
 * Turtle client shell (ElevenLabs minimalist dark interface).
 */
export default function Home() {
  const health = useHealth();
  const onboarding = useOnboarding();
  const [mode, setMode] = useState<Mode>('voice');
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [card, setCard] = useState<Card | null>(null);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const seq = useRef(0);
  const interimIdRef = useRef<number | null>(null);
  const initializedGreeting = useRef(false);

  const addLine = useCallback((line: Omit<TranscriptLine, 'id'>): number => {
    seq.current += 1;
    const id = seq.current;
    setLines((prev) => [...prev, { ...line, id }]);
    return id;
  }, []);

  const upsertInterim = useCallback((text: string) => {
    setLines((prev) => {
      const id = interimIdRef.current;
      if (id != null) {
        return prev.map((l) => (l.id === id ? { ...l, text } : l));
      }
      seq.current += 1;
      interimIdRef.current = seq.current;
      return [...prev, { id: seq.current, speaker: 'user', text, interim: true }];
    });
  }, []);

  const commitFinal = useCallback(
    (text: string) => {
      setLines((prev) => {
        const id = interimIdRef.current;
        interimIdRef.current = null;
        if (id != null) {
          return prev.map((l) => (l.id === id ? { ...l, text, interim: false } : l));
        }
        seq.current += 1;
        return [...prev, { id: seq.current, speaker: 'user', text, interim: false }];
      });

      // Auto-extract and record consent in background on conversational speech
      if (!onboarding.complete) {
        void onboarding.autoExtractAndSave(text);
      }
    },
    [onboarding],
  );

  const session = useSession({
    onTranscriptInterim: upsertInterim,
    onTranscriptFinal: commitFinal,
    onContract: (contract) => {
      if (contract.say) addLine({ speaker: 'assistant', text: contract.say, interim: false });
    },
    onCard: (next) => {
      setCard(next);
    },
    onError: (_code, message, degraded) => {
      if (degraded) addLine({ speaker: 'system', text: message, interim: false });
    },
  });

  const agentState = useMemo(
    () => toAgentState(session.assistantState, session.capturing),
    [session.assistantState, session.capturing],
  );

  const onSendText = useCallback(
    (text: string) => {
      addLine({ speaker: 'user', text, interim: false });
      if (!onboarding.complete) {
        void onboarding.autoExtractAndSave(text);
      }
      session.sendText(text);
    },
    [addLine, onboarding, session],
  );

  // Initialize opening conversation line based on onboarding status
  useEffect(() => {
    if (initializedGreeting.current || onboarding.loading) return;
    initializedGreeting.current = true;

    if (onboarding.status?.needsOnboarding) {
      addLine({
        speaker: 'assistant',
        text: "Hi, I'm Turtle — an AI companion for caregivers. I help you track symptoms, organize doctor notes, and prepare for visits. Who are you caring for today?",
        interim: false,
      });
    } else {
      const patientName = onboarding.status?.patient?.name;
      addLine({
        speaker: 'assistant',
        text: patientName
          ? `Welcome back to Turtle. How is ${patientName} feeling today, or is there an update you'd like to log?`
          : 'Turtle is ready. Press and hold to talk, or switch to Text.',
        interim: false,
      });
    }
  }, [addLine, onboarding.loading, onboarding.status]);

  return (
    <main
      className="mx-auto flex h-[100dvh] w-full max-w-2xl flex-col px-4 py-3 sm:px-6 overflow-hidden bg-black text-white"
      aria-label="Turtle"
    >
      {/* Minimal ElevenLabs Header: Name on left, Icon-only Tabs + Profile Icon on right */}
      <header className="flex items-center justify-between py-2 shrink-0">
        <span className="text-lg font-semibold tracking-tight text-white">
          Turtle
        </span>

        <div className="flex items-center gap-2">
          {/* Icon-only Voice / Text tab switch */}
          <Tabs
            items={[
              { value: 'voice', label: 'Voice' },
              { value: 'text', label: 'Text' },
            ]}
            value={mode}
            onValueChange={(v) => setMode(v as Mode)}
          />

          {/* Profile Icon Button */}
          <button
            onClick={() => setProfileModalOpen(true)}
            aria-label="Care profile and settings"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-[#141416] border border-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <User className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Degraded mode indicator (only renders if system is degraded) */}
      <div className="shrink-0">
        <DegradedBanner health={health} />
      </div>

      {/* Main Viewport Container */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {mode === 'voice' ? (
          <VoiceView
            agentState={agentState}
            listening={session.capturing}
            micError={session.micError}
            onPressStart={session.pressStart}
            onPressEnd={session.pressEnd}
          />
        ) : (
          <TextView lines={lines} onSend={onSendText} />
        )}
      </div>

      {/* Floating Card Surface for actions/notes/emergency */}
      <div className="shrink-0">
        <CardSurface
          card={card}
          onAction={(cardId, kind) => {
            session.sendCardAction(cardId, kind);
            setCard(null);
          }}
          onDismiss={(cardId) => {
            session.sendCardAction(cardId, 'acknowledge');
            setCard(null);
          }}
        />
      </div>

      {/* Care Profile Modal */}
      <Onboarding
        isOpen={profileModalOpen}
        onClose={() => setProfileModalOpen(false)}
        disclosure={onboarding.disclosure}
        existingPatient={onboarding.status?.patient}
        submitting={onboarding.submitting}
        error={onboarding.error}
        onSubmit={onboarding.submit}
      />
    </main>
  );
}
