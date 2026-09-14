import express from 'express';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { loadConfig, describeCapabilities } from './config.js';
import { createStore } from './store/index.js';
import { createRoutes } from './http/routes.js';
import { cors } from './http/cors.js';
import { createGateway } from './gateway/index.js';
import { createDeepgramProvider } from './gateway/asr/deepgram-sdk.js';
import { createElevenLabsProvider } from './gateway/tts/elevenlabs-sdk.js';
import { createE2eProcessor } from './orchestrator/index.js';
import { createGeminiChatStream } from './services/llm/gemini.js';
import { createLlmProvider } from './services/llm/index.js';
import { createMemoryService } from './services/memory/index.js';
import { createRagService } from './services/rag/index.js';
import { createEmbeddingProviderFromConfig } from './services/rag/embeddings-sdk.js';

/**
 * Turtle backend entrypoint. Single Node service combining the Voice Gateway (WS) and
 * the Orchestrator (HTTP + turn processing). Task 7 wires the real session channel:
 * one WebSocket per session, kept open for the whole session, routing the realtime
 * protocol and persisting session lifecycle. ASR/TTS/orchestrator integration lands
 * in later Phase 1/2 tasks behind the gateway's provider seams.
 */
function main(): void {
  const cfg = loadConfig();
  const store = createStore(cfg.dbPath, cfg.encryptionKey);

  const app = express();
  app.use(cors);
  app.use(express.json());
  app.use('/', createRoutes(cfg, store));

  const server = http.createServer(app);

  // Session channel (Task 7). One connection per session, kept open for the session.
  // Streaming ASR (Deepgram, Task 9) and streaming TTS (ElevenLabs, Task 10) are
  // attached here. ASR degrades to text-in when no Deepgram key is present; TTS
  // degrades to text-only when no ElevenLabs key (or fixed voice id) is present.
  // The orchestrator lands in later tasks; the channel still runs honestly (canned
  // responses) with zero API keys.
  const wss = new WebSocketServer({ server, path: '/ws' });
  const asr = createDeepgramProvider(cfg);
  const tts = createElevenLabsProvider(cfg);
  // The orchestrator remains safe with zero keys, but a configured Gemini key now
  // powers normal check-ins and structured log extraction through the same validated
  // contract path as every other turn. Other provider selections still degrade to the
  // canned provider until their concrete adapters are added.
  const llm = createLlmProvider(cfg, cfg.llm.provider === 'gemini' ? createGeminiChatStream : undefined);
  // The local demo uses the real profile, memory, and diagnosis-scoped knowledge base
  // rather than the old zero-dependency test stub. It still keeps the same safety and
  // contract gates as every other path.
  const memory = createMemoryService({ repos: store.repos });
  const rag = createRagService({ repos: store.repos, embeddings: createEmbeddingProviderFromConfig(cfg) });
  const processor = createE2eProcessor({ llm, store, memory, rag, prepWindowHours: cfg.prepWindowHours });
  createGateway({ cfg, store, asr, tts, processor }).attach(wss);

  server.listen(cfg.port, () => {
    console.log(`\nTurtle server listening on http://localhost:${cfg.port}`);
    console.log('Capabilities:');
    for (const line of describeCapabilities(cfg)) console.log(line);
    console.log(`\nHealth: http://localhost:${cfg.port}/health`);
    console.log(`WebSocket: ws://localhost:${cfg.port}/ws\n`);
  });
}

main();
