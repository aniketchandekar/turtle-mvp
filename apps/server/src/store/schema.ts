/**
 * SQLite schema (§18 of the technical spec). Kept Postgres-migratable: TEXT ids,
 * ISO8601 timestamps as TEXT, JSON stored as TEXT. Encrypted fields hold ciphertext
 * strings (see crypto.ts).
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS caregiver (
  id            TEXT PRIMARY KEY,
  display_name  TEXT,
  created_at    TEXT NOT NULL,
  consent_at    TEXT,
  prefs         TEXT NOT NULL DEFAULT '{}'
);

-- The full record is encrypted as one versioned JSON document. Keeping only the
-- caregiver key and timestamps in plaintext makes resume lookup cheap without
-- exposing intake answers to database inspection.
CREATE TABLE IF NOT EXISTS onboarding_profile (
  caregiver_id  TEXT PRIMARY KEY REFERENCES caregiver(id),
  version       INTEGER NOT NULL,
  profile       TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Append-only consent evidence. Evidence and authority details are encrypted;
-- type/action/timestamp remain queryable for current-consent calculation and audit.
CREATE TABLE IF NOT EXISTS consent_record (
  id                  TEXT PRIMARY KEY,
  caregiver_id        TEXT NOT NULL REFERENCES caregiver(id),
  consent_type        TEXT NOT NULL,
  action              TEXT NOT NULL,
  actor               TEXT NOT NULL,
  authority_basis     TEXT,
  subject             TEXT NOT NULL,
  capture_method      TEXT NOT NULL,
  disclosure_version  TEXT NOT NULL,
  locale              TEXT NOT NULL,
  captured_at         TEXT NOT NULL,
  evidence            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consent_caregiver_type_at
  ON consent_record(caregiver_id, consent_type, captured_at);

CREATE TABLE IF NOT EXISTS patient (
  id               TEXT PRIMARY KEY,
  caregiver_id     TEXT NOT NULL REFERENCES caregiver(id),
  name             TEXT NOT NULL,
  diagnosis        TEXT NOT NULL,
  diagnosis_notes  TEXT,
  care_team        TEXT NOT NULL DEFAULT '{}'  -- encrypted JSON (contacts)
);

CREATE TABLE IF NOT EXISTS appointment (
  id          TEXT PRIMARY KEY,
  patient_id  TEXT NOT NULL REFERENCES patient(id),
  title       TEXT NOT NULL,
  with_whom   TEXT,
  at          TEXT NOT NULL,
  purpose     TEXT,
  status      TEXT NOT NULL DEFAULT 'upcoming'
);
CREATE INDEX IF NOT EXISTS idx_appointment_patient_at ON appointment(patient_id, at);

CREATE TABLE IF NOT EXISTS log_entry (
  id          TEXT PRIMARY KEY,
  patient_id  TEXT NOT NULL REFERENCES patient(id),
  at          TEXT NOT NULL,
  category    TEXT NOT NULL,
  text        TEXT NOT NULL,             -- encrypted verbatim text
  structured  TEXT
);
CREATE INDEX IF NOT EXISTS idx_log_patient_at ON log_entry(patient_id, at);

CREATE TABLE IF NOT EXISTS session (
  id                TEXT PRIMARY KEY,
  caregiver_id      TEXT NOT NULL REFERENCES caregiver(id),
  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  mode_transitions  TEXT NOT NULL DEFAULT '[]',
  flags             TEXT NOT NULL DEFAULT '[]',
  recap_card_id     TEXT
);

CREATE TABLE IF NOT EXISTS turn (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES session(id),
  seq                  INTEGER NOT NULL,
  speaker              TEXT NOT NULL,
  text                 TEXT NOT NULL,     -- encrypted transcript text
  asr_conf             REAL,
  retrieved_chunk_ids  TEXT NOT NULL DEFAULT '[]',
  flag                 TEXT,
  latency_ms           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_turn_session_seq ON turn(session_id, seq);

CREATE TABLE IF NOT EXISTS card (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES session(id),
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  action      TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_card_status ON card(status);

CREATE TABLE IF NOT EXISTS kb_chunk (
  id          TEXT PRIMARY KEY,
  diagnosis   TEXT NOT NULL,
  source_url  TEXT,
  title       TEXT,
  content_md  TEXT NOT NULL,
  embedding   TEXT               -- JSON array of floats, or NULL for lexical fallback
);
CREATE INDEX IF NOT EXISTS idx_kb_diagnosis ON kb_chunk(diagnosis);
`;
