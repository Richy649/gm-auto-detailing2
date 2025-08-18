// backend/src/store.js
import { DateTime } from "luxon";
import { randomUUID } from "crypto";

// Optional Postgres (enabled only if DATABASE_URL starts with postgres:// or postgresql://)
let Pool = null;
try { ({ Pool } = await import("pg")); } catch { /* pg not installed? fine, use memory */ }

const TZ = "Europe/London";
const HOLD_MINUTES = 15;

// Decide whether to use Postgres
const RAW_DB_URL = (process.env.DATABASE_URL || "").trim();
const IS_PG_URL = /^postgres(ql)?:\/\//i.test(RAW_DB_URL);

// Shared state
let pool = null;

// Try to init Pool only for valid Postgres URLs
if (Pool && IS_PG_URL) {
  pool = new Pool({
    connectionString: RAW_DB_URL,
    ssl: { rejectUnauthorized: false }
  });
}

// ----- helpers -----
function nowUtc() { return DateTime.utc(); }
function toISO(dt) { return dt.toUTC().toISO(); }

// In-memory fallback
const mem = {
  bookings: [], // [{session_id, service_key, addons_json, customer_json, start_iso, end_iso, created_at}]
  holds: []     // [{hold_key, session_id, service_key, customer_json, start_iso, end_iso, expires_at, created_at}]
};

// Expose mode for health
export function dbMode() {
  return pool ? "postgres" : "memory";
}

// Boot PG schema if available
export async function initStore() {
  if (!pool) {
    if (RAW_DB_URL && !IS_PG_URL) {
      console.warn("[store] DATABASE_URL is set but not a postgres:// URL. Using in-memory store.");
    }
    return;
  }
  try {
    await pool.query(`
      create table if not exists bookings (
        id serial primary key,
        session_id text unique,
        service_key text not null,
        addons_json jsonb default '[]',
        customer_json jsonb default '{}',
        start_iso timestamptz not null,
        end_iso   timestamptz not null,
        created_at timestamptz not null default now()
      );
      create unique index if not exists bookings_slot_unique
        on bookings (start_iso, end_iso);

      create table if not exists holds (
        id serial primary key,
        hold_key uuid not null,
        session_id text,
        service_key text not null,
        customer_json jsonb default '{}',
        start_iso timestamptz not null,
        end_iso   timestamptz not null,
        expires_at timestamptz not null,
        created_at timestamptz not null default now()
      );
      create unique index if not exists holds_slot_unique
        on holds (start_iso, end_iso);
      create index if not exists holds_expires_idx
        on holds (expires_at);
    `);
  } catch (e) {
    console.warn("[store] Postgres init failed, falling back to memory:", e?.message || e);
    pool = null; // disable pg so we use memory for all ops
  }
}

export async function cleanupExpiredHolds() {
  const now = nowUtc().toISO();
  if (pool) {
    try {
      await pool.query("delete from holds where expires_at < $1", [now]);
      return;
    } catch (e) {
      console.warn("[store] cleanupExpiredHolds PG error, fallback to memory:", e?.message || e);
      pool = null;
    }
  }
  const n = DateTime.fromISO(now);
  mem.holds = mem.holds.filter(h => DateTime.fromISO(h.expires_at) > n);
}

export function newHoldKey() { return randomUUID(); }

export async function addHold({ hold_key, service_key, start_iso, end_iso, customer, session_id = null }) {
  const expires_at = toISO(nowUtc().plus({ minutes: HOLD_MINUTES }));
  if (pool) {
    try {
      await pool.query(
        `insert into holds (hold_key, session_id, service_key, customer_json, start_iso, end_iso, expires_at)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [hold_key, session_id, service_key, customer || {}, start_iso, end_iso, expires_at]
      );
      return { ok: true };
    } catch (e) {
      if (String(e.message || "").includes("holds_slot_unique")) {
        return { ok: false, conflict: true };
      }
      console.warn("[store] addHold PG error, fallback to memory:", e?.message || e);
      pool = null; // fallback to memory
      // continue into memory path below
    }
  }
  // Memory path
  const now = nowUtc();
  const hasHold = mem.holds.some(h =>
    h.start_iso === start_iso && h.end_iso === end_iso &&
    DateTime.fromISO(h.expires_at) > now
  );
  const hasBooking = mem.bookings.some(b => b.start_iso === start_iso && b.end_iso === end_iso);
  if (hasHold || hasBooking) return { ok: false, conflict: true };
  mem.holds.push({
    hold_key, session_id, service_key,
    customer_json: customer || {},
    start_iso, end_iso,
    expires_at,
    created_at: toISO(nowUtc())
  });
  return { ok: true };
}

export async function attachSessionToHolds(hold_key, session_id) {
  if (pool) {
    try {
      await pool.query("update holds set session_id=$1 where hold_key=$2", [session_id, hold_key]);
      return;
    } catch (e) {
      console.warn("[store] attachSessionToHolds PG error, fallback to memory:", e?.message || e);
      pool = null;
    }
  }
  mem.holds.forEach(h => { if (h.hold_key === hold_key) h.session_id = session_id; });
}

export async function releaseHoldsByKey(hold_key) {
  if (pool) {
    try {
      await pool.query("delete from holds where hold_key=$1", [hold_key]);
      return;
    } catch (e) {
      console.warn("[store] releaseHoldsByKey PG error, fallback to memory:", e?.message || e);
      pool = null;
    }
  }
  mem.holds = mem.holds.filter(h => h.hold_key !== hold_key);
}

export async function isSlotFree(start_iso, end_iso) {
  await cleanupExpiredHolds();
  if (pool) {
    try {
      const rb = await pool.query(
        "select 1 from bookings where start_iso=$1 and end_iso=$2 limit 1",
        [start_iso, end_iso]
      );
      if (rb.rowCount) return false;
      const rh = await pool.query(
        "select 1 from holds where start_iso=$1 and end_iso=$2 and expires_at > now() limit 1",
        [start_iso, end_iso]
      );
      return rh.rowCount === 0;
    } catch (e) {
      console.warn("[store] isSlotFree PG error, fallback to memory:", e?.message || e);
      pool = null;
    }
  }
  // Memory path
  const now = nowUtc();
  const hasBooking = mem.bookings.some(b => b.start_iso === start_iso && b.end_iso === end_iso);
  if (hasBooking) return false;
  const hasHold = mem.holds.some(h =>
    h.start_iso === start_iso && h.end_iso === end_iso &&
    DateTime.fromISO(h.expires_at) > now
  );
  return !hasHold;
}

export async function getBusyIntervals(startISO, endISO) {
  await cleanupExpiredHolds();
  if (pool) {
    try {
      const rb = await pool.query(
        "select start_iso as start, end_iso as end from bookings where end_iso >= $1 and start_iso <= $2",
        [startISO, endISO]
      );
      const rh = await pool.query(
        "select start_iso as start, end_iso as end from holds where expires_at > now() and end_iso >= $1 and start_iso <= $2",
        [startISO, endISO]
      );
      return [...rb.rows, ...rh.rows];
    } catch (e) {
      console.warn("[store] getBusyIntervals PG error, fallback to memory:", e?.message || e);
      pool = null;
    }
  }
  // Memory path
  const start = DateTime.fromISO(startISO);
  const end = DateTime.fromISO(endISO);
  const fromArr = (arr) => arr.filter(x => {
    const a = DateTime.fromISO(x.start_iso || x.start);
    const b = DateTime.fromISO(x.end_iso || x.end);
    return b >= start && a <= end;
  }).map(x => ({ start: x.start_iso || x.start, end: x.end_iso || x.end }));
  const holds = mem.holds.filter(h => DateTime.fromISO(h.expires_at) > nowUtc());
  return [...fromArr(mem.bookings), ...fromArr(holds)];
}

export async function promoteHoldsToBookingsBySession(session_id, metadata) {
  if (pool) {
    try {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const { rows: holds } = await client.query("select * from holds where session_id=$1", [session_id]);
        for (const h of holds) {
          await client.query(
            `insert into bookings (session_id, service_key, addons_json, customer_json, start_iso, end_iso)
             values ($1,$2,$3,$4,$5,$6)
             on conflict (session_id) do nothing`,
            [session_id, metadata.service_key, metadata.addons || [], metadata.customer || {}, h.start_iso, h.end_iso]
          );
        }
        await client.query("delete from holds where session_id=$1", [session_id]);
        await client.query("commit");
      } catch (e) {
        await client.query("rollback");
        throw e;
      } finally {
        client.release();
      }
      return;
    } catch (e) {
      console.warn("[store] promoteHoldsToBookingsBySession PG error, fallback to memory:", e?.message || e);
      pool = null;
    }
  }
  // Memory path
  const holds = mem.holds.filter(h => h.session_id === session_id);
  for (const h of holds) {
    if (!mem.bookings.some(b => b.start_iso === h.start_iso && b.end_iso === h.end_iso)) {
      mem.bookings.push({
        session_id,
        service_key: metadata.service_key,
        addons_json: metadata.addons || [],
        customer_json: metadata.customer || {},
        start_iso: h.start_iso,
        end_iso: h.end_iso,
        created_at: toISO(nowUtc())
      });
    }
  }
  mem.holds = mem.holds.filter(h => h.session_id !== session_id);
}
