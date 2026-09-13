import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SPEECH_FRAMES,
  DEFAULT_SPEECH_RMS_THRESHOLD,
  VoiceActivityDetector,
  frameRms,
} from './vad';

/**
 * Client-side barge-in VAD (Task 12, R4.3/R4.4).
 *
 * The detection math is pure (no browser APIs), so it is exercised directly here:
 * RMS energy computation, the consecutive-frame debounce that rejects transients,
 * and the single-shot latch behavior the playback listener relies on.
 */

/** A frame of constant amplitude — RMS equals |amp|. */
function tone(amp: number, len = 512): Float32Array {
  return new Float32Array(len).fill(amp);
}

/** A silent (all-zero) frame. */
function silence(len = 512): Float32Array {
  return new Float32Array(len);
}

describe('frameRms', () => {
  it('is zero for silence and for an empty frame', () => {
    expect(frameRms(silence())).toBe(0);
    expect(frameRms(new Float32Array(0))).toBe(0);
  });

  it('equals the constant amplitude for a DC frame', () => {
    expect(frameRms(tone(0.5))).toBeCloseTo(0.5, 6);
    expect(frameRms(tone(-0.5))).toBeCloseTo(0.5, 6);
  });
});

describe('VoiceActivityDetector — sustained speech fires the barge-in', () => {
  it('fires only after the required consecutive voiced frames', () => {
    const vad = new VoiceActivityDetector({ threshold: 0.06, speechFrames: 3 });
    const loud = tone(0.2); // well above threshold
    expect(vad.accept(loud)).toBe(false); // 1
    expect(vad.accept(loud)).toBe(false); // 2
    expect(vad.accept(loud)).toBe(true); // 3 → confirmed
    expect(vad.triggered).toBe(true);
  });

  it('stays latched true after firing until reset', () => {
    const vad = new VoiceActivityDetector({ speechFrames: 2 });
    const loud = tone(0.3);
    vad.accept(loud);
    expect(vad.accept(loud)).toBe(true);
    // Even a silent frame after firing keeps it latched (single-shot per activation).
    expect(vad.accept(silence())).toBe(true);
    vad.reset();
    expect(vad.triggered).toBe(false);
    expect(vad.accept(silence())).toBe(false);
  });
});

describe('VoiceActivityDetector — rejects transients and silence', () => {
  it('does not fire on a lone loud frame surrounded by silence (click/pop)', () => {
    const vad = new VoiceActivityDetector({ threshold: 0.06, speechFrames: 3 });
    expect(vad.accept(silence())).toBe(false);
    expect(vad.accept(tone(0.5))).toBe(false); // single spike
    expect(vad.accept(silence())).toBe(false); // run broken
    expect(vad.accept(tone(0.5))).toBe(false); // starts over
    expect(vad.triggered).toBe(false);
  });

  it('does not fire on quiet frames below the threshold (bleed/room tone)', () => {
    const vad = new VoiceActivityDetector({ threshold: 0.06, speechFrames: 3 });
    const quiet = tone(0.03); // below threshold
    for (let i = 0; i < 10; i++) expect(vad.accept(quiet)).toBe(false);
    expect(vad.triggered).toBe(false);
  });

  it('resets the run when a sub-threshold frame interrupts voiced frames', () => {
    const vad = new VoiceActivityDetector({ threshold: 0.06, speechFrames: 3 });
    const loud = tone(0.2);
    vad.accept(loud); // 1
    vad.accept(loud); // 2
    expect(vad.accept(silence())).toBe(false); // run reset to 0
    vad.accept(loud); // 1 again
    expect(vad.accept(loud)).toBe(false); // 2
    expect(vad.accept(loud)).toBe(true); // 3 → confirmed
  });
});

describe('VoiceActivityDetector — defaults', () => {
  it('uses the documented default threshold and frame count', () => {
    const vad = new VoiceActivityDetector();
    const justAbove = tone(DEFAULT_SPEECH_RMS_THRESHOLD + 0.01);
    let fired = false;
    for (let i = 0; i < DEFAULT_SPEECH_FRAMES; i++) fired = vad.accept(justAbove);
    expect(fired).toBe(true);
  });

  it('treats a frame exactly at the threshold as voiced', () => {
    const vad = new VoiceActivityDetector({ threshold: 0.1, speechFrames: 1 });
    expect(vad.accept(tone(0.1))).toBe(true);
  });
});
