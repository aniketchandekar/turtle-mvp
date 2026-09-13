/**
 * Pure PCM conversion helpers shared by the capture and playback paths.
 *
 * These functions contain the only non-trivial audio math in the client and are kept
 * free of any browser API (AudioContext, AudioWorklet, MediaStream) so they can be
 * unit-tested in a plain Node environment. The wire format is fixed by the shared
 * contract: 16 kHz, mono, signed 16-bit little-endian PCM (see AUDIO_WIRE_FORMAT in
 * @turtle/shared).
 */

/** Target capture sample rate for the ASR wire format (Deepgram nova-3). */
export const TARGET_SAMPLE_RATE = 16000;

/** Clamp a float sample to the inclusive [-1, 1] range. */
function clampUnit(x: number): number {
  if (x > 1) return 1;
  if (x < -1) return -1;
  // Normalize NaN to silence rather than propagating it into the stream.
  return Number.isNaN(x) ? 0 : x;
}

/**
 * Downsample mono float32 audio from `inputRate` to `outputRate` using linear
 * interpolation. When the rates are equal (or the input is empty) the input is
 * returned unchanged. We never upsample beyond the source; capture rates (typically
 * 44.1/48 kHz) are always >= 16 kHz, but the function is symmetric and safe either way.
 */
export function resampleMonoFloat32(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (inputRate <= 0 || outputRate <= 0) {
    throw new Error('resampleMonoFloat32: sample rates must be positive');
  }
  if (inputRate === outputRate || input.length === 0) return input;

  const ratio = inputRate / outputRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    output[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return output;
}

/**
 * Convert mono float32 samples ([-1, 1]) to signed 16-bit little-endian PCM bytes.
 * Returns an ArrayBuffer suitable for sending as a binary WebSocket frame.
 */
export function float32ToPcm16(input: Float32Array): ArrayBuffer {
  const out = new DataView(new ArrayBuffer(input.length * 2));
  for (let i = 0; i < input.length; i++) {
    const s = clampUnit(input[i]);
    // Asymmetric scaling: negative range maps to -32768, positive to 32767.
    const v = s < 0 ? s * 0x8000 : s * 0x7fff;
    out.setInt16(i * 2, Math.round(v), true /* little-endian */);
  }
  return out.buffer;
}

/**
 * Convert signed 16-bit little-endian PCM bytes back to mono float32 samples ([-1, 1]).
 * Used by the playback path to feed incoming TTS audio into a Web Audio buffer.
 * A trailing odd byte (partial sample) is ignored rather than misread.
 */
export function pcm16ToFloat32(bytes: ArrayBuffer): Float32Array {
  const view = new DataView(bytes);
  const sampleCount = Math.floor(view.byteLength / 2);
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const v = view.getInt16(i * 2, true /* little-endian */);
    out[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
  }
  return out;
}

/**
 * Capture-path convenience: resample native-rate float32 frames to the 16 kHz wire
 * rate and encode to PCM16 bytes in one step.
 */
export function encodeCaptureChunk(input: Float32Array, inputRate: number): ArrayBuffer {
  const resampled = resampleMonoFloat32(input, inputRate, TARGET_SAMPLE_RATE);
  return float32ToPcm16(resampled);
}
