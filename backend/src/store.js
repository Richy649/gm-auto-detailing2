// backend/src/store.js
import { pool } from "./db.js";

/**
 * Creates the holds table if it does not exist.
 * We keep it minimal: start/end window + expiry for the hold.
 */
export async function initStore() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.booking_holds (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NULL,
      service_key TEXT NULL,
      start_time TIMESTAMPTZ NOT NULL,
      end_time   TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS booking_holds_time_idx
                    ON public.booking_holds (start_time, end_time);`);

  await pool.query(`CREATE INDEX IF NOT EXISTS booking_holds_expiry_idx
                    ON public.booking_holds (expires_at);`);
}

/**
 * Deletes any holds whose expiry has passed.
 * Returns number of rows deleted (for logging/observability).
 */
export async function cleanupExpiredHolds() {
  const r = await pool.query(
    `DELETE FROM public.booking_holds WHERE expires_at < now() RETURNING id`
  );
  const n = r.rowCount || 0;
  if (n) console.log(`[holds] cleaned ${n} expired holds`);
  return n;
}

/**
 * Returns busy intervals between [startISO, endISO) by combining:
 *   - confirmed bookings (public.bookings)
 *   - non-expired holds (public.booking_holds)
 *
 * Output format: Array<{ start: string, end: string }>
 * where start/end are ISO strings (UTC).
 */
export async function getBusyIntervals(startISO, endISO) {
  // Guard inputs
  if (!startISO || !endISO) return [];

  // Bookings that overlap the window
  const booked = await pool.query(
    `
    SELECT start_time, end_time
      FROM public.bookings
     WHERE start_time < $2
       AND end_time   > $1
    `,
    [startISO, endISO]
  );

  // Active holds that overlap the window
  const holds = await pool.query(
    `
    SELECT start_time, end_time
      FROM public.booking_holds
     WHERE expires_at > now()
       AND start_time < $2
       AND end_time   > $1
    `,
    [startISO, endISO]
  );

  // Normalize to ISO strings
  const toIsoPair = (row) => {
    // node-postgres returns TIMESTAMPTZ as string by default; be defensive either way.
    const s = typeof row.start_time === "string" ? row.start_time : new Date(row.start_time).toISOString();
    const e = typeof row.end_time   === "string" ? row.end_time   : new Date(row.end_time).toISOString();
    return { start: s, end: e };
  };

  const all = [
    ...(booked.rows || []).map(toIsoPair),
    ...(holds.rows  || []).map(toIsoPair),
  ];

  // Optional: merge overlaps to reduce noise for the availability combiner.
  // Simple O(n log n) merge by start time.
  all.sort((a, b) => new Date(a.start) - new Date(b.start));
  const merged = [];
  for (const iv of all) {
    if (!merged.length) { merged.push(iv); continue; }
    const last = merged[merged.length - 1];
    if (new Date(iv.start) <= new Date(last.end)) {
      // overlap → extend end if needed
      if (new Date(iv.end) > new Date(last.end)) last.end = iv.end;
    } else {
      merged.push(iv);
    }
  }

  return merged;
}
