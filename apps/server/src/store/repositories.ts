import crypto from 'node:crypto';
import type {
  Appointment,
  Caregiver,
  CardRecord,
  KbChunk,
  LogEntry,
  Patient,
  Session,
  Turn,
} from '@turtle/shared';
import type { DB } from './db.js';
import type { Cipher } from './crypto.js';

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const j = (v: unknown) => JSON.stringify(v);
const p = <T>(v: string | null | undefined, fallback: T): T =>
  v == null ? fallback : (JSON.parse(v) as T);

/** A raw SQLite row. Columns are strings/nulls; callers coerce known-NOT-NULL fields. */
type Row = Record<string, string | number | null>;
/** Coerce a known NOT-NULL text column to string. */
const s = (v: string | number | null | undefined): string => (v == null ? '' : String(v));

/**
 * Repositories for all data-model entities. Sensitive fields (transcripts, log text,
 * care-team contacts) are encrypted via the injected Cipher before write and decrypted
 * on read.
 */
export function createRepositories(db: DB, cipher: Cipher) {
  return {
    caregiver: {
      create(input: Partial<Caregiver> & { display_name?: string | null }): Caregiver {
        const row: Caregiver = {
          id: input.id ?? id(),
          display_name: input.display_name ?? null,
          created_at: input.created_at ?? now(),
          consent_at: input.consent_at ?? null,
          prefs: input.prefs ?? {},
        };
        db.prepare(
          `INSERT INTO caregiver (id, display_name, created_at, consent_at, prefs)
           VALUES (@id, @display_name, @created_at, @consent_at, @prefs)`,
        ).run({ ...row, prefs: j(row.prefs) });
        return row;
      },
      get(cid: string): Caregiver | null {
        const r = db.prepare(`SELECT * FROM caregiver WHERE id = ?`).get(cid) as
          | Record<string, string>
          | undefined;
        if (!r) return null;
        return {
          id: r.id,
          display_name: r.display_name ?? null,
          created_at: r.created_at,
          consent_at: r.consent_at ?? null,
          prefs: p(r.prefs, {}),
        } as Caregiver;
      },
      setConsent(cid: string, at = now()): void {
        db.prepare(`UPDATE caregiver SET consent_at = ? WHERE id = ?`).run(at, cid);
      },
    },

    patient: {
      create(input: Omit<Patient, 'id'> & { id?: string }): Patient {
        const row: Patient = { id: input.id ?? id(), ...input } as Patient;
        db.prepare(
          `INSERT INTO patient (id, caregiver_id, name, diagnosis, diagnosis_notes, care_team)
           VALUES (@id, @caregiver_id, @name, @diagnosis, @diagnosis_notes, @care_team)`,
        ).run({
          id: row.id,
          caregiver_id: row.caregiver_id,
          name: row.name,
          diagnosis: row.diagnosis,
          diagnosis_notes: row.diagnosis_notes ?? null,
          care_team: cipher.encrypt(j(row.care_team)),
        });
        return row;
      },
      get(pid: string): Patient | null {
        const r = db.prepare(`SELECT * FROM patient WHERE id = ?`).get(pid) as
          | Record<string, string>
          | undefined;
        if (!r) return null;
        return {
          id: r.id,
          caregiver_id: r.caregiver_id,
          name: r.name,
          diagnosis: r.diagnosis,
          diagnosis_notes: r.diagnosis_notes ?? null,
          care_team: p(cipher.decrypt(r.care_team), {}),
        } as Patient;
      },
      /**
       * Fetch the patient for a caregiver (MVP: single-patient-per-caregiver). Backs
       * the memory service's profile-fact assembly (Task 19, R9.1). Returns the most
       * recently created match if more than one row somehow exists.
       */
      getByCaregiver(caregiverId: string): Patient | null {
        const r = db.prepare(`SELECT * FROM patient WHERE caregiver_id = ? LIMIT 1`).get(
          caregiverId,
        ) as Record<string, string> | undefined;
        if (!r) return null;
        return {
          id: r.id,
          caregiver_id: r.caregiver_id,
          name: r.name,
          diagnosis: r.diagnosis,
          diagnosis_notes: r.diagnosis_notes ?? null,
          care_team: p(cipher.decrypt(r.care_team), {}),
        } as Patient;
      },
    },

    appointment: {
      create(input: Omit<Appointment, 'id' | 'status'> & { id?: string; status?: Appointment['status'] }): Appointment {
        const row: Appointment = {
          id: input.id ?? id(),
          patient_id: input.patient_id,
          title: input.title,
          with_whom: input.with_whom ?? null,
          at: input.at,
          purpose: input.purpose ?? null,
          status: input.status ?? 'upcoming',
        };
        db.prepare(
          `INSERT INTO appointment (id, patient_id, title, with_whom, at, purpose, status)
           VALUES (@id, @patient_id, @title, @with_whom, @at, @purpose, @status)`,
        ).run(row);
        return row;
      },
      /**
       * Fetch a single appointment by id, or null. Backs the status-change write path
       * (Task 28, R12.1): `PATCH /appointments/:id` reads the row to 404 unknown ids
       * and to return the updated appointment after {@link updateStatus}.
       */
      get(aid: string): Appointment | null {
        const r = db.prepare(`SELECT * FROM appointment WHERE id = ?`).get(aid) as
          | Appointment
          | undefined;
        return r ?? null;
      },
      listUpcoming(patientId: string): Appointment[] {
        return db
          .prepare(
            `SELECT * FROM appointment WHERE patient_id = ? AND status = 'upcoming' ORDER BY at ASC`,
          )
          .all(patientId) as Appointment[];
      },
      nextUpcoming(patientId: string): Appointment | null {
        return (
          (db
            .prepare(
              `SELECT * FROM appointment WHERE patient_id = ? AND status = 'upcoming'
               AND at >= ? ORDER BY at ASC LIMIT 1`,
            )
            .get(patientId, now()) as Appointment | undefined) ?? null
        );
      },
      updateStatus(aid: string, status: Appointment['status']): void {
        db.prepare(`UPDATE appointment SET status = ? WHERE id = ?`).run(status, aid);
      },
    },

    logEntry: {
      create(input: Omit<LogEntry, 'id'> & { id?: string }): LogEntry {
        const row: LogEntry = {
          id: input.id ?? id(),
          patient_id: input.patient_id,
          at: input.at ?? now(),
          category: input.category,
          text: input.text,
          structured: input.structured ?? null,
        };
        db.prepare(
          `INSERT INTO log_entry (id, patient_id, at, category, text, structured)
           VALUES (@id, @patient_id, @at, @category, @text, @structured)`,
        ).run({
          id: row.id,
          patient_id: row.patient_id,
          at: row.at,
          category: row.category,
          text: cipher.encrypt(row.text),
          structured: row.structured ? j(row.structured) : null,
        });
        return row;
      },
      list(patientId: string, sinceIso?: string): LogEntry[] {
        const rows = (
          sinceIso
            ? db
                .prepare(`SELECT * FROM log_entry WHERE patient_id = ? AND at >= ? ORDER BY at DESC`)
                .all(patientId, sinceIso)
            : db.prepare(`SELECT * FROM log_entry WHERE patient_id = ? ORDER BY at DESC`).all(patientId)
        ) as Row[];
        return rows.map((r) => ({
          id: s(r.id),
          patient_id: s(r.patient_id),
          at: s(r.at),
          category: r.category as LogEntry['category'],
          text: cipher.decrypt(s(r.text)) ?? '',
          structured: r.structured ? p(String(r.structured), null) : null,
        }));
      },
    },

    session: {
      create(caregiverId: string): Session {
        const row: Session = {
          id: id(),
          caregiver_id: caregiverId,
          started_at: now(),
          ended_at: null,
          mode_transitions: [],
          flags: [],
          recap_card_id: null,
        };
        db.prepare(
          `INSERT INTO session (id, caregiver_id, started_at, ended_at, mode_transitions, flags, recap_card_id)
           VALUES (@id, @caregiver_id, @started_at, @ended_at, @mode_transitions, @flags, @recap_card_id)`,
        ).run({
          ...row,
          mode_transitions: j(row.mode_transitions),
          flags: j(row.flags),
        });
        return row;
      },
      get(sid: string): Session | null {
        const r = db.prepare(`SELECT * FROM session WHERE id = ?`).get(sid) as
          | Record<string, string>
          | undefined;
        if (!r) return null;
        return {
          id: r.id,
          caregiver_id: r.caregiver_id,
          started_at: r.started_at,
          ended_at: r.ended_at ?? null,
          mode_transitions: p(r.mode_transitions, []),
          flags: p(r.flags, []),
          recap_card_id: r.recap_card_id ?? null,
        } as Session;
      },
      /**
       * List the most recently ENDED sessions (newest first), up to `limit`.
       * Backs the memory service's "last N session summaries" assembly (Task 19,
       * R9.2): each ended session carries a `recap_card_id` whose card body is the
       * one-line summary. Only sessions with a set `ended_at` are returned — an
       * in-flight session has no summary yet.
       */
      listRecentEnded(caregiverId: string, limit = 3): Session[] {
        const rows = db
          .prepare(
            // rowid DESC is a deterministic tiebreaker when ended_at values tie
            // (sessions closed within the same millisecond): newest-inserted wins.
            `SELECT * FROM session WHERE caregiver_id = ? AND ended_at IS NOT NULL
             ORDER BY ended_at DESC, rowid DESC LIMIT ?`,
          )
          .all(caregiverId, limit) as Record<string, string>[];
        return rows.map((r) => ({
          id: r.id,
          caregiver_id: r.caregiver_id,
          started_at: r.started_at,
          ended_at: r.ended_at ?? null,
          mode_transitions: p(r.mode_transitions, []),
          flags: p(r.flags, []),
          recap_card_id: r.recap_card_id ?? null,
        })) as Session[];
      },
      appendTransition(sid: string, mode: string): void {
        const s = this.get(sid);
        if (!s) return;
        const transitions = [...s.mode_transitions, mode];
        db.prepare(`UPDATE session SET mode_transitions = ? WHERE id = ?`).run(j(transitions), sid);
      },
      addFlag(sid: string, flag: string): void {
        const s = this.get(sid);
        if (!s || s.flags.includes(flag)) return;
        db.prepare(`UPDATE session SET flags = ? WHERE id = ?`).run(j([...s.flags, flag]), sid);
      },
      close(sid: string, recapCardId?: string): void {
        db.prepare(`UPDATE session SET ended_at = ?, recap_card_id = ? WHERE id = ?`).run(
          now(),
          recapCardId ?? null,
          sid,
        );
      },
    },

    turn: {
      create(input: Omit<Turn, 'id'> & { id?: string }): Turn {
        const row: Turn = {
          id: input.id ?? id(),
          session_id: input.session_id,
          seq: input.seq,
          speaker: input.speaker,
          text: input.text,
          asr_conf: input.asr_conf ?? null,
          retrieved_chunk_ids: input.retrieved_chunk_ids ?? [],
          flag: input.flag ?? null,
          latency_ms: input.latency_ms ?? null,
        };
        db.prepare(
          `INSERT INTO turn (id, session_id, seq, speaker, text, asr_conf, retrieved_chunk_ids, flag, latency_ms)
           VALUES (@id, @session_id, @seq, @speaker, @text, @asr_conf, @retrieved_chunk_ids, @flag, @latency_ms)`,
        ).run({
          id: row.id,
          session_id: row.session_id,
          seq: row.seq,
          speaker: row.speaker,
          text: cipher.encrypt(row.text),
          asr_conf: row.asr_conf,
          retrieved_chunk_ids: j(row.retrieved_chunk_ids),
          flag: row.flag,
          latency_ms: row.latency_ms,
        });
        return row;
      },
      listBySession(sid: string): Turn[] {
        const rows = db
          .prepare(`SELECT * FROM turn WHERE session_id = ? ORDER BY seq ASC`)
          .all(sid) as Record<string, string | number>[];
        return rows.map((r) => ({
          id: r.id as string,
          session_id: r.session_id as string,
          seq: r.seq as number,
          speaker: r.speaker as Turn['speaker'],
          text: cipher.decrypt(r.text as string) ?? '',
          asr_conf: (r.asr_conf as number) ?? null,
          retrieved_chunk_ids: p(r.retrieved_chunk_ids as string, []),
          flag: (r.flag as string) ?? null,
          latency_ms: (r.latency_ms as number) ?? null,
        }));
      },
      nextSeq(sid: string): number {
        const r = db.prepare(`SELECT MAX(seq) as m FROM turn WHERE session_id = ?`).get(sid) as {
          m: number | null;
        };
        return (r.m ?? 0) + 1;
      },
      /**
       * Record the headline per-turn latency (end-of-speech → first audio byte, ms)
       * on an existing turn (Task 13, R16.1). Written after the turn completes since
       * the figure is not known when the turn row is first inserted.
       */
      setLatency(tid: string, latencyMs: number): void {
        db.prepare(`UPDATE turn SET latency_ms = ? WHERE id = ?`).run(latencyMs, tid);
      },
    },

    card: {
      create(input: Omit<CardRecord, 'id' | 'created_at' | 'status'> & { id?: string; status?: CardRecord['status'] }): CardRecord {
        const row: CardRecord = {
          id: input.id ?? id(),
          session_id: input.session_id,
          type: input.type,
          title: input.title,
          body: input.body,
          action: input.action ?? null,
          status: input.status ?? 'active',
          created_at: now(),
        };
        db.prepare(
          `INSERT INTO card (id, session_id, type, title, body, action, status, created_at)
           VALUES (@id, @session_id, @type, @title, @body, @action, @status, @created_at)`,
        ).run({ ...row, action: row.action ? j(row.action) : null });
        return row;
      },
      get(cid: string): CardRecord | null {
        const r = db.prepare(`SELECT * FROM card WHERE id = ?`).get(cid) as Row | undefined;
        return r ? mapCard(r) : null;
      },
      listByStatus(status: CardRecord['status']): CardRecord[] {
        const rows = db.prepare(`SELECT * FROM card WHERE status = ? ORDER BY created_at DESC`).all(
          status,
        ) as Row[];
        return rows.map(mapCard);
      },
      /**
       * List the archived set — every card that has left `active` (i.e. `dismissed`
       * OR `done`), newest first. The lifecycle "active → dismissed | done →
       * archived" (design.md §Card service) has no distinct stored `archived` status:
       * the archive IS the union of the two terminal statuses, so voice/REST retrieval
       * of "archived" reads them together. Backs `GET /cards?status=archived` (R10.4).
       */
      listArchived(): CardRecord[] {
        const rows = db
          .prepare(
            `SELECT * FROM card WHERE status IN ('dismissed', 'done') ORDER BY created_at DESC`,
          )
          .all() as Row[];
        return rows.map(mapCard);
      },
      setStatus(cid: string, status: CardRecord['status']): void {
        db.prepare(`UPDATE card SET status = ? WHERE id = ?`).run(status, cid);
      },
    },

    kbChunk: {
      upsert(chunk: KbChunk): void {
        db.prepare(
          `INSERT INTO kb_chunk (id, diagnosis, source_url, title, content_md, embedding)
           VALUES (@id, @diagnosis, @source_url, @title, @content_md, @embedding)
           ON CONFLICT(id) DO UPDATE SET
             diagnosis=excluded.diagnosis, source_url=excluded.source_url,
             title=excluded.title, content_md=excluded.content_md, embedding=excluded.embedding`,
        ).run({
          id: chunk.id,
          diagnosis: chunk.diagnosis,
          source_url: chunk.source_url ?? null,
          title: chunk.title ?? null,
          content_md: chunk.content_md,
          embedding: chunk.embedding ? j(chunk.embedding) : null,
        });
      },
      listByDiagnosis(diagnosis: string): KbChunk[] {
        const rows = db.prepare(`SELECT * FROM kb_chunk WHERE diagnosis = ?`).all(diagnosis) as Row[];
        return rows.map((r) => ({
          id: s(r.id),
          diagnosis: r.diagnosis as KbChunk['diagnosis'],
          source_url: r.source_url != null ? String(r.source_url) : null,
          title: r.title != null ? String(r.title) : null,
          content_md: s(r.content_md),
          embedding: r.embedding ? (JSON.parse(String(r.embedding)) as number[]) : null,
        }));
      },
    },

    /** Deletes ALL caregiver data. Backs the one-click "delete everything" control. */
    deleteEverything(): void {
      const tx = db.transaction(() => {
        for (const t of ['card', 'turn', 'session', 'log_entry', 'appointment', 'patient', 'caregiver']) {
          db.prepare(`DELETE FROM ${t}`).run();
        }
      });
      tx();
    },
  };
}

function mapCard(r: Row): CardRecord {
  return {
    id: s(r.id),
    session_id: s(r.session_id),
    type: r.type as CardRecord['type'],
    title: s(r.title),
    body: s(r.body),
    action: r.action ? (JSON.parse(String(r.action)) as CardRecord['action']) : null,
    status: r.status as CardRecord['status'],
    created_at: s(r.created_at),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
