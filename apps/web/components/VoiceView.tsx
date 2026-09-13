'use client';

import { useCallback, useState } from 'react';
import { Orb, type AgentState } from '@/components/ui/orb';
import { MicrophoneWaveform } from '@/components/ui/waveform';

interface Props {
  /** Maps the session state machine to the orb's agent state. */
  agentState: AgentState;
  listening: boolean;
  onPressStart: () => void;
  onPressEnd: () => void;
  /** Mic capture error from the session (honest indicator). Overrides the local waveform error. */
  micError?: string | null;
  disabled?: boolean;
}

/**
 * The voice surface: the ElevenLabs orb (audio-reactive, agent-state aware) resting in a
 * soft neumorphic halo, with a live microphone waveform and a push-to-talk control below.
 * Calm teal palette, generous breathing room.
 */
export function VoiceView({
  agentState,
  listening,
  onPressStart,
  onPressEnd,
  micError: sessionMicError,
  disabled,
}: Props) {
  const [waveformError, setWaveformError] = useState<string | null>(null);
  // The session's real capture error is authoritative; the waveform's own probe is a fallback.
  const micError = sessionMicError ?? waveformError;

  const hint =
    agentState === 'listening'
      ? 'Listening…'
      : agentState === 'thinking'
        ? 'One moment…'
        : agentState === 'talking'
          ? 'Turtle is speaking'
          : 'Press and hold to talk';

  const onError = useCallback((e: Error) => {
    setWaveformError(
      e.name === 'NotAllowedError' ? 'Microphone access is off.' : 'Microphone unavailable.',
    );
  }, []);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-10">
      {/* Orb resting in a soft recessed halo */}
      <div className="relative grid place-items-center">
        <div
          className="absolute h-64 w-64 rounded-full bg-card soft sm:h-80 sm:w-80"
          aria-hidden="true"
        />
        <div className="relative h-52 w-52 sm:h-64 sm:w-64" aria-hidden="true">
          <Orb agentState={agentState} colors={['#3FB0B0', '#7FD8D8']} />
        </div>
      </div>

      {/* Live mic waveform */}
      <div className="h-14 w-full max-w-sm px-4">
        <MicrophoneWaveform
          active={listening}
          height={56}
          barColor="var(--primary)"
          onError={onError}
          className="w-full"
        />
      </div>

      {/* Push-to-talk: soft raised button that presses inward while listening */}
      <div className="flex flex-col items-center gap-4 pb-4">
        <button
          type="button"
          disabled={disabled}
          aria-pressed={listening}
          aria-label={listening ? 'Listening. Release to send.' : 'Press and hold to talk'}
          onPointerDown={(e) => {
            e.preventDefault();
            onPressStart();
          }}
          onPointerUp={(e) => {
            e.preventDefault();
            onPressEnd();
          }}
          onPointerLeave={() => {
            if (listening) onPressEnd();
          }}
          onKeyDown={(e) => {
            if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
              e.preventDefault();
              onPressStart();
            }
          }}
          onKeyUp={(e) => {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              onPressEnd();
            }
          }}
          className={[
            'grid h-20 w-20 place-items-center rounded-full bg-card transition-all duration-200',
            'touch-none select-none disabled:opacity-50 disabled:cursor-not-allowed',
            listening ? 'soft-inset' : 'soft hover:scale-[1.03] active:scale-95',
          ].join(' ')}
        >
          <MicGlyph active={listening} />
        </button>
        <p className="m-0 min-h-6 text-base text-muted-foreground" aria-live="polite">
          {micError ?? hint}
        </p>
      </div>
    </div>
  );
}

function MicGlyph({ active }: { active: boolean }) {
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={active ? 'text-destructive' : 'text-primary'}
    >
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path
        d="M6 11a6 6 0 0 0 12 0M12 17v3.5M9 20.5h6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
