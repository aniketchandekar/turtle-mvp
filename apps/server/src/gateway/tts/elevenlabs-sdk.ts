import { WebSocket } from 'ws';
import type { Config } from '../../config.js';
import type { TtsProvider } from '../index.js';
import {
  createElevenLabsTtsProvider,
  ELEVENLABS_EVENTS,
  type ElevenLabsConnectFactory,
  type ElevenLabsConnectOptions,
  type ElevenLabsConnection,
  type ElevenLabsHttpRenderFactory,
  type ElevenLabsHttpRenderOptions,
} from './elevenlabs.js';

/**
 * Network edge for the ElevenLabs TTS provider (Task 10).
 *
 * This is the ONLY module that opens a real ElevenLabs socket or makes an HTTP
 * request. It adapts the `ws` client and the HTTP streaming endpoint to the small
 * `ElevenLabsConnection` / render shapes the provider (and its tests) depend on,
 * then builds the provider with those factories. The API key is read from config
 * here and passed to the SDK edge only — it is NEVER exposed to the client
 * (R16 privacy posture: the Voice Gateway holds the key).
 *
 * `optimize_streaming_latency` is deprecated and intentionally never used.
 */

const ELEVENLABS_HOST = 'api.elevenlabs.io';

/** Build the stream-input WS URL for a fixed voice with model + output format. */
function streamInputUrl(opts: ElevenLabsConnectOptions): string {
  const params = new URLSearchParams({
    model_id: opts.modelId,
    output_format: opts.outputFormat,
  });
  if (opts.language) params.set('language_code', opts.language);
  return `wss://${ELEVENLABS_HOST}/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}/stream-input?${params.toString()}`;
}

/** Open a real ElevenLabs stream-input WS and adapt it to our connection shape. */
const wsConnectFactory: ElevenLabsConnectFactory = (opts: ElevenLabsConnectOptions): ElevenLabsConnection => {
  // The key travels in the header (never in the URL / never to the client).
  const socket = new WebSocket(streamInputUrl(opts), {
    headers: { 'xi-api-key': opts.apiKey },
  });

  return {
    on(event, listener) {
      // Map our stable event names onto the `ws` events so the provider stays
      // decoupled from the transport. Server frames arrive as JSON text messages
      // carrying base64 `audio`; parse them here at the edge.
      if (event === ELEVENLABS_EVENTS.message) {
        socket.on('message', (data: Buffer, isBinary: boolean) => {
          if (isBinary) return;
          try {
            listener(JSON.parse(data.toString('utf8')));
          } catch {
            /* ignore non-JSON frames */
          }
        });
        return;
      }
      const mapped =
        event === ELEVENLABS_EVENTS.open
          ? 'open'
          : event === ELEVENLABS_EVENTS.close
            ? 'close'
            : event === ELEVENLABS_EVENTS.error
              ? 'error'
              : event;
      socket.on(mapped, () => listener());
    },
    send(json) {
      socket.send(json);
    },
    close() {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    },
  };
};

/**
 * Render a static string over the ElevenLabs HTTP streaming endpoint, invoking
 * `onChunk` for each PCM chunk. Used to pre-render fixed phrases (AI disclosure,
 * greeting, crisis lines, recap) for sub-100ms availability.
 */
const httpRenderFactory: ElevenLabsHttpRenderFactory = async (
  opts: ElevenLabsHttpRenderOptions,
  onChunk: (chunk: Buffer) => void,
): Promise<void> => {
  const params = new URLSearchParams({ output_format: opts.outputFormat });
  const url = `https://${ELEVENLABS_HOST}/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}/stream?${params.toString()}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': opts.apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      text: opts.text,
      model_id: opts.modelId,
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`ElevenLabs HTTP render failed: ${res.status}`);
  }

  // Stream the PCM body chunk-by-chunk.
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) onChunk(Buffer.from(value));
  }
};

/**
 * Build the ElevenLabs-backed TTS provider using the real transport. Returns a
 * provider whose `live` flag mirrors config (key + fixed voice id present); when
 * either is missing it degrades to text-only.
 */
export function createElevenLabsProvider(cfg: Config): TtsProvider {
  return createElevenLabsTtsProvider(cfg, wsConnectFactory, httpRenderFactory);
}
