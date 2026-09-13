import { Router } from 'express';
import { z } from 'zod';
import {
  AI_DISCLOSURE,
  APPOINTMENT_STATUSES,
  DIAGNOSES,
  LOG_CATEGORIES,
  caregiverPrefsSchema,
} from '@turtle/shared';
import type { Config } from '../config.js';
import type { Store } from '../store/index.js';
import { createCardService } from '../services/cards/index.js';
import { computeMetrics, listFlaggedTranscripts } from '../observability/index.js';

/**
 * REST control plane (§22). The same store backs the voice path, so these entities
 * are both voice-manageable and REST-manageable. Handlers here are real where the
 * behavior is phase-0 appropriate (CRUD, health, cards, delete-all); voice/session
 * turn handling lives on the WebSocket (Phase 1+).
 */
export function createRoutes(cfg: Config, store: Store): Router {
  const r = Router();
  const { repos } = store;
  const cards = createCardService({ repos });

  // GET /health — honest live-vs-degraded report (R1.2). Surfaces each provider's
  // `live` boolean and fallback message, plus a clear top-level summary of whether
  // the service is running fully or degraded and which capabilities are disabled.
  r.get('/health', (_req, res) => {
    const caps = cfg.capabilities;
    const disabled = (Object.keys(caps) as (keyof typeof caps)[]).filter((k) => !caps[k].live);
    res.json({
      ok: true,
      status: disabled.length === 0 ? 'ok' : 'degraded',
      degraded: disabled.length > 0,
      // Which capabilities are disabled and why — the client renders this honestly.
      disabledCapabilities: disabled.map((k) => ({ capability: k, reason: caps[k].fallback })),
      capabilities: caps,
    });
  });

  // ---- Sessions ----
  const createSessionSchema = z.object({ caregiver_id: z.string().min(1) });
  r.post('/sessions', (req, res) => {
    const parsed = createSessionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    let caregiver = repos.caregiver.get(parsed.data.caregiver_id);
    // The browser uses a fixed local MVP identity. On a freshly deployed database,
    // its session request can arrive before the parallel onboarding-status request
    // creates that identity; make the session endpoint safe for that first request.
    if (!caregiver && parsed.data.caregiver_id === 'local-caregiver') {
      caregiver = repos.caregiver.create({ id: 'local-caregiver', display_name: null });
    }
    if (!caregiver) return res.status(404).json({ error: 'caregiver not found' });
    return res.status(201).json(repos.session.create(parsed.data.caregiver_id));
  });

  r.get('/sessions/:id', (req, res) => {
    const s = repos.session.get(req.params.id);
    return s ? res.json(s) : res.status(404).json({ error: 'not found' });
  });

  r.get('/sessions/:id/transcript', (req, res) => {
    const s = repos.session.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    return res.json({ session_id: s.id, turns: repos.turn.listBySession(s.id) });
  });

  // ---- Cards (Task 23, R10.1/R10.4/R10.6) ----
  // GET /cards?status=archived returns the archive (dismissed + done); the other
  // statuses read the stored value directly. Defaults to active (what the client shows).
  r.get('/cards', async (req, res) => {
    const status = (req.query.status as string) ?? 'active';
    const allowed = ['active', 'dismissed', 'done', 'archived'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'invalid status' });
    return res.json(await cards.list(status as 'active' | 'dismissed' | 'done' | 'archived'));
  });

  // GET /cards/:id is the shareable-link retrieval endpoint (Task 30, R12.4). A visit
  // summary (and any retained card) is "shareable via link" = a card with a stable id
  // fetchable at this stable URL. The card's `share` action targets `/cards`; the client
  // composes `/cards/:id` from the stamped id. 404 for an unknown id, else the card row.
  r.get('/cards/:id', (req, res) => {
    const card = repos.card.get(req.params.id);
    return card ? res.json(card) : res.status(404).json({ error: 'not found' });
  });

  // PATCH /cards/:id transitions a card's lifecycle (dismiss/mark done). Only the two
  // terminal statuses are accepted — archiving a card means moving it to dismissed|done.
  const patchCardSchema = z.object({ status: z.enum(['dismissed', 'done']) });
  r.patch('/cards/:id', async (req, res) => {
    const parsed = patchCardSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const updated = await cards.setStatus(req.params.id, parsed.data.status);
    if (!updated) return res.status(404).json({ error: 'not found' });
    return res.json(updated);
  });

  // ---- Patients ----
  const createPatientSchema = z.object({
    caregiver_id: z.string().min(1),
    name: z.string().min(1),
    diagnosis: z.enum(DIAGNOSES),
    diagnosis_notes: z.string().nullish(),
    care_team: z.record(z.unknown()).optional(),
  });
  r.post('/patients', (req, res) => {
    const parsed = createPatientSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const p = repos.patient.create({
      caregiver_id: parsed.data.caregiver_id,
      name: parsed.data.name,
      diagnosis: parsed.data.diagnosis,
      diagnosis_notes: parsed.data.diagnosis_notes ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      care_team: (parsed.data.care_team as any) ?? { other: [] },
    });
    return res.status(201).json(p);
  });

  r.get('/patients/:id', (req, res) => {
    const p = repos.patient.get(req.params.id);
    return p ? res.json(p) : res.status(404).json({ error: 'not found' });
  });

  // ---- Appointments ----
  const createApptSchema = z.object({
    patient_id: z.string().min(1),
    title: z.string().min(1),
    with_whom: z.string().nullish(),
    at: z.string().min(1),
    purpose: z.string().nullish(),
    status: z.enum(APPOINTMENT_STATUSES).optional(),
  });
  r.post('/appointments', (req, res) => {
    const parsed = createApptSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    return res.status(201).json(
      repos.appointment.create({
        patient_id: parsed.data.patient_id,
        title: parsed.data.title,
        with_whom: parsed.data.with_whom ?? null,
        at: parsed.data.at,
        purpose: parsed.data.purpose ?? null,
        status: parsed.data.status,
      }),
    );
  });

  r.get('/patients/:id/appointments', (req, res) => {
    return res.json(repos.appointment.listUpcoming(req.params.id));
  });

  // PATCH /appointments/:id changes an appointment's status (Task 28, R12.1). Accepts
  // any of the three statuses (upcoming/done/cancelled) so an appointment can be marked
  // done or cancelled — and reinstated to upcoming — by REST, matching the voice path.
  // Mirrors the PATCH /cards/:id handler: 404 for an unknown id, else the updated row.
  const patchApptSchema = z.object({ status: z.enum(APPOINTMENT_STATUSES) });
  r.patch('/appointments/:id', (req, res) => {
    const parsed = patchApptSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const existing = repos.appointment.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    repos.appointment.updateStatus(existing.id, parsed.data.status);
    return res.json({ ...existing, status: parsed.data.status });
  });

  // ---- Log entries ----
  const createLogSchema = z.object({
    patient_id: z.string().min(1),
    category: z.enum(LOG_CATEGORIES),
    text: z.string().min(1),
    at: z.string().optional(),
  });
  r.post('/log-entries', (req, res) => {
    const parsed = createLogSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    return res.status(201).json(
      repos.logEntry.create({
        patient_id: parsed.data.patient_id,
        category: parsed.data.category,
        text: parsed.data.text,
        at: parsed.data.at ?? new Date().toISOString(),
        structured: null,
      }),
    );
  });

  r.get('/patients/:id/log-entries', (req, res) => {
    const since = req.query.since as string | undefined;
    return res.json(repos.logEntry.list(req.params.id, since));
  });

  // ---- Caregiver (minimal, for bootstrapping local single-user) ----
  const createCaregiverSchema = z.object({ display_name: z.string().nullish() });
  r.post('/caregivers', (req, res) => {
    const parsed = createCaregiverSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    return res.status(201).json(repos.caregiver.create({ display_name: parsed.data.display_name ?? null }));
  });

  r.get('/caregivers/:id', (req, res) => {
    const cg = repos.caregiver.get(req.params.id);
    return cg ? res.json(cg) : res.status(404).json({ error: 'not found' });
  });

  // ---- Onboarding, consent, and AI disclosure (Task 33, R16.10) ----
  // The client gates the first session on this: it needs explicit consent to
  // recording/storage AND a patient profile before talking. The status endpoint tells
  // the client whether to run onboarding, and carries the AI disclosure copy so the
  // first-run introduction ("Turtle is software — an AI…") is served from one source.
  //
  // Local single-user MVP: the caregiver row is created lazily here if it does not yet
  // exist, so a fresh client (fixed caregiver id) always resolves a real onboarding
  // state rather than 404ing. This mirrors the auth seam left in place for later.
  r.get('/onboarding/status', (req, res) => {
    const caregiverId = (req.query.caregiver_id as string) ?? '';
    if (caregiverId.trim().length === 0) {
      return res.status(400).json({ error: 'caregiver_id required' });
    }
    let cg = repos.caregiver.get(caregiverId);
    if (!cg) cg = repos.caregiver.create({ id: caregiverId, display_name: null });
    const patient = repos.patient.getByCaregiver(cg.id);
    const hasConsent = cg.consent_at != null;
    const hasProfile = patient != null;
    return res.json({
      caregiver_id: cg.id,
      // Onboarding is required until BOTH consent and a patient profile exist (R16.10:
      // explicit consent before the first session; the profile is the minimal form).
      needsOnboarding: !(hasConsent && hasProfile),
      hasConsent,
      hasProfile,
      patient: patient ?? null,
      consent_at: cg.consent_at,
      prefs: cg.prefs,
      // AI disclosure copy for the first-run introduction (served from shared constants).
      disclosure: AI_DISCLOSURE,
    });
  });

  // POST /caregivers/:id/consent — record EXPLICIT consent to recording/storage before
  // the first session (R16.10). Idempotent: re-consenting refreshes the timestamp. The
  // caregiver row is created lazily so a first-run client can consent immediately.
  r.post('/caregivers/:id/consent', (req, res) => {
    let cg = repos.caregiver.get(req.params.id);
    if (!cg) cg = repos.caregiver.create({ id: req.params.id, display_name: null });
    repos.caregiver.setConsent(cg.id);
    const updated = repos.caregiver.get(cg.id);
    return res.status(201).json(updated);
  });

  // PATCH /caregivers/:id/prefs — pick check-in time and voice preferences (R16.10).
  // Merges the supplied prefs into the caregiver prefs JSON, preserving other keys.
  r.patch('/caregivers/:id/prefs', (req, res) => {
    const parsed = caregiverPrefsSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const updated = repos.caregiver.updatePrefs(req.params.id, parsed.data);
    return updated ? res.json(updated) : res.status(404).json({ error: 'not found' });
  });

  // ---- Observability & metrics (Task 36, R15.4/R5.5) ----
  // GET /observability/flagged — owner review view for flagged transcripts (R5.5).
  // Surfaces every session marked crisis/medical_refusal with its full transcript and
  // the specific flagged turns marked. Human-in-the-loop by design.
  r.get('/observability/flagged', (_req, res) => {
    return res.json({ transcripts: listFlaggedTranscripts(repos) });
  });

  // GET /observability/metrics — lightweight metrics snapshot: sessions/day, p50/p95
  // response latency, refusal/crisis counts, and grounded-answer rate. A small pull the
  // owner can read without a full analytics pipeline (design.md §Observability).
  r.get('/observability/metrics', (_req, res) => {
    return res.json(computeMetrics(repos));
  });

  // ---- Privacy: one-click delete everything ----
  r.delete('/everything', (_req, res) => {
    repos.deleteEverything();
    return res.json({ ok: true });
  });

  return r;
}
