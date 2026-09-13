import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_SQL } from './schema.js';

export type DB = Database.Database;

/**
 * Open (creating if needed) the SQLite database and apply the schema. Enables WAL
 * for better concurrent read/write behavior and foreign keys for integrity.
 */
export function openDatabase(dbPath: string): DB {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}
