import type { Appointment, CareTeam, MemoryOp, Patient } from '@turtle/shared';
import type { Repositories } from '../../store/index.js';
import { applyMemoryOps } from '../../orchestrator/contract-validator.js';

/**
 * Memory & context assembly service (Task 19, R9.1–R9.4).
 *
 * Assembles the small, bounded context each turn gets. Three parts, and NOTHING
 * more — the discipline here is what keeps the prompt small and the product honest:
 *
 *   1. Profile facts (R9.1): patient name, diagnosis, care-team contacts, and the
 *      NEXT upcoming appointment ONLY. No diagnosis notes, no full appointment
 *      history, no back-catalogue of facts.
 *   2. Recent summaries (R9.2): the one-line summary of the last 3 ENDED sessions —
 *      the recap card body referenced by `session.recap_card_id` — never raw
 *      transcripts.
 *   3. Recall (R9.3/R9.4): relevant log entries, included ONLY when the active mode
 *      asks for them (`includeRecall`), and phrased as plain recall/observation
 *      ("you noted a cough on Monday"), NEVER as interpretation or advice.
 *
 * The product rule is binding: memory is surfaced as RECALL ONLY. This service reads
 * the caregiver's own logged words back and never derives a recommendation, judgment,
 * or "you should …" from them (product.md "Log, never interpret"; R9.4). Recall lines
 * are built by echoing the stored log text with a neutral "You noted … on <day>."
 * frame — no adjectives, no severity, no next step.
 *
 * KB retrieval (Q&A chunks, k=4) is intentionally NOT here — that is the RAG seam
 * (Tasks 21/22). This service leaves that seam clean and focuses on profile facts,
 * session summaries, and log recall.
 *
 * Like the sibling services, everything is injectable (store repos + an optional
 * clock) so the whole surface is unit-testable with zero network.
 */

/** How many prior-session summaries to include (R9.2: "the last 3 sessions"). */
export const MAX_RECENT_SUMMARIES = 3;

/** Default look-back window for recall log entries when a mode requests them. */
export const RECALL_LOOKBACK_DAYS = 7;

/** Default number of recall lines surfaced (kept small to stay recall, not a report). */
export const MAX_RECALL_LINES = 5;

export interface AssembledContext {
  /** Compact profile facts safe to put in a prompt (no PII beyond what's needed). */
  profileFacts: Record<string, string>;
  /** Up to 3 prior session summary lines, most recent last. */
  recentSummaries: string[];
  /** Log-entry recall lines, included only when the mode asks for them. */
  recall: string[];
}

/** Options controlling a single assembly. */
export interface AssembleOptions {
  /**
   * Include relevant log entries as recall (R9.3). The orchestrator sets this true
   * ONLY for modes that request log context (e.g. checkin/prep); left false the
   * `recall` array is empty. Mode-gated by design.
   */
  includeRecall?: boolean;
  /** Look-back window (days) for recall entries. Defaults to {@link RECALL_LOOKBACK_DAYS}. */
  recallLookbackDays?: number;
  /** Max recall lines to surface. Defaults to {@link MAX_RECALL_LINES}. */
  maxRecallLines?: number;
}

export interface MemoryService {
  /** Build the bounded context for a caregiver/session for the routed mode. */
  assemble(caregiverId: string, opts?: AssembleOptions): Promise<AssembledContext>;
  /** Apply validated memory ops from a turn contract to the store. */
  apply(patientId: string, ops: MemoryOp[]): Promise<void>;
}

/** Dependencies for the memory service (DI style, mirroring the sibling services). */
export interface MemoryServiceDeps {
  repos: Repositories;
  /** Clock for relative recall phrasing + look-back windows. Injectable for tests. */
  now?: () => Date;
}

const EMPTY_CONTEXT: AssembledContext = {
  profileFacts: {},
  recentSummaries: [],
  recall: [],
};

/**
 * Create the memory & context assembly service.
 *
 * @param deps - store repos + optional clock.
 */
export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  const nowDate = deps.now ?? (() => new Date());
  const { repos } = deps;

  return {
    async assemble(caregiverId: string, opts: AssembleOptions = {}): Promise<AssembledContext> {
      const patient = repos.patient.getByCaregiver(caregiverId);
      // No patient profile yet → nothing to assemble. Degrade gracefully rather than
      // throwing mid-turn (mirrors the orchestrator's tolerance of a pre-profile turn).
      if (!patient) return { ...EMPTY_CONTEXT };

      const profileFacts = assembleProfileFacts(patient, repos.appointment.nextUpcoming(patient.id));
      const recentSummaries = assembleRecentSummaries(caregiverId, repos);
      const recall = opts.includeRecall
        ? assembleRecall(patient.id, repos, nowDate(), {
            lookbackDays: opts.recallLookbackDays ?? RECALL_LOOKBACK_DAYS,
            maxLines: opts.maxRecallLines ?? MAX_RECALL_LINES,
          })
        : [];

      return { profileFacts, recentSummaries, recall };
    },

    async apply(patientId: string, ops: MemoryOp[]): Promise<void> {
      // Reuse the single write path from Task 15 so `append_log` / `set_fact` behave
      // identically whether applied inline by the validator or via this service.
      applyMemoryOps(ops, { repos, patientId, now: () => nowDate().toISOString() });
    },
  };
}

/**
 * Assemble the allowed profile facts and NOTHING else (R9.1): patient, diagnosis,
 * care-team contacts, and the next upcoming appointment only. Diagnosis notes, full
 * appointment history, and any other patient fields are deliberately excluded.
 */
export function assembleProfileFacts(
  patient: Patient,
  nextAppointment: Appointment | null,
): Record<string, string> {
  const facts: Record<string, string> = {
    patient: patient.name,
    diagnosis: patient.diagnosis,
  };

  for (const [key, value] of careTeamEntries(patient.care_team)) {
    facts[key] = value;
  }

  if (nextAppointment) {
    facts.next_appointment = formatAppointment(nextAppointment);
  }

  return facts;
}

/** Flatten a care team into `care_team.<role>` fact entries (skipping empties). */
function careTeamEntries(careTeam: CareTeam): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  const add = (role: string, contact?: string) => {
    if (contact && contact.trim().length > 0) entries.push([`care_team.${role}`, contact.trim()]);
  };
  add('nurse_line', careTeam.nurse_line);
  add('social_worker', careTeam.social_worker);
  add('oncologist', careTeam.oncologist);
  for (const other of careTeam.other ?? []) {
    add(slugRole(other.label), other.contact);
  }
  return entries;
}

/** Normalize a free-text care-team label into a stable fact-key suffix. */
function slugRole(label: string): string {
  const slug = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug.length > 0 ? slug : 'contact';
}

/** Compact one-line rendering of the next appointment for a prompt fact. */
function formatAppointment(appt: Appointment): string {
  const parts = [appt.title];
  if (appt.with_whom) parts.push(`with ${appt.with_whom}`);
  parts.push(`on ${appt.at}`);
  if (appt.purpose) parts.push(`(${appt.purpose})`);
  return parts.join(' ');
}

/**
 * Assemble up to the last 3 ENDED sessions' one-line summaries (R9.2), most recent
 * LAST so the context reads chronologically. The summary is the recap card body
 * referenced by `session.recap_card_id` — never a transcript. Sessions with no recap
 * card (e.g. closed without a recap) contribute no summary line.
 */
export function assembleRecentSummaries(caregiverId: string, repos: Repositories): string[] {
  const sessions = repos.session.listRecentEnded(caregiverId, MAX_RECENT_SUMMARIES);
  const summaries: string[] = [];
  // listRecentEnded returns newest-first; walk it and reverse so the array ends with
  // the most recent summary.
  for (const session of sessions) {
    if (!session.recap_card_id) continue;
    const card = repos.card.get(session.recap_card_id);
    const line = card?.body.trim();
    if (line && line.length > 0) summaries.push(line);
  }
  return summaries.reverse();
}

/**
 * Assemble log-entry recall lines (R9.3/R9.4). Only called when the mode requests
 * recall. Each line echoes the caregiver's own logged text with a neutral recall
 * frame — "You noted <text> on <day>." — and NOTHING interpretive: no severity, no
 * judgment, no advice. Bounded by look-back window and line count so it stays recall,
 * not a report.
 */
export function assembleRecall(
  patientId: string,
  repos: Repositories,
  now: Date,
  opts: { lookbackDays: number; maxLines: number },
): string[] {
  const sinceIso = new Date(now.getTime() - opts.lookbackDays * 86_400_000).toISOString();
  const entries = repos.logEntry.list(patientId, sinceIso); // newest-first
  return entries.slice(0, opts.maxLines).map((e) => recallLine(e.text, e.at, now));
}

/**
 * Render a single recall line: pure recall, never advice (R9.4). Echoes the stored
 * text verbatim, framed with when it was noted relative to now ("today", "yesterday",
 * a weekday, or a date). No adjectives, no "you should", no interpretation.
 */
export function recallLine(text: string, atIso: string, now: Date): string {
  return `You noted ${text.trim()} ${relativeWhen(atIso, now)}.`;
}

/**
 * Human, non-interpretive relative-day phrasing for a recall timestamp. Deliberately
 * dumb: it reports WHEN, never what it means. Falls back to the ISO date for anything
 * older than a week.
 */
export function relativeWhen(atIso: string, now: Date): string {
  const at = new Date(atIso);
  if (Number.isNaN(at.getTime())) return 'recently';

  const startOfDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dayDiff = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);

  if (dayDiff <= 0) return 'today';
  if (dayDiff === 1) return 'yesterday';
  if (dayDiff < 7) {
    const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
      at.getUTCDay()
    ];
    return `on ${weekday}`;
  }
  return `on ${atIso.slice(0, 10)}`;
}
