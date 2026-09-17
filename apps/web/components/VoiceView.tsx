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
  onToggleCapture: () => void;
  /** Mic capture error from the session (honest indicator). Overrides the local waveform error. */
  micError?: string | null;
  disabled?: boolean;
  /** The latest gentle prompt, kept visible while the voice-first surface is open. */
  prompt?: string | null;
  /** Most recent interim or final user transcript, shown as immediate speech feedback. */
  heardText?: string | null;
  /** Whether a question or action card is currently visible beside the main modal. */
  hasSideCard?: boolean;
}

/**
 * Voice Surface with pure blue 3D Orb, status indicator, waveform, and mic button.
 */
export function VoiceView({
  agentState,
  listening,
  onToggleCapture,
  micError: sessionMicError,
  disabled,
  prompt,
  heardText,
  hasSideCard = false,
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
    <div className="flex flex-1 flex-col items-center justify-between py-2 sm:py-3 select-none overflow-hidden h-full">
      {/* Clean Status Indicator */}
      <div className="flex shrink-0 items-center justify-center pt-1">
        <div
          className={cn(
            'flex items-center gap-2 rounded-full px-3.5 py-1 text-[11px] font-bold tracking-wide transition-all duration-200',
            agentState === 'listening' && 'bg-[#eff6ff] text-[#1d4ed8] border border-[#bfdbfe] shadow-xs',
            agentState === 'thinking' && 'bg-[#eff6ff] text-[#1d4ed8] border border-[#bfdbfe]',
            agentState === 'talking' && 'bg-[#fef9c3] text-[#854d0e] border border-[#fef08a] shadow-xs',
            !agentState && 'text-[#64748b] bg-[#f8fafc] border border-[#e2e8f0]',
          )}
          aria-live="polite"
        >
          {agentState === 'listening' && (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#f59e0b] opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[#f59e0b]" />
            </span>
          )}
          {agentState === 'thinking' && (
            <Sparkles className="h-3 w-3 animate-spin text-[#1d4ed8]" />
          )}
          {agentState === 'talking' && (
            <Volume2 className="h-3 w-3 animate-pulse text-[#b45309]" />
          )}
          <span>{micError ?? hint}</span>
        </div>
      </div>

      {/* Central Interactive Area: Pure Blue Voice Orb Perfectly Centered */}
      <div className="flex flex-1 flex-col items-center justify-center w-full min-h-0 py-2 sm:py-4 overflow-hidden">
        {/* 3D Orb Canvas in Pure Shades of Blue */}
        <div
          className="relative shrink-0 grid place-items-center h-56 w-56 sm:h-64 sm:w-64 md:h-72 md:w-72 transition-all duration-300"
          aria-hidden="true"
        >
          <Orb agentState={agentState} colors={['#1d4ed8', '#60a5fa']} />
        </div>

        {!hasSideCard && prompt ? (
          <p className="mt-2 max-w-sm text-center text-xs font-semibold leading-relaxed text-[#475569] px-4 line-clamp-2">
            “{prompt}”
          </p>
        ) : null}

        {heardText ? (
          <div
            className="mt-2 max-w-sm rounded-2xl rounded-tr-sm bg-[#1d4ed8] px-4 py-2 text-center text-xs font-semibold leading-relaxed text-white shadow-sm"
            aria-live="polite"
            aria-label={`You said: ${heardText}`}
          >
            <span className="mr-1.5 text-[10px] font-extrabold uppercase tracking-wider text-blue-200">You</span>
            {heardText}
          </div>
        ) : null}
      </div>

      {/* Bottom Controls: Waveform & Tactile Circular Push-to-Talk Button (Always fully visible) */}
      <div className="flex shrink-0 w-full max-w-xs flex-col items-center gap-2.5 pb-2">
        {/* Clean Audio Waveform */}
        <div className="h-6 w-full overflow-hidden flex items-center justify-center opacity-90">
          <MicrophoneWaveform
            active={listening}
            height={24}
            barColor={listening ? '#f59e0b' : '#2563eb'}
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
            aria-label={listening ? 'Listening. Tap to stop and send.' : 'Tap to start listening'}
            onClick={onToggleCapture}
            className={cn(
              'grid h-14 w-14 sm:h-16 sm:w-16 place-items-center rounded-full transition-all duration-200',
              'touch-none select-none disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer',
              listening
                ? 'scale-105 bg-[#f59e0b] text-[#0b192c] shadow-[0_0_28px_rgba(245,158,11,0.55)] ring-4 ring-blue-500/40'
                : 'bg-[#1d4ed8] border border-[#1d4ed8] text-white hover:bg-[#1e40af] active:scale-95 shadow-[0_8px_20px_rgba(29,78,216,0.28)]',
            )}
          >
            <Mic
              className={cn(
                'h-5 w-5 sm:h-6 sm:w-6 transition-transform duration-150',
                listening ? 'scale-110 text-[#0b192c]' : 'text-white',
              )}
            />
          </button>

          <span className="mt-1.5 text-[11px] text-[#64748b] font-semibold tracking-tight">
            {listening ? 'Tap to stop & send' : 'Tap to speak'}
          </span>
        </div>
      </div>
    </div>
  );
}
