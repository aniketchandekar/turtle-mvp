import { describe, it, expect } from 'vitest';
import express from 'express';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { loadConfig, type EnvSource } from '../config.js';
import { createStore } from '../store/index.js';
import { createRoutes } from './routes.js';

/**
 * Backend service + health endpoint (Task 6).
 * Covers R1.2 — GET /health honestly reports live vs degraded providers, so the
 * client can surface disabled capabilities. Uses an in-memory SQLite store and a
 * real ephemeral HTTP listener (no mocks, no new deps).
 */

const EMPTY: EnvSource = {};

// Build a real app backed by an in-memory DB so tests don't touch disk.
function makeApp(env: EnvSource) {
  const cfg = loadConfig(env);
  const store = createStore(':memory:', cfg.encryptionKey);
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(cfg, store));
  return { app, store };
}

// Parsed JSON bodies are dynamic in these tests; `any` keeps assertions terse.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getJson(app: express.Express, path: string): Promise<{ status: number; body: any }> {
  return request(app, 'GET', path);
}

/**
 * Issue a request with an optional JSON body against a real, per-request ephemeral
 * listener. Each call owns its own listener for its whole lifetime and closes it
 * before returning, so sequential requests within a single test never race a
 * shared socket (which previously surfaced as "Unexpected end of JSON input").
 */
async function request(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }> {
  const server: http.Server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text.length > 0 ? JSON.parse(text) : undefined;
    return { status: res.status, body: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('GET /health — degraded reporting (R1.2)', () => {
  it('reports degraded with every provider disabled when no keys are set', async () => {
    const { app } = makeApp(EMPTY);
    const { status, body } = await getJson(app, '/health');

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status).toBe('degraded');
    expect(body.degraded).toBe(true);

    // Every provider surfaces a live boolean and a fallback message.
    for (const cap of Object.values(body.capabilities) as { live: boolean; fallback: string }[]) {
      expect(cap.live).toBe(false);
      expect(cap.fallback.length).toBeGreaterThan(0);
    }

    // All four capabilities appear in the disabled summary with a reason.
    const disabledKeys = body.disabledCapabilities.map((d: { capability: string }) => d.capability);
    expect(disabledKeys.sort()).toEqual(['asr', 'embeddings', 'llm', 'tts']);
    for (const d of body.disabledCapabilities) {
      expect(d.reason.length).toBeGreaterThan(0);
    }
  });

  it('reports ok with an empty disabled list when all keys are present', async () => {
    const { app } = makeApp({
      DEEPGRAM_API_KEY: 'dg',
      ELEVENLABS_API_KEY: 'el',
      ELEVENLABS_VOICE_ID: 'voice',
      ANTHROPIC_API_KEY: 'an',
      OPENAI_API_KEY: 'oa',
    });
    const { body } = await getJson(app, '/health');

    expect(body.status).toBe('ok');
    expect(body.degraded).toBe(false);
    expect(body.disabledCapabilities).toEqual([]);
    expect(body.capabilities.asr.live).toBe(true);
    expect(body.capabilities.llm.live).toBe(true);
  });

  it('reports partial degradation, naming only the disabled providers', async () => {
    const { app } = makeApp({ ANTHROPIC_API_KEY: 'an' });
    const { body } = await getJson(app, '/health');

    expect(body.status).toBe('degraded');
    const disabledKeys = body.disabledCapabilities.map((d: { capability: string }) => d.capability);
    expect(disabledKeys).not.toContain('llm');
    expect(disabledKeys.sort()).toEqual(['asr', 'embeddings', 'tts']);
  });
});

describe('POST /sessions — first deployed session', () => {
  it('bootstraps the fixed local MVP caregiver on a fresh database', async () => {
    const { app, store } = makeApp(EMPTY);
    const { status, body } = await request(app, 'POST', '/sessions', {
      caregiver_id: 'local-caregiver',
    });

    expect(status).toBe(201);
    expect(body.id).toEqual(expect.any(String));
    expect(store.repos.caregiver.get('local-caregiver')).not.toBeNull();
  });

  it('does not create arbitrary caregiver ids through the session endpoint', async () => {
    const { app } = makeApp(EMPTY);
    const { status, body } = await request(app, 'POST', '/sessions', {
      caregiver_id: 'unknown-caregiver',
    });

    expect(status).toBe(404);
    expect(body.error).toBe('caregiver not found');
  });
});

describe('Cards REST — lifecycle + archive (Task 23, R10.1/R10.4/R10.6)', () => {
  /** Seed a session + one active card directly in the store (cards come from the contract). */
  function seedCard(store: ReturnType<typeof makeApp>['store'], title: string) {
    const cg = store.repos.caregiver.create({ display_name: 'Alex' });
    const session = store.repos.session.create(cg.id);
    return store.repos.card.create({
      session_id: session.id,
      type: 'actionable',
      title,
      body: `body for ${title}`,
      action: null,
    });
  }

  it('GET /cards defaults to active', async () => {
    const { app, store } = makeApp(EMPTY);
    seedCard(store, 'Active one');
    const { status, body } = await getJson(app, '/cards');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].title).toBe('Active one');
    expect(body[0].status).toBe('active');
  });

  it('GET /cards?status=archived returns dismissed + done, not active', async () => {
    const { app, store } = makeApp(EMPTY);
    const dismissed = seedCard(store, 'Dismissed one');
    const done = seedCard(store, 'Done one');
    seedCard(store, 'Active one');
    store.repos.card.setStatus(dismissed.id, 'dismissed');
    store.repos.card.setStatus(done.id, 'done');

    const { status, body } = await getJson(app, '/cards?status=archived');
    expect(status).toBe(200);
    const titles = body.map((c: { title: string }) => c.title).sort();
    expect(titles).toEqual(['Dismissed one', 'Done one']);
  });

  it('GET /cards rejects an invalid status', async () => {
    const { app } = makeApp(EMPTY);
    const { status, body } = await getJson(app, '/cards?status=bogus');
    expect(status).toBe(400);
    expect(body.error).toBe('invalid status');
  });

  it('PATCH /cards/:id dismisses a card and frees the active view', async () => {
    const { app, store } = makeApp(EMPTY);
    const c = seedCard(store, 'Dismiss via REST');

    const patched = await request(app, 'PATCH', `/cards/${c.id}`, { status: 'dismissed' });
    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe('dismissed');

    const active = await getJson(app, '/cards?status=active');
    expect(active.body).toEqual([]);
    const archived = await getJson(app, '/cards?status=archived');
    expect(archived.body).toHaveLength(1);
  });

  it('PATCH /cards/:id marks a card done', async () => {
    const { app, store } = makeApp(EMPTY);
    const c = seedCard(store, 'Complete via REST');
    const patched = await request(app, 'PATCH', `/cards/${c.id}`, { status: 'done' });
    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe('done');
  });

  it('PATCH /cards/:id 404s for an unknown card', async () => {
    const { app } = makeApp(EMPTY);
    const res = await request(app, 'PATCH', '/cards/missing', { status: 'done' });
    expect(res.status).toBe(404);
  });

  it('PATCH /cards/:id rejects a non-terminal status (no reactivation)', async () => {
    const { app, store } = makeApp(EMPTY);
    const c = seedCard(store, 'No reactivation');
    const res = await request(app, 'PATCH', `/cards/${c.id}`, { status: 'active' });
    expect(res.status).toBe(400);
  });
});

describe('Cards REST — shareable-link retrieval GET /cards/:id (Task 30, R12.4)', () => {
  /** Seed a session + one shareable retained visit-summary card in the store. */
  function seedSummaryCard(store: ReturnType<typeof makeApp>['store']) {
    const cg = store.repos.caregiver.create({ display_name: 'Alex' });
    const session = store.repos.session.create(cg.id);
    return store.repos.card.create({
      session_id: session.id,
      type: 'retained',
      title: 'Visit summary: Oncology',
      body: 'Scan was stable\n• No growth\nNext: Back in two weeks',
      action: { kind: 'share', target: '/cards' },
    });
  }

  it('GET /cards/:id returns the card by its stable id (the shareable link)', async () => {
    const { app, store } = makeApp(EMPTY);
    const card = seedSummaryCard(store);
    const { status, body } = await getJson(app, `/cards/${card.id}`);
    expect(status).toBe(200);
    expect(body.id).toBe(card.id);
    expect(body.title).toBe('Visit summary: Oncology');
    expect(body.action).toEqual({ kind: 'share', target: '/cards' });
  });

  it('GET /cards/:id resolves a card even after it has been archived', async () => {
    const { app, store } = makeApp(EMPTY);
    const card = seedSummaryCard(store);
    store.repos.card.setStatus(card.id, 'done');
    const { status, body } = await getJson(app, `/cards/${card.id}`);
    expect(status).toBe(200);
    expect(body.id).toBe(card.id);
  });

  it('GET /cards/:id 404s for an unknown id', async () => {
    const { app } = makeApp(EMPTY);
    const { status } = await getJson(app, '/cards/missing');
    expect(status).toBe(404);
  });
});

describe('Appointments REST — status changes (Task 28, R12.1)', () => {
  /** Seed a caregiver + patient + one upcoming appointment directly in the store. */
  function seedAppointment(store: ReturnType<typeof makeApp>['store']) {
    const cg = store.repos.caregiver.create({ display_name: 'Alex' });
    const patient = store.repos.patient.create({
      caregiver_id: cg.id,
      name: 'Sam',
      diagnosis: 'metastatic_cancer',
      diagnosis_notes: null,
      care_team: { other: [] },
    });
    const appt = store.repos.appointment.create({
      patient_id: patient.id,
      title: 'Oncology',
      with_whom: 'Dr. Lee',
      at: new Date(Date.now() + 86_400_000).toISOString(),
      purpose: 'follow-up',
    });
    return { patient, appt };
  }

  it('PATCH /appointments/:id marks an appointment done', async () => {
    const { app, store } = makeApp(EMPTY);
    const { appt } = seedAppointment(store);
    const res = await request(app, 'PATCH', `/appointments/${appt.id}`, { status: 'done' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('done');
    expect(res.body.title).toBe('Oncology');
  });

  it('PATCH /appointments/:id cancels an appointment and drops it from upcoming', async () => {
    const { app, store } = makeApp(EMPTY);
    const { patient, appt } = seedAppointment(store);
    const res = await request(app, 'PATCH', `/appointments/${appt.id}`, { status: 'cancelled' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');

    const upcoming = await getJson(app, `/patients/${patient.id}/appointments`);
    expect(upcoming.body).toEqual([]);
  });

  it('PATCH /appointments/:id can set status back to upcoming', async () => {
    const { app, store } = makeApp(EMPTY);
    const { appt } = seedAppointment(store);
    store.repos.appointment.updateStatus(appt.id, 'cancelled');
    const res = await request(app, 'PATCH', `/appointments/${appt.id}`, { status: 'upcoming' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('upcoming');
  });

  it('PATCH /appointments/:id 404s for an unknown appointment', async () => {
    const { app } = makeApp(EMPTY);
    const res = await request(app, 'PATCH', '/appointments/missing', { status: 'done' });
    expect(res.status).toBe(404);
  });

  it('PATCH /appointments/:id rejects an invalid status', async () => {
    const { app, store } = makeApp(EMPTY);
    const { appt } = seedAppointment(store);
    const res = await request(app, 'PATCH', `/appointments/${appt.id}`, { status: 'bogus' });
    expect(res.status).toBe(400);
  });
});


describe('Onboarding, consent, and AI disclosure (Task 33, R16.10)', () => {
  it('GET /onboarding/status requires a caregiver_id', async () => {
    const { app } = makeApp(EMPTY);
    const { status, body } = await getJson(app, '/onboarding/status');
    expect(status).toBe(400);
    expect(body.error).toBe('caregiver_id required');
  });

  it('reports needsOnboarding for a brand-new caregiver and carries the AI disclosure', async () => {
    const { app } = makeApp(EMPTY);
    const { status, body } = await getJson(app, '/onboarding/status?caregiver_id=local-caregiver');
    expect(status).toBe(200);
    // Fresh caregiver: no consent, no profile → onboarding required (R16.10).
    expect(body.needsOnboarding).toBe(true);
    expect(body.hasConsent).toBe(false);
    expect(body.hasProfile).toBe(false);
    // The first-run introduction copy is served from one source (shared constants):
    // it must clearly say Turtle is an AI, what it does, and what it never does.
    expect(body.disclosure.what_i_am.toLowerCase()).toContain('software');
    expect(body.disclosure.spoken.toLowerCase()).toContain('ai');
    expect(body.disclosure.what_i_never_do.toLowerCase()).toContain('prognosis');
  });

  it('lazily creates the caregiver so a first-run client resolves state, not a 404', async () => {
    const { app, store } = makeApp(EMPTY);
    expect(store.repos.caregiver.get('local-caregiver')).toBeNull();
    await getJson(app, '/onboarding/status?caregiver_id=local-caregiver');
    expect(store.repos.caregiver.get('local-caregiver')).not.toBeNull();
  });

  it('POST /caregivers/:id/consent records explicit consent before the first session', async () => {
    const { app, store } = makeApp(EMPTY);
    const res = await request(app, 'POST', '/caregivers/local-caregiver/consent');
    expect(res.status).toBe(201);
    expect(res.body.consent_at).toBeTruthy();
    // Persisted on the caregiver row.
    expect(store.repos.caregiver.get('local-caregiver')?.consent_at).toBeTruthy();
  });

  it('PATCH /caregivers/:id/prefs saves check-in time and voice preferences (merging)', async () => {
    const { app, store } = makeApp(EMPTY);
    // Bootstrap the caregiver via the status endpoint.
    await getJson(app, '/onboarding/status?caregiver_id=local-caregiver');

    const first = await request(app, 'PATCH', '/caregivers/local-caregiver/prefs', {
      checkin_time: '09:00',
      voice_id: 'voice-1',
    });
    expect(first.status).toBe(200);
    expect(first.body.prefs.checkin_time).toBe('09:00');
    expect(first.body.prefs.voice_id).toBe('voice-1');

    // A second patch merges — updating pace without dropping the earlier keys.
    const second = await request(app, 'PATCH', '/caregivers/local-caregiver/prefs', {
      pace: 1.0,
    });
    expect(second.status).toBe(200);
    expect(second.body.prefs.checkin_time).toBe('09:00');
    expect(second.body.prefs.voice_id).toBe('voice-1');
    expect(second.body.prefs.pace).toBe(1.0);
    expect(store.repos.caregiver.get('local-caregiver')?.prefs.pace).toBe(1.0);
  });

  it('PATCH /caregivers/:id/prefs rejects an out-of-range pace', async () => {
    const { app } = makeApp(EMPTY);
    await getJson(app, '/onboarding/status?caregiver_id=local-caregiver');
    const res = await request(app, 'PATCH', '/caregivers/local-caregiver/prefs', { pace: 5 });
    expect(res.status).toBe(400);
  });

  it('PATCH /caregivers/:id/prefs 404s for an unknown caregiver', async () => {
    const { app } = makeApp(EMPTY);
    const res = await request(app, 'PATCH', '/caregivers/nope/prefs', { pace: 1.0 });
    expect(res.status).toBe(404);
  });

  it('clears needsOnboarding once consent AND a patient profile exist (R16.10)', async () => {
    const { app } = makeApp(EMPTY);
    // Bootstrap + consent.
    const boot = await getJson(app, '/onboarding/status?caregiver_id=local-caregiver');
    expect(boot.body.needsOnboarding).toBe(true);
    await request(app, 'POST', '/caregivers/local-caregiver/consent');

    // Consent alone is not enough — the minimal profile (patient) is still required.
    const afterConsent = await getJson(app, '/onboarding/status?caregiver_id=local-caregiver');
    expect(afterConsent.body.hasConsent).toBe(true);
    expect(afterConsent.body.hasProfile).toBe(false);
    expect(afterConsent.body.needsOnboarding).toBe(true);

    // Create the patient profile via the existing minimal-form endpoint.
    const patient = await request(app, 'POST', '/patients', {
      caregiver_id: 'local-caregiver',
      name: 'Sam',
      diagnosis: 'metastatic_cancer',
      care_team: { nurse_line: '555-1234', other: [] },
    });
    expect(patient.status).toBe(201);

    // Now both conditions are met → onboarding complete.
    const done = await getJson(app, '/onboarding/status?caregiver_id=local-caregiver');
    expect(done.body.hasConsent).toBe(true);
    expect(done.body.hasProfile).toBe(true);
    expect(done.body.needsOnboarding).toBe(false);
  });
});

describe('Observability REST (Task 36, R15.4/R5.5)', () => {
  it('GET /observability/flagged surfaces only flagged transcripts, turns marked', async () => {
    const { app, store } = makeApp(EMPTY);
    const cg = store.repos.caregiver.create({ display_name: 'Alex' });

    // A flagged session (crisis) with two turns; the assistant turn carries the flag.
    const flaggedSession = store.repos.session.create(cg.id);
    store.repos.turn.create({
      session_id: flaggedSession.id, seq: 1, speaker: 'user', text: 'I feel hopeless',
      asr_conf: null, retrieved_chunk_ids: [], flag: null, latency_ms: null,
    });
    store.repos.turn.create({
      session_id: flaggedSession.id, seq: 2, speaker: 'assistant', text: 'I hear you…',
      asr_conf: null, retrieved_chunk_ids: [], flag: 'crisis', latency_ms: 950,
    });
    store.repos.session.addFlag(flaggedSession.id, 'crisis');

    // An unflagged session that must NOT appear in the review view.
    store.repos.session.create(cg.id);

    const { status, body } = await getJson(app, '/observability/flagged');
    expect(status).toBe(200);
    expect(body.transcripts).toHaveLength(1);
    expect(body.transcripts[0].session_id).toBe(flaggedSession.id);
    expect(body.transcripts[0].flags).toEqual(['crisis']);
    expect(body.transcripts[0].flagged_turn_count).toBe(1);
  });

  it('GET /observability/metrics returns the lightweight snapshot', async () => {
    const { app, store } = makeApp(EMPTY);
    const cg = store.repos.caregiver.create({ display_name: 'Alex' });
    const s = store.repos.session.create(cg.id);
    store.repos.turn.create({
      session_id: s.id, seq: 1, speaker: 'assistant', text: 'grounded (source: c1)',
      asr_conf: null, retrieved_chunk_ids: ['c1'], flag: null, latency_ms: 1200,
    });

    const { status, body } = await getJson(app, '/observability/metrics');
    expect(status).toBe(200);
    expect(body.total_sessions).toBe(1);
    expect(body.latency_ms.count).toBe(1);
    expect(body.latency_ms.p50).toBe(1200);
    expect(body.grounded_answers.grounded).toBe(1);
    expect(body.grounded_answers.rate).toBe(1);
    expect(body.flags).toEqual({ crisis: 0, medical_refusal: 0 });
    expect(Array.isArray(body.sessions_per_day)).toBe(true);
  });

  it('GET /observability/metrics is empty-safe on a fresh store', async () => {
    const { app } = makeApp(EMPTY);
    const { status, body } = await getJson(app, '/observability/metrics');
    expect(status).toBe(200);
    expect(body.total_sessions).toBe(0);
    expect(body.grounded_answers.rate).toBeNull();
  });
});

describe('Privacy — one-click delete everything DELETE /everything (Task 37, R16.7)', () => {
  /**
   * Seed one row in every caregiver-data table so the wipe is provably complete:
   * caregiver → patient → appointment + log_entry, and a session → turn + card.
   * Returns the ids the assertions read back after the delete.
   */
  function seedEverything(store: ReturnType<typeof makeApp>['store']) {
    const { repos } = store;
    const cg = repos.caregiver.create({ display_name: 'Alex' });
    const patient = repos.patient.create({
      caregiver_id: cg.id,
      name: 'Sam',
      diagnosis: 'metastatic_cancer',
      diagnosis_notes: null,
      care_team: { nurse_line: '555-1234', other: [] },
    });
    const appt = repos.appointment.create({
      patient_id: patient.id,
      title: 'Oncology',
      with_whom: 'Dr. Lee',
      at: new Date(Date.now() + 86_400_000).toISOString(),
      purpose: 'follow-up',
    });
    const log = repos.logEntry.create({
      patient_id: patient.id,
      at: new Date().toISOString(),
      category: 'symptom',
      text: 'new cough',
      structured: null,
    });
    const session = repos.session.create(cg.id);
    const turn = repos.turn.create({
      session_id: session.id,
      seq: 1,
      speaker: 'user',
      text: 'I am scared',
      asr_conf: null,
      retrieved_chunk_ids: [],
      flag: null,
      latency_ms: null,
    });
    const card = repos.card.create({
      session_id: session.id,
      type: 'retained',
      title: 'Note',
      body: 'body',
      action: null,
    });
    return { cg, patient, appt, log, session, turn, card };
  }

  it('DELETE /everything wipes all stored data and returns ok', async () => {
    const { app, store } = makeApp(EMPTY);
    const seeded = seedEverything(store);

    const res = await request(app, 'DELETE', '/everything');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // Every caregiver-data entity is gone (R16.7: one-click delete everything).
    const { repos } = store;
    expect(repos.caregiver.get(seeded.cg.id)).toBeNull();
    expect(repos.patient.get(seeded.patient.id)).toBeNull();
    expect(repos.appointment.get(seeded.appt.id)).toBeNull();
    expect(repos.logEntry.list(seeded.patient.id)).toEqual([]);
    expect(repos.session.get(seeded.session.id)).toBeNull();
    expect(repos.turn.listBySession(seeded.session.id)).toEqual([]);
    expect(repos.card.get(seeded.card.id)).toBeNull();
    // The store-wide views are empty too.
    expect(repos.session.listAll()).toEqual([]);
    expect(repos.turn.listAll()).toEqual([]);
  });

  it('DELETE /everything is idempotent on an already-empty store', async () => {
    const { app } = makeApp(EMPTY);
    const first = await request(app, 'DELETE', '/everything');
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true });
    // Running it again on an empty store is a safe no-op, not an error.
    const second = await request(app, 'DELETE', '/everything');
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true });
  });
});
