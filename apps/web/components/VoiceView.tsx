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
}

/**
 * Modern Voice Surface:
 * Atmospheric ambient radial glow framing the 3D Orb,
 * live glass status indicator with animated dot,
 * sleek waveform meter, and tactile glowing push-to-talk hero control.
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
    <div className="flex flex-1 flex-col items-center justify-between py-6 sm:py-8 select-none">
      {/* Status indicator pill */}
      <div className="flex items-center justify-center">
        <div
          className={cn(
            'flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-semibold tracking-wide transition-all duration-300 glass-pill shadow-sm',
            agentState === 'listening' && 'border-teal-500/40 bg-teal-950/40 text-teal-300 glow-primary',
            agentState === 'thinking' && 'border-amber-500/40 bg-amber-950/40 text-amber-300',
            agentState === 'talking' && 'border-cyan-500/40 bg-cyan-950/40 text-cyan-300',
            !agentState && 'text-slate-400',
          )}
          aria-live="polite"
        >
          {agentState === 'listening' && (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-teal-500" />
            </span>
          )}
          {agentState === 'thinking' && (
            <Sparkles className="h-3.5 w-3.5 animate-spin text-amber-400" />
          )}
          {agentState === 'talking' && (
            <Volume2 className="h-3.5 w-3.5 animate-pulse text-cyan-400" />
          )}
          {!agentState && (
            <span className="h-1.5 w-1.5 rounded-full bg-slate-500" />
          )}
          <span>{micError ?? hint}</span>
        </div>
      </div>

      {/* Ambient glowing 3D Orb canvas */}
      <div className="relative my-auto grid place-items-center">
        {/* Soft atmospheric radial bloom */}
        <div
          className={cn(
            'absolute h-64 w-64 rounded-full filter blur-3xl transition-all duration-700 sm:h-80 sm:w-80 pointer-events-none',
            agentState === 'listening'
              ? 'bg-gradient-to-tr from-teal-500/30 to-emerald-500/30 animate-ambient-breathe'
              : agentState === 'thinking'
                ? 'bg-gradient-to-tr from-amber-500/25 to-teal-500/25'
                : agentState === 'talking'
                  ? 'bg-gradient-to-tr from-cyan-500/35 to-teal-500/35 animate-ambient-breathe'
                  : 'bg-teal-500/15 opacity-50',
          )}
          aria-hidden="true"
        />

        {/* 3D Orb */}
        <div className="relative h-60 w-60 sm:h-72 sm:w-72" aria-hidden="true">
          <Orb agentState={agentState} colors={['#2dd4bf', '#38bdf8']} />
        </div>
      </div>

      {/* Bottom Controls: Waveform & Tactile Push-to-Talk Hero Button */}
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        {/* Live Audio Waveform */}
        <div className="h-10 w-full overflow-hidden rounded-xl glass-card px-3 py-1 flex items-center shadow-inner">
          <MicrophoneWaveform
            active={listening}
            height={32}
            barColor="#2dd4bf"
            onError={onError}
            className="w-full"
          />
        </div>

        {/* Tactile Push-to-Talk Button */}
        <div className="relative flex flex-col items-center">
          {/* Active ripple wave effect */}
          {listening && (
            <div className="absolute inset-0 -m-3 rounded-full bg-teal-500/20 animate-ripple pointer-events-none" />
          )}

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
              'group relative grid h-20 w-20 place-items-center rounded-full transition-all duration-300',
              'touch-none select-none disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer',
              'border border-white/15 backdrop-blur-md shadow-2xl',
              listening
                ? 'scale-110 bg-gradient-to-tr from-teal-400 to-emerald-400 text-slate-950 glow-primary border-teal-300'
                : 'bg-slate-900/80 text-teal-400 hover:scale-105 hover:border-teal-500/40 hover:bg-slate-800/90 active:scale-95 glow-primary',
            )}
          >
            <Mic
              className={cn(
                'h-8 w-8 transition-transform duration-200',
                listening ? 'scale-110 text-slate-950' : 'group-hover:scale-110 text-teal-400',
              )}
            />
          </button>

          <span className="mt-3 text-xs font-medium text-slate-400">
            {listening ? 'Release to finish' : 'Press & hold to speak'}
          </span>
        </div>
      </div>
    </div>
  );
}
