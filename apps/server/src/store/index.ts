import { openDatabase, type DB } from './db.js';
import { createCipher } from './crypto.js';
import { createRepositories, type Repositories } from './repositories.js';

export interface Store {
  db: DB;
  repos: Repositories;
}

export function createStore(dbPath: string, encryptionKey: string): Store {
  const db = openDatabase(dbPath);
  const cipher = createCipher(encryptionKey);
  const repos = createRepositories(db, cipher);
  return { db, repos };
}

export type { Repositories } from './repositories.js';
export { createCipher } from './crypto.js';
