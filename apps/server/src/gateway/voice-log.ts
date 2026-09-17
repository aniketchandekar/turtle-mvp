/**
 * Privacy-safe structured diagnostics for the realtime voice pipeline.
 *
 * Enabled by default outside tests. Set TURTLE_VOICE_DEBUG=0 to silence it, or =1
 * to force it on. Never pass transcript text, audio bytes, credentials, or patient
 * names in `fields`; log only lifecycle metadata, counts, states, and timings.
 */
export type VoiceLogFields = Record<string, string | number | boolean | null | undefined>;

function enabled(): boolean {
  const configured = process.env.TURTLE_VOICE_DEBUG;
  if (configured === '0') return false;
  if (configured === '1') return true;
  return process.env.NODE_ENV !== 'test';
}

export function voiceLog(
  event: string,
  fields: VoiceLogFields = {},
  level: 'info' | 'warn' | 'error' = 'info',
): void {
  if (!enabled()) return;
  const record = JSON.stringify({
    evt: `voice_${event}`,
    at: new Date().toISOString(),
    ...fields,
  });
  // eslint-disable-next-line no-console
  console[level](record);
}
