import Database from 'better-sqlite3';
const dbPath = process.env.DATABASE_URL || './data.db';
export const db = new Database(dbPath);
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
