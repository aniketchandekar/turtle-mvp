import { describe, expect, it } from 'vitest';
import {
  TARGET_SAMPLE_RATE,
  encodeCaptureChunk,
  float32ToPcm16,
  pcm16ToFloat32,
  resampleMonoFloat32,
} from './pcm';

describe('float32ToPcm16 / pcm16ToFloat32', () => {
  it('encodes to signed 16-bit little-endian bytes', () => {
    const buf = float32ToPcm16(new Float32Array([0, 1, -1]));
    const view = new DataView(buf);
    expect(buf.byteLength).toBe(6); // 3 samples * 2 bytes
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(32767); // +1 → max positive
    expect(view.getInt16(4, true)).toBe(-32768); // -1 → min negative
  });

  it('clamps out-of-range and normalizes NaN to silence', () => {
    const buf = float32ToPcm16(new Float32Array([2, -2, NaN]));
    const view = new DataView(buf);
    expect(view.getInt16(0, true)).toBe(32767);
    expect(view.getInt16(2, true)).toBe(-32768);
    expect(view.getInt16(4, true)).toBe(0);
  });

  it('round-trips samples within one quantization step', () => {
    const input = new Float32Array([0, 0.5, -0.5, 0.25, -0.75, 1, -1]);
    const back = pcm16ToFloat32(float32ToPcm16(input));
    expect(back.length).toBe(input.length);
    for (let i = 0; i < input.length; i++) {
      expect(Math.abs(back[i] - input[i])).toBeLessThan(1 / 32767 + 1e-6);
    }
  });

  it('ignores a trailing partial (odd) byte when decoding', () => {
    // 5 bytes = 2 full samples + 1 dangling byte.
    const back = pcm16ToFloat32(new Uint8Array([0, 0, 0, 0, 7]).buffer);
    expect(back.length).toBe(2);
  });
});

describe('resampleMonoFloat32', () => {
  it('returns the input unchanged when rates match', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(resampleMonoFloat32(input, 16000, 16000)).toBe(input);
  });

  it('downsamples 48kHz → 16kHz to roughly one third the samples', () => {
    const input = new Float32Array(48000).fill(0.5);
    const out = resampleMonoFloat32(input, 48000, 16000);
    expect(out.length).toBe(16000);
    // A constant signal stays constant through linear interpolation.
    expect(out[0]).toBeCloseTo(0.5, 5);
    expect(out[out.length - 1]).toBeCloseTo(0.5, 5);
  });

  it('handles empty input', () => {
    const out = resampleMonoFloat32(new Float32Array(0), 48000, 16000);
    expect(out.length).toBe(0);
  });

  it('rejects non-positive sample rates', () => {
    expect(() => resampleMonoFloat32(new Float32Array([1]), 0, 16000)).toThrow();
    expect(() => resampleMonoFloat32(new Float32Array([1]), 48000, -1)).toThrow();
  });
});

describe('encodeCaptureChunk', () => {
  it('resamples to the 16kHz wire rate and encodes to PCM16 bytes', () => {
    const input = new Float32Array(4800).fill(0.25); // 100ms at 48kHz
    const bytes = encodeCaptureChunk(input, 48000);
    const expectedSamples = 1600; // 100ms at 16kHz
    expect(TARGET_SAMPLE_RATE).toBe(16000);
    expect(bytes.byteLength).toBe(expectedSamples * 2);
    const back = pcm16ToFloat32(bytes);
    expect(back[10]).toBeCloseTo(0.25, 3);
  });
});
