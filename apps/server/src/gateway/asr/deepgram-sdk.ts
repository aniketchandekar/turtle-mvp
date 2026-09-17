import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import type { Config } from '../../config.js';
import type { AsrProvider } from '../index.js';
import {
  createDeepgramAsrProvider,
  type DeepgramConnectFactory,
  type DeepgramConnectOptions,
  type DeepgramLiveConnection,
} from './deepgram.js';

/**
 * SDK edge for the Deepgram ASR provider (Task 9).
 *
 * This is the ONLY module that imports `@deepgram/sdk`. It adapts the real live
 * transcription client to the small `DeepgramLiveConnection` shape the provider
 * (and its tests) depend on, then builds the provider with that factory. The API
 * key is read from config here and never leaves the gateway (R16 privacy posture).
 */

/** Open a real Deepgram live connection and adapt it to our connection shape. */
const sdkConnectFactory: DeepgramConnectFactory = (opts: DeepgramConnectOptions): DeepgramLiveConnection => {
  const client = createClient(opts.apiKey);
  // nova-3 streaming with interim results and Deepgram's built-in VAD endpointing.
  const connection = client.listen.live({
    model: opts.model,
    encoding: opts.encoding,
    sample_rate: opts.sampleRate,
    channels: opts.channels,
    interim_results: opts.interimResults,
    // VAD-based utterance endpointing so finals commit at natural speech boundaries.
    vad_events: true,
    endpointing: 300,
    punctuate: true,
    smart_format: true,
    language: opts.language,
  });

  return {
    on(event, listener) {
      // Map our stable event names onto the SDK's enum so the provider stays
      // decoupled from SDK symbol churn.
      const mapped =
        event === 'open'
          ? LiveTranscriptionEvents.Open
          : event === 'close'
            ? LiveTranscriptionEvents.Close
            : event === 'error'
              ? LiveTranscriptionEvents.Error
              : event === 'Results'
                ? LiveTranscriptionEvents.Transcript
                : event;
      connection.on(mapped, listener as (...args: unknown[]) => void);
    },
    send(data) {
      // Deepgram's live client accepts an ArrayBuffer-like payload. Hand it a
      // tightly-sliced ArrayBuffer view of the Node Buffer (no copy of unrelated
      // pool bytes) so PCM frames go out exactly as captured.
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      connection.send(ab);
    },
    finalize() {
      // v3+ exposes finalize(); guarded in case of client differences.
      (connection as unknown as { finalize?: () => void }).finalize?.();
    },
    keepAlive() {
      (connection as unknown as { keepAlive?: () => void }).keepAlive?.();
    },
    requestClose() {
      (connection as unknown as { requestClose?: () => void }).requestClose?.();
    },
    finish() {
      (connection as unknown as { finish?: () => void }).finish?.();
    },
  };
};

/**
 * Build the Deepgram-backed ASR provider using the real SDK. Returns a provider
 * whose `live` flag mirrors config; when no key is present it degrades to text-in.
 */
export function createDeepgramProvider(cfg: Config): AsrProvider {
  return createDeepgramAsrProvider(cfg, sdkConnectFactory);
}
