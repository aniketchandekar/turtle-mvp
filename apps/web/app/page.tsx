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
 * Turtle client shell. Voice is the medium; the ElevenLabs orb + waveform are the voice
 * surface. A Voice / Text tab switch exposes a typed conversation for accessibility and
 * as the ASR-down fallback. Calm, composed, single-surface — no feed, no badges.
 *
 * The live voice pipeline is wired here: a single per-session WebSocket streams captured
 * 16 kHz PCM up while push-to-talk is held (turn_end on release) and plays TTS PCM back
 * with a small buffer. Transcript, state, and the single card surface are driven by the
 * server contract (never inferred client-side).
 */
export default function Home() {
  const health = useHealth();
  const [mode, setMode] = useState<Mode>('voice');
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [card, setCard] = useState<Card | null>(null);
  const seq = useRef(0);
  // The id of the current dimmed interim user line, so successive interims update in place.
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
      // The client renders `say` into the transcript immediately (contract-driven).
      // The card is delivered separately via onCard, gated behind the utterance.
      if (contract.say) addLine({ speaker: 'assistant', text: contract.say, interim: false });
    },
    onCard: (next) => {
      // Fired after the turn's spoken content finishes (R10.3/R16.2), or immediately
      // for a text-only turn. `null` clears the surface, keeping no-card sessions mic +
      // transcript only (R10.5) and enforcing at most one active card at a time.
      setCard(next);
    },
    onError: (_code, message, degraded) => {
      // Surface degradation / connection notices honestly in the transcript.
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

  return (
    <main
      className="mx-auto flex h-[100dvh] w-full max-w-2xl flex-col px-5 py-4 sm:px-6"
      aria-label="Turtle"
    >
      <header className="flex items-center justify-between pb-3">
        <div className="flex items-center gap-2.5">
          <span
            className="grid h-9 w-9 place-items-center rounded-full bg-card text-primary soft"
            aria-hidden="true"
          >
            <TurtleGlyph />
          </span>
          <span className="text-lg font-bold tracking-tight">Turtle</span>
        </div>
        <Tabs
          items={[
            { value: 'voice', label: 'Voice' },
            { value: 'text', label: 'Text' },
          ]}
          value={mode}
          onValueChange={(v) => setMode(v as Mode)}
        />
      </header>

      <DegradedBanner health={health} />

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

      <CardSurface
        card={card}
        onAction={(cardId, kind) => {
          // Voice parity (R16.8): the tap emits card_action; clear the surface locally.
          session.sendCardAction(cardId, kind);
          setCard(null);
        }}
        onDismiss={(cardId) => {
          session.sendCardAction(cardId, 'acknowledge');
          setCard(null);
        }}
      />
    </main>
  );
}

/** Minimal turtle mark — a calm rounded shell. No emoji (per design guidelines). */
function TurtleGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 6c-3.6 0-6.5 2.5-6.5 5.6 0 2.4 1.8 4 4 4.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M12 6c3.6 0 6.5 2.5 6.5 5.6 0 2.4-1.8 4-4 4.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path d="M9 18l-1 2M15 18l1 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="11" r="2.2" fill="currentColor" />
    </svg>
  );
}
