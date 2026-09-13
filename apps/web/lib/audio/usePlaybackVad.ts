'use client';

import { useCallback, useEffect, useRef } from 'react';
import { VoiceActivityDetector, type VadOptions } from './vad';

const WORKLET_URL = '/worklets/pcm-capture-processor.js';

export interface PlaybackVadCallbacks {
  /** Sustained speech was detected during playback — the caller should barge in. */
  onSpeech(): void;
}

export interface PlaybackVadControls {
  /**
   * Begin listening for a barge-in (call when the assistant enters SPEAKING). Opens
   * the mic and runs the VAD until speech is confirmed or {@link stop} is called.
   * A no-op if already listening. Rejections are swallowed — a mic that won't open
   * for barge-in must never crash playback; it only means the caregiver can't cut in
   * by voice this turn (they can still release-to-talk on the next turn).
   */
  start(): Promise<void>;
  /** Stop listening and release the mic (assistant finished, or a barge-in fired). */
  stop(): void;
  /** True while the barge-in listener is active. */
  isListening(): boolean;
}

/**
 * Barge-in listener: client-side VAD during playback (Task 12, R4.3/R4.4/R16.3).
 *
 * The push-to-talk path (`useAudioCapture`) streams the caregiver's turn to ASR. This
 * hook is the OTHER ear: it runs only while the assistant is SPEAKING and watches for
 * the caregiver starting to talk over the response. On sustained speech it fires
 * `onSpeech` exactly once, and the session sends `interrupt` + flushes local playback.
 *
 * It reuses the same lightweight PCM capture worklet, but instead of shipping audio
 * up the socket it feeds frames into a {@link VoiceActivityDetector} and reacts to the
 * boolean. Mic lifecycle mirrors `useAudioCapture`'s honest-indicator invariant: the
 * source is connected only between start() and stop(), and every track is stopped on
 * teardown so the OS mic indicator turns off the instant we stop listening.
 *
 * Detection is decoupled from playback: `onSpeech` fires as soon as voice is
 * confirmed (~60ms of sustained energy), which is well inside the 300ms halt budget.
 */
export function usePlaybackVad(
  callbacks: PlaybackVadCallbacks,
  options: VadOptions = {},
): PlaybackVadControls {
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;
  const optsRef = useRef(options);
  optsRef.current = options;

  const ctxRef = useRef<AudioContext | null>(null);
  const workletReadyRef = useRef<Promise<void> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const detectorRef = useRef<VoiceActivityDetector | null>(null);
  const listeningRef = useRef(false);

  const ensureContext = useCallback(async (): Promise<AudioContext> => {
    if (!ctxRef.current) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctxRef.current = new Ctor();
    }
    const ctx = ctxRef.current;
    if (ctx.state === 'suspended') await ctx.resume();
    if (!workletReadyRef.current) {
      workletReadyRef.current = ctx.audioWorklet.addModule(WORKLET_URL);
    }
    await workletReadyRef.current;
    return ctx;
  }, []);

  const stop = useCallback(() => {
    listeningRef.current = false;
    detectorRef.current = null;
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch {
        /* ignore */
      }
      sourceRef.current = null;
    }
    if (nodeRef.current) {
      try {
        nodeRef.current.port.onmessage = null;
        nodeRef.current.disconnect();
      } catch {
        /* ignore */
      }
      nodeRef.current = null;
    }
    // Stop the mic tracks so the OS "mic in use" indicator turns off promptly.
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
  }, []);

  const start = useCallback(async (): Promise<void> => {
    if (listeningRef.current) return;
    listeningRef.current = true;
    detectorRef.current = new VoiceActivityDetector(optsRef.current);
    try {
      const ctx = await ensureContext();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      // Stopped before the mic came up (assistant finished / barge-in already): bail.
      if (!listeningRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;

      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'pcm-capture-processor');

      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (!listeningRef.current) return;
        const detector = detectorRef.current;
        const frames = event.data;
        if (!detector || !frames || frames.length === 0) return;
        if (detector.accept(frames)) {
          // Confirmed barge-in. Stop listening first (releases the mic) so we fire
          // exactly once, then hand off to the session to interrupt.
          stop();
          cbRef.current.onSpeech();
        }
      };

      source.connect(node);
      // NOT connected to destination — this is a listener, it must never echo audio.
      sourceRef.current = source;
      nodeRef.current = node;
    } catch {
      // A mic that won't open for barge-in is a soft failure: keep playback going and
      // simply don't offer voice interruption this turn. Never surface an error or crash.
      stop();
    }
  }, [ensureContext, stop]);

  const isListening = useCallback(() => listeningRef.current, []);

  // Full teardown on unmount: stop listening and close the owned context.
  useEffect(() => {
    return () => {
      stop();
      if (ctxRef.current) {
        void ctxRef.current.close().catch(() => undefined);
        ctxRef.current = null;
      }
      workletReadyRef.current = null;
    };
  }, [stop]);

  return { start, stop, isListening };
}
