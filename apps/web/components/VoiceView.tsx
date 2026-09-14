'use client';

import { useCallback, useState } from 'react';
import { Orb, type AgentState } from '@/components/ui/orb';
import { MicrophoneWaveform } from '@/components/ui/waveform';
import { Mic, Sparkles, Volume2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  /** Maps the session state machine to the orb's agent state. */
  agentState: AgentState;
  listening: boolean;
  onPressStart: () => void;
  onPressEnd: () => void;
  /** Mic capture error from the session (honest indicator). Overrides the local waveform error. */
  micError?: string | null;
  disabled?: boolean;
  /** The latest gentle prompt, kept visible while the voice-first surface is open. */
  prompt?: string | null;
}

/**
 * ElevenLabs-inspired minimalist Voice Surface:
 * Clean 3D Orb floating on pitch black, minimal typography status indicator,
 * clean audio waveform visualizer, and tactile circular push-to-talk button.
 */
export function VoiceView({
  agentState,
  listening,
  onPressStart,
  onPressEnd,
  micError: sessionMicError,
  disabled,
  prompt,
}: Props) {
  const [waveformError, setWaveformError] = useState<string | null>(null);
  const micError = sessionMicError ?? waveformError;

  const hint =
    agentState === 'listening'
      ? 'Listening…'
      : agentState === 'thinking'
        ? 'Thinking…'
        : agentState === 'talking'
          ? 'Turtle is speaking'
          : 'Hold to talk';

  const onError = useCallback((e: Error) => {
    setWaveformError(
      e.name === 'NotAllowedError' ? 'Microphone access disabled in browser.' : 'Microphone unavailable.',
    );
  }, []);

  return (
    <div className="flex flex-1 flex-col items-center justify-between py-4 sm:py-6 select-none">
      {/* Clean Status Indicator */}
      <div className="flex items-center justify-center">
        <div
          className={cn(
            'flex items-center gap-2 rounded-full px-3.5 py-1 text-xs font-medium tracking-wide transition-all duration-200',
            agentState === 'listening' && 'bg-zinc-900 text-white border border-zinc-700',
            agentState === 'thinking' && 'bg-zinc-900 text-zinc-300 border border-zinc-700',
            agentState === 'talking' && 'bg-zinc-900 text-white border border-zinc-700',
            !agentState && 'text-zinc-500',
          )}
          aria-live="polite"
        >
          {agentState === 'listening' && (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
            </span>
          )}
          {agentState === 'thinking' && (
            <Sparkles className="h-3.5 w-3.5 animate-spin text-zinc-300" />
          )}
          {agentState === 'talking' && (
            <Volume2 className="h-3.5 w-3.5 animate-pulse text-white" />
          )}
          <span>{micError ?? hint}</span>
        </div>
      </div>

      {/* Floating 3D Orb Canvas on Pure Black */}
      <div className="relative my-auto grid place-items-center">
        <div className="relative h-64 w-64 sm:h-80 sm:w-80" aria-hidden="true">
          <Orb agentState={agentState} colors={['#CADCFC', '#A0B9D1']} />
        </div>
        {prompt ? (
          <p className="absolute -bottom-8 w-[min(22rem,calc(100vw-3rem))] text-center text-sm leading-relaxed text-zinc-300">
            {prompt}
          </p>
        ) : null}
      </div>

      {/* Bottom Controls: Waveform & Tactile Circular Push-to-Talk Button */}
      <div className="flex w-full max-w-xs flex-col items-center gap-5">
        {/* Clean Audio Waveform */}
        <div className="h-8 w-full overflow-hidden flex items-center justify-center opacity-80">
          <MicrophoneWaveform
            active={listening}
            height={28}
            barColor="#ffffff"
            onError={onError}
            className="w-full"
          />
        </div>

        {/* Tactile Push-to-Talk Circular Button */}
        <div className="flex flex-col items-center">
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
            className={cn(
              'grid h-16 w-16 place-items-center rounded-full transition-all duration-200',
              'touch-none select-none disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer',
              listening
                ? 'scale-110 bg-white text-black shadow-[0_0_24px_rgba(255,255,255,0.35)]'
                : 'bg-[#18181b] border border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-800 hover:border-zinc-500 active:scale-95 shadow-lg',
            )}
          >
            <Mic
              className={cn(
                'h-6 w-6 transition-transform duration-150',
                listening ? 'scale-110 text-black' : 'text-zinc-200',
              )}
            />
          </button>

          <span className="mt-2.5 text-xs text-zinc-500 font-medium tracking-tight">
            {listening ? 'Release to finish' : 'Press & hold to speak'}
          </span>
        </div>
      </div>
    </div>
  );
}
