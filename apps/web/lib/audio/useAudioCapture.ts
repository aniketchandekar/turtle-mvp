'use client';

import { useCallback, useEffect, useRef } from 'react';
import { encodeCaptureChunk } from './pcm';

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
  const capturingRef = useRef(false);

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
    // Stop the mic tracks so the OS "mic in use" indicator turns off (honest indicator).
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
  }, []);

  const start = useCallback(async (): Promise<void> => {
    if (capturingRef.current) return;
    // Mark intent-to-capture up front. If stop() is called during the async
    // getUserMedia round-trip (push-to-talk released early), this flips back to false
    // and we abandon the just-acquired stream rather than leaving the mic live.
    capturingRef.current = true;
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

      // Released before the mic came up: do not go live; free the device immediately.
      if (!capturingRef.current) {
        for (const track of stream.getTracks()) track.stop();
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
          cbRef.current.onChunk(encodeCaptureChunk(frames, inputRate));
        } catch (err) {
          cbRef.current.onError(err instanceof Error ? err : new Error(String(err)));
        }
      };

      source.connect(node);
      // Intentionally NOT connected to ctx.destination — capture must not echo to
      // the speakers. The worklet returns no output; it only messages the main thread.
      sourceRef.current = source;
      nodeRef.current = node;
    } catch (err) {
      stop();
      const error = err instanceof Error ? err : new Error(String(err));
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
