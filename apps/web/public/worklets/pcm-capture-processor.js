/**
 * PCM capture AudioWorklet processor.
 *
 * Runs on the audio rendering thread. Receives mono float32 audio frames from the
 * microphone at the AudioContext's native sample rate and forwards them to the main
 * thread as Float32Array batches. It does NOT resample or convert — that work happens
 * on the main thread (see lib/audio/pcm.ts) so it stays unit-testable and off the
 * realtime thread's hot path.
 *
 * Capture is gated entirely by the main thread: this processor only receives audio
 * while the upstream MediaStream node is connected (push-to-talk engaged). There is
 * no background buffering here — when disconnected, `process` simply stops running.
 * This upholds the no-background-recording invariant (R3.1 / R16.5).
 *
 * This file is plain JS (not TS/JSX) and is served statically from /public so it can
 * be loaded via `audioWorklet.addModule('/worklets/pcm-capture-processor.js')`.
 */

// Batch ~20ms of audio per message at 48kHz (960 frames) to keep messaging cheap
// while staying well under the ~150ms latency budget. The exact frame count is not
// critical; the main thread resamples to 16kHz regardless.
const FRAMES_PER_MESSAGE = 2048;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {Float32Array} */
    this._buffer = new Float32Array(FRAMES_PER_MESSAGE);
    this._offset = 0;
  }

  /**
   * @param {Float32Array[][]} inputs
   * @returns {boolean} keep processor alive
   */
  process(inputs) {
    const input = inputs[0];
    // No connected input (push-to-talk released / node disconnected): stay alive but
    // emit nothing. Never fabricate or hold audio.
    if (!input || input.length === 0) return true;

    const channel = input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this._buffer[this._offset++] = channel[i];
      if (this._offset === FRAMES_PER_MESSAGE) {
        // Transfer a copy so the underlying buffer can be reused immediately.
        const batch = this._buffer.slice(0, FRAMES_PER_MESSAGE);
        this.port.postMessage(batch, [batch.buffer]);
        this._offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
