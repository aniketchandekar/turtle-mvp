'use client';

import { useCallback, useEffect, useRef } from 'react';
import { encodeCaptureChunk } from './pcm';
import { voiceDebug } from './voiceDebug';

const WORKLET_URL = '/worklets/pcm-capture-processor.js';

export interface AudioCaptureCallbacks {
  /** A chunk of 16 kHz mono signed-16 PCM ready to stream over the WebSocket. */
  onChunk(pcm: ArrayBuffer): void;
  /** Capture failed (permission denied, no device, worklet load failure). */
  onError(error: Error): void;
}

export interface AudioCaptureControls {
  /** Begin capturing (push-to-talk pressed). Resolves once the mic is live. */
  start(): Promise<void>;
  /** Stop capturing (push-to-talk released). Disconnects the mic — no tail recording. */
  stop(): void;
  /** True while the microphone is actively capturing. */
  isCapturing(): boolean;
}

/**
 * Microphone capture as 16 kHz mono PCM, gated strictly by push-to-talk (R3.1/R16.5).
 *
 * Pipeline: getUserMedia → MediaStreamSource → AudioWorklet (pcm-capture-processor)
 * → main thread resample+encode → onChunk. The AudioContext and worklet are set up
 * lazily on the first `start()` (needs a user gesture) and reused for the session.
 *
 * The honest-microphone / no-background-recording invariant is enforced structurally:
 *   - the MediaStreamSource is connected to the worklet ONLY between start() and stop();
 *   - on stop() the source is disconnected and every mic track is stopped, so the OS
 *     mic-in-use indicator turns off and nothing is buffered while idle;
 *   - the worklet holds no cross-turn buffer and emits nothing when disconnected.
 *
 * The AudioContext itself is kept open across turns to avoid per-turn setup latency,
 * but it carries no audio while the mic is disconnected.
 */
export function useAudioCapture(callbacks: AudioCaptureCallbacks): AudioCaptureControls {
  // Keep the latest callbacks without re-creating the controls on every render.
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const ctxRef = useRef<AudioContext | null>(null);
  const workletReadyRef = useRef<Promise<void> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const silentSinkRef = useRef<GainNode | null>(null);
  const capturingRef = useRef(false);
  const captureStartedAtRef = useRef<number | null>(null);
  const chunkCountRef = useRef(0);
  const byteCountRef = useRef(0);

  const ensureContext = useCallback(async (): Promise<AudioContext> => {
    if (!ctxRef.current) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctxRef.current = new Ctor();
      voiceDebug('audio_context_created', {
        sample_rate_hz: ctxRef.current.sampleRate,
        state: ctxRef.current.state,
      });
    }
    const ctx = ctxRef.current;
    if (ctx.state === 'suspended') {
      voiceDebug('audio_context_resume_requested');
      await ctx.resume();
      voiceDebug('audio_context_resumed', { state: ctx.state });
    }
    if (!workletReadyRef.current) {
      voiceDebug('capture_worklet_loading', { url: WORKLET_URL });
      workletReadyRef.current = ctx.audioWorklet.addModule(WORKLET_URL);
    }
    await workletReadyRef.current;
    voiceDebug('capture_worklet_ready');
    return ctx;
  }, []);

  const stop = useCallback(() => {
    const wasCapturing = capturingRef.current;
    capturingRef.current = false;
    // Disconnect the graph first so no further frames reach the worklet.
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
    if (silentSinkRef.current) {
      try {
        silentSinkRef.current.disconnect();
      } catch {
        /* ignore */
      }
      silentSinkRef.current = null;
    }
    // Stop the mic tracks so the OS "mic in use" indicator turns off (honest indicator).
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (wasCapturing) {
      const startedAt = captureStartedAtRef.current;
      voiceDebug('microphone_capture_stopped', {
        duration_ms: startedAt === null ? null : Math.round(performance.now() - startedAt),
        pcm_chunks: chunkCountRef.current,
        pcm_bytes: byteCountRef.current,
      });
    }
    captureStartedAtRef.current = null;
  }, []);

  const start = useCallback(async (): Promise<void> => {
    if (capturingRef.current) return;
    // Mark intent-to-capture up front. If stop() is called during the async
    // getUserMedia round-trip (push-to-talk released early), this flips back to false
    // and we abandon the just-acquired stream rather than leaving the mic live.
    capturingRef.current = true;
    captureStartedAtRef.current = performance.now();
    chunkCountRef.current = 0;
    byteCountRef.current = 0;
    voiceDebug('microphone_capture_start_requested');
    try {
      const ctx = await ensureContext();

      voiceDebug('microphone_permission_requested');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      const track = stream.getAudioTracks()[0];
      const settings = track?.getSettings();
      voiceDebug('microphone_stream_acquired', {
        audio_tracks: stream.getAudioTracks().length,
        sample_rate_hz: settings?.sampleRate,
        channel_count: settings?.channelCount,
      });

      // Released before the mic came up: do not go live; free the device immediately.
      if (!capturingRef.current) {
        for (const track of stream.getTracks()) track.stop();
        voiceDebug('microphone_stream_abandoned', { reason: 'capture_stopped_during_permission' }, 'warn');
        return;
      }
      streamRef.current = stream;

      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'pcm-capture-processor');
      const inputRate = ctx.sampleRate;

      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (!capturingRef.current) return; // drop any frame that races past stop()
        const frames = event.data;
        if (!frames || frames.length === 0) return;
        try {
          const pcm = encodeCaptureChunk(frames, inputRate);
          chunkCountRef.current += 1;
          byteCountRef.current += pcm.byteLength;
          if (chunkCountRef.current === 1) {
            voiceDebug('pcm_capture_started', {
              input_sample_rate_hz: inputRate,
              input_frames: frames.length,
              first_chunk_bytes: pcm.byteLength,
            });
          }
          cbRef.current.onChunk(pcm);
        } catch (err) {
          cbRef.current.onError(err instanceof Error ? err : new Error(String(err)));
        }
      };

      source.connect(node);
      // Keep the worklet in the browser's actively-rendered audio graph. Chromium may
      // cull a branch with no path to an output, which leaves the mic indicator and
      // waveform active but never calls process() — no PCM then reaches ASR. A zero-
      // gain sink makes the graph live while guaranteeing the microphone is inaudible.
      const silentSink = ctx.createGain();
      silentSink.gain.value = 0;
      node.connect(silentSink);
      silentSink.connect(ctx.destination);
      sourceRef.current = source;
      nodeRef.current = node;
      silentSinkRef.current = silentSink;
      voiceDebug('microphone_capture_graph_ready', {
        input_sample_rate_hz: inputRate,
        output_sample_rate_hz: 16_000,
      });
    } catch (err) {
      stop();
      const error = err instanceof Error ? err : new Error(String(err));
      voiceDebug('microphone_capture_failed', { error_name: error.name }, 'error');
      cbRef.current.onError(error);
      throw error;
    }
  }, [ensureContext, stop]);

  const isCapturing = useCallback(() => capturingRef.current, []);

  // Full teardown on unmount: stop capture and close the owned context.
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

  return { start, stop, isCapturing };
}
