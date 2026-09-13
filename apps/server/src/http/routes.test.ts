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
