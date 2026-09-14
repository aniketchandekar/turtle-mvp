import { describe, it, expect } from 'vitest';
import { TTS_PRESET } from '@turtle/shared';
import { loadConfig, describeCapabilities, type EnvSource } from './config.js';

/**
 * Config + degradation layer (Task 3).
 * Covers R1.2 (boot degraded, never crash; surface disabled capabilities) and
 * R1.4 (read config from env with documented defaults).
 */

// An explicitly empty env source — simulates a fresh clone with ZERO keys set.
const EMPTY: EnvSource = {};

describe('loadConfig — zero env vars (R1.2)', () => {
  it('loads without throwing when no environment variables are set', () => {
    expect(() => loadConfig(EMPTY)).not.toThrow();
  });

  it('reports every provider as degraded (not live) with no keys present', () => {
    const cfg = loadConfig(EMPTY);
    expect(cfg.capabilities.asr.live).toBe(false);
    expect(cfg.capabilities.tts.live).toBe(false);
    expect(cfg.capabilities.llm.live).toBe(false);
    expect(cfg.capabilities.embeddings.live).toBe(false);
    expect(cfg.capabilities.webSearch.live).toBe(false);
  });

  it('surfaces a human-readable fallback for each degraded capability', () => {
    const cfg = loadConfig(EMPTY);
    for (const cap of Object.values(cfg.capabilities)) {
      expect(cap.fallback.length).toBeGreaterThan(0);
    }
    // describeCapabilities is the honest startup summary; every line renders.
    const lines = describeCapabilities(cfg);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.some((l) => /Encryption: using DEV key/.test(l))).toBe(true);
  });

  it('never fabricates placeholder secrets — missing keys are undefined', () => {
    const cfg = loadConfig(EMPTY);
    expect(cfg.deepgram.apiKey).toBeUndefined();
    expect(cfg.elevenlabs.apiKey).toBeUndefined();
    expect(cfg.llm.apiKey).toBeUndefined();
    expect(cfg.llm.provider).toBe('none');
    expect(cfg.embeddings.apiKey).toBeUndefined();
    expect(cfg.embeddings.provider).toBe('none');
    expect(cfg.elevenlabs.voiceId).toBeUndefined();
    expect(cfg.webSearch.apiKey).toBeUndefined();
  });
});

describe('loadConfig — providers live when keys present (R1.2)', () => {
  it('marks each capability live only when its key is present', () => {
    const cfg = loadConfig({
      DEEPGRAM_API_KEY: 'dg-key',
      ELEVENLABS_API_KEY: 'el-key',
      ELEVENLABS_VOICE_ID: 'voice-id',
      ANTHROPIC_API_KEY: 'an-key',
      OPENAI_API_KEY: 'oa-key',
    });
    expect(cfg.capabilities.asr.live).toBe(true);
    expect(cfg.capabilities.tts.live).toBe(true);
    expect(cfg.capabilities.llm.live).toBe(true);
    expect(cfg.capabilities.embeddings.live).toBe(true);
    expect(cfg.capabilities.webSearch.live).toBe(false);
  });

  it('marks capabilities independently (partial keys)', () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: 'an-key' });
    expect(cfg.capabilities.llm.live).toBe(true);
    expect(cfg.capabilities.asr.live).toBe(false);
    expect(cfg.capabilities.tts.live).toBe(false);
    expect(cfg.capabilities.embeddings.live).toBe(false);
  });

  it('requires both an ElevenLabs key and a voice ID for TTS', () => {
    expect(loadConfig({ ELEVENLABS_API_KEY: 'el-key' }).capabilities.tts.live).toBe(false);
    expect(loadConfig({ ELEVENLABS_API_KEY: 'el-key', ELEVENLABS_VOICE_ID: 'voice-id' }).capabilities.tts.live).toBe(
      true,
    );
  });
});

describe('loadConfig — LLM provider resolution', () => {
  it('defaults to none with no LLM keys', () => {
    expect(loadConfig(EMPTY).llm.provider).toBe('none');
  });

  it('auto-detects the provider from whichever key is present', () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: 'k' }).llm.provider).toBe('anthropic');
    expect(loadConfig({ OPENAI_API_KEY: 'k' }).llm.provider).toBe('openai');
    expect(loadConfig({ GEMINI_API_KEY: 'k' }).llm.provider).toBe('gemini');
  });

  it('prefers Gemini when multiple keys are present', () => {
    const cfg = loadConfig({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' });
    expect(cfg.llm.provider).toBe('gemini');
    expect(cfg.llm.model).toBe('gemini-2.5-flash');
  });

  it('honors an explicit LLM_PROVIDER when its key exists', () => {
    const cfg = loadConfig({ LLM_PROVIDER: 'anthropic', GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' });
    expect(cfg.llm.provider).toBe('anthropic');
  });

  it('ignores an explicit LLM_PROVIDER whose key is missing (falls back to detection)', () => {
    const cfg = loadConfig({ LLM_PROVIDER: 'openai', GEMINI_API_KEY: 'g' });
    expect(cfg.llm.provider).toBe('gemini');
  });

  it('reuses Gemini for embeddings, else OpenAI', () => {
    expect(loadConfig({ GEMINI_API_KEY: 'g' }).embeddings.provider).toBe('gemini');
    expect(loadConfig({ OPENAI_API_KEY: 'o' }).embeddings.provider).toBe('openai');
    expect(loadConfig({ ANTHROPIC_API_KEY: 'a' }).embeddings.provider).toBe('none');
  });

  it('treats blank / whitespace-only values as absent', () => {
    const cfg = loadConfig({ DEEPGRAM_API_KEY: '   ', ELEVENLABS_API_KEY: '' });
    expect(cfg.capabilities.asr.live).toBe(false);
    expect(cfg.capabilities.tts.live).toBe(false);
    expect(cfg.deepgram.apiKey).toBeUndefined();
  });
});

describe('loadConfig — documented defaults (R1.4)', () => {
  it('applies default model IDs when unset', () => {
    const cfg = loadConfig(EMPTY);
    expect(cfg.deepgram.model).toBe('nova-3');
    expect(cfg.elevenlabs.modelId).toBe('eleven_flash_v2_5');
    expect(cfg.elevenlabs.outputFormat).toBe('pcm_16000');
    expect(cfg.llm.gemini.model).toBe('gemini-2.5-flash');
    expect(cfg.llm.anthropic.model).toBe('claude-3-5-sonnet-latest');
    expect(cfg.embeddings.model).toBe('text-embedding-3-small');
    expect(cfg.webSearch.model).toBe('gemini-2.5-flash');
  });

  it('applies the frozen ElevenLabs voice settings and chunk schedule', () => {
    const cfg = loadConfig(EMPTY);
    expect(cfg.elevenlabs.voiceSettings).toEqual(TTS_PRESET.voice_settings);
    expect(cfg.elevenlabs.voiceSettings.stability).toBe(0.35);
    expect(cfg.elevenlabs.voiceSettings.similarity_boost).toBe(0.8);
    expect(cfg.elevenlabs.voiceSettings.use_speaker_boost).toBe(false);
    expect(cfg.elevenlabs.voiceSettings.speed).toBe(1.0);
    expect(cfg.elevenlabs.chunkLengthSchedule).toEqual([120, 160, 250, 290]);
  });

  it('applies default server port and dev encryption posture when unset', () => {
    const cfg = loadConfig(EMPTY);
    expect(cfg.port).toBe(8787);
    expect(cfg.encryptionKeyIsDev).toBe(true);
    expect(cfg.encryptionKey.length).toBeGreaterThan(0);
  });

  it('applies the default appointment prep window (48h) and honors an override', () => {
    expect(loadConfig(EMPTY).prepWindowHours).toBe(48);
    expect(loadConfig({ TURTLE_PREP_WINDOW_HOURS: '72' }).prepWindowHours).toBe(72);
  });

  it('reads values from env, overriding documented defaults', () => {
    const cfg = loadConfig({
      PORT: '9000',
      DEEPGRAM_MODEL: 'nova-custom',
      ELEVENLABS_VOICE_ID: 'voice-xyz',
      ANTHROPIC_MODEL: 'claude-custom',
      GEMINI_SEARCH_MODEL: 'gemini-search-custom',
      TURTLE_ENCRYPTION_KEY: 'real-secret',
    });
    expect(cfg.port).toBe(9000);
    expect(cfg.deepgram.model).toBe('nova-custom');
    expect(cfg.elevenlabs.voiceId).toBe('voice-xyz');
    expect(cfg.llm.anthropic.model).toBe('claude-custom');
    expect(cfg.webSearch.model).toBe('gemini-search-custom');
    expect(cfg.encryptionKey).toBe('real-secret');
    expect(cfg.encryptionKeyIsDev).toBe(false);
  });
});
