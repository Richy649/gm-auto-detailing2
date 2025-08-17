import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

// Preferred path:
// - If DATABASE_URL is set, use it (e.g. /data/data.db on Render)
// - Else, if running on Render, try /data/data.db
// - Else (local dev), use ./data/data.db
function pickDbPath() {
  const envPath = process.env.DATABASE_URL;
  if (envPath) return envPath;
  if (process.env.RENDER) return '/data/data.db';
  return './data/data.db';
}

function ensureDirOrFallback(targetPath) {
  let dbPath = targetPath;
  const dir = path.dirname(dbPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dbPath; // success
  } catch (e) {
    // If /data isn't available (no disk mounted), fall back to local ./data
    if (dbPath.startsWith('/data')) {
      dbPath = './data/data.db';
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      return dbPath;
    }
    throw e;
  }
}

let dbPath = ensureDirOrFallback(pickDbPath());
export const db = new Database(dbPath);

// Minimal schema
const schema = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  area TEXT NOT NULL,
  email TEXT
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  service_key TEXT NOT NULL,
  addons TEXT DEFAULT '[]',
  start_iso TEXT NOT NULL,
  end_iso TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(customer_id) REFERENCES customers(id)
);
`;
db.exec(schema);

console.log(`[DB] Using SQLite at: ${dbPath}`);
