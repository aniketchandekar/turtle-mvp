/**
 * Browser-side diagnostics for microphone capture and the realtime socket.
 * Contains lifecycle metadata only—never transcript text or audio samples.
 */
type VoiceDebugFields = Record<string, string | number | boolean | null | undefined>;

function enabled(): boolean {
  return process.env.NEXT_PUBLIC_VOICE_DEBUG !== '0' && process.env.NODE_ENV !== 'test';
}

export function voiceDebug(
  event: string,
  fields: VoiceDebugFields = {},
  level: 'info' | 'warn' | 'error' = 'info',
): void {
  if (!enabled()) return;
  const record = { evt: `voice_${event}`, at: new Date().toISOString(), ...fields };
  // eslint-disable-next-line no-console
  console[level]('[turtle:voice]', record);
}
