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
import { PrivacyControls } from '@/components/PrivacyControls';
import { useSession } from '@/lib/useSession';
import type { AgentState } from '@/components/ui/orb';

type Mode = 'voice' | 'text';

/** Map the server assistant state machine to the orb's visual agent state. */
function toAgentState(state: AssistantState, capturing: boolean): AgentState {
  if (capturing || state === 'LISTENING') return 'listening';
  if (state === 'THINKING') return 'thinking';
  if (state === 'SPEAKING' || state === 'CLOSING') return 'talking';
  return null;
}

/**
 * Turtle modern client shell.
 */
export default function Home() {
  const health = useHealth();
  const onboarding = useOnboarding();
  const [mode, setMode] = useState<Mode>('voice');
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [card, setCard] = useState<Card | null>(null);
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
      if (id != null) {
        return prev.map((l) => (l.id === id ? { ...l, text } : l));
      }
      seq.current += 1;
      interimIdRef.current = seq.current;
      return [...prev, { id: seq.current, speaker: 'user', text, interim: true }];
    });
  }, []);

  const commitFinal = useCallback((text: string) => {
    setLines((prev) => {
      const id = interimIdRef.current;
      interimIdRef.current = null;
      if (id != null) {
        return prev.map((l) => (l.id === id ? { ...l, text, interim: false } : l));
      }
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
      session.sendText(text);
    },
    [addLine, session],
  );

  useEffect(() => {
    addLine({
      speaker: 'assistant',
      text: 'Turtle is software — not a person. Press and hold to talk, or switch to Text.',
      interim: false,
    });
  }, [addLine]);

  if (!onboarding.complete) {
    if (onboarding.loading || onboarding.status === null) {
      return (
        <main
          className="mx-auto grid h-[100dvh] w-full max-w-2xl place-items-center px-5"
          aria-label="Turtle"
        >
          <div className="flex flex-col items-center gap-3 text-slate-400">
            <div className="h-9 w-9 rounded-full border-2 border-teal-500/30 border-t-teal-400 animate-spin" />
            <p className="text-sm font-medium" role="status">
              Connecting to Turtle…
            </p>
          </div>
        </main>
      );
    }
    return (
      <Onboarding
        disclosure={onboarding.disclosure}
        submitting={onboarding.submitting}
        error={onboarding.error}
        onSubmit={(input) => void onboarding.submit(input)}
      />
    );
  }

  return (
    <main
      className="mx-auto flex h-[100dvh] w-full max-w-2xl flex-col px-4 py-4 sm:px-6 overflow-hidden"
      aria-label="Turtle"
    >
      {/* Sleek Floating Glass Header */}
      <header className="flex items-center justify-between rounded-2xl glass-panel px-4 py-3 shadow-lg border border-white/10 shrink-0">
        <div className="flex items-center gap-2.5">
          <span
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-teal-500 to-emerald-500 text-slate-950 shadow-md glow-primary font-bold"
            aria-hidden="true"
          >
            <TurtleGlyph />
          </span>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-base font-bold tracking-tight text-slate-100">Turtle</span>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" title="Ready" />
            </div>
            <p className="text-[11px] text-slate-400 leading-none">Caregiver companion</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Tabs
            items={[
              { value: 'voice', label: 'Voice' },
              { value: 'text', label: 'Text' },
            ]}
            value={mode}
            onValueChange={(v) => setMode(v as Mode)}
          />
          <PrivacyControls />
        </div>
      </header>

      <div className="mt-3 shrink-0">
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
    </main>
  );
}

/** Bespoke Turtle logo mark */
function TurtleGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="text-slate-950">
      <path
        d="M12 4C7.5 4 4 7.5 4 12c0 2.5 1.2 4.8 3 6.2M12 4c4.5 0 8 3.5 8 8 0 2.5-1.2 4.8-3 6.2"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
      <path d="M7 19l-1 2M17 19l1 2M12 20v2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
