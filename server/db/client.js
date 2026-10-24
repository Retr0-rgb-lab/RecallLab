/**
 * server/db/client.js — the single query gateway.
 *
 * Every SQL statement in RecallLab goes through this module. The route layer
 * imports `query` and `withTransaction` from here and never imports `pg` or
 * `pg-mem` directly (build contracts §2.1).
 *
 * Mode selection (build contracts §2.1):
 *
 *   process.env.DATABASE_URL set -> real Postgres through `pg`
 *   otherwise                    -> pg-mem, an in-memory Postgres, for
 *                                   development with zero external services
 *
 * Both modes expose the identical surface:
 *
 *   query(text, params)          -> Promise<rows>
 *   withTransaction(fn)          -> Promise<result>
 *
 * `pg-mem` is imported dynamically and only inside the memory branch, so a
 * production bundle that does not install devDependencies still boots.
 *
 * The schema (`schema.sql`) is applied in BOTH modes: to pg-mem when the
 * in-memory database is created, and to Postgres on the first connection. The
 * DDL is idempotent, so applying it on every boot never breaks an existing
 * database.
 */

import fs from 'node:fs';

const MODE = process.env.DATABASE_URL ? 'postgres' : 'memory';

/** @returns {'postgres'|'memory'} which database backend is in use. */
export function dbMode() {
  return MODE;
}

let backendPromise = null;

/**
 * The schema, read from disk.
 *
 * The file is idempotent (`create table if not exists`), so the same text is
 * applied to pg-mem and to a real Postgres database, on every boot.
 *
 * @returns {string} the SQL of `schema.sql`
 */
function readSchema() {
  return fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
}

/**
 * Build the backend once, lazily, so importing this module never performs
 * I/O at import time in the Postgres case.
 */
async function createBackend() {
  if (MODE === 'postgres') {
    const { Pool } = await import('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 1, // one connection per serverless function instance
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });

    /*
     * The schema is applied on the first connection. A fresh database has no
     * `nodes` table, and every request against it would fail with
     * `relation "nodes" does not exist`. The DDL is idempotent, so applying it
     * on every boot is safe: an existing database is left exactly as it is.
     *
     * The whole file is sent as one simple query — Postgres runs the
     * statements in order, and `pg` allows several statements in one query
     * when no parameters are bound.
     */
    try {
      await pool.query(readSchema());
    } catch (err) {
      await pool.end().catch(() => {});
      throw new Error(
        `[recalllab] could not apply the schema to the Postgres database: ${err.message}`,
      );
    }

    return { pool, memDb: null };
  }

  const { newDb, DataType } = await import('pg-mem');
  const memDb = newDb({ autoCreateForeignKeyIndices: true });

  // pg-mem implements only a fraction of Postgres' built-in functions. The
  // schema's title check uses `length(btrim(title))`; both are registered here
  // so schema.sql can stay identical to the design spec §5.1.
  memDb.public.registerFunction({
    name: 'btrim',
    args: [DataType.text],
    returns: DataType.text,
    implementation: (value) =>
      value === null || value === undefined ? null : String(value).trim(),
  });
  memDb.public.registerFunction({
    name: 'length',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (value) =>
      value === null || value === undefined ? null : String(value).length,
  });

  const schema = readSchema();
  memDb.public.none(schema);

  // The pg adapter gives pg-mem the same `pg` driver surface as production.
  const adapter = memDb.adapters.createPg();
  return { pool: new adapter.Pool(), memDb };
}

function getBackend() {
  if (!backendPromise) {
    backendPromise = createBackend().catch((err) => {
      backendPromise = null; // allow a later retry
      throw err;
    });
  }
  return backendPromise;
}

/**
 * Run a parameterised statement.
 *
 * @param {string} text SQL with $1..$n placeholders.
 * @param {unknown[]} [params] Bound values.
 * @returns {Promise<object[]>} the result rows.
 */
export async function query(text, params = []) {
  const backend = await getBackend();
  const result = await backend.pool.query(text, params);
  return result.rows;
}

/**
 * Run `fn` inside a transaction.
 *
 * `fn` receives a transaction handle with the same `query(text, params)`
 * surface, so every statement it issues joins the transaction.
 *
 * In memory mode pg-mem's pg adapter runs each statement in its own
 * transaction, so BEGIN/ROLLBACK alone cannot undo a partial write. The
 * in-memory database is therefore snapshotted before the transaction and
 * restored when it fails, which gives memory mode the same all-or-nothing
 * guarantee as Postgres.
 *
 * @param {(tx: {query: (text: string, params?: unknown[]) => Promise<object[]>}) => Promise<unknown>} fn
 * @returns {Promise<unknown>} whatever `fn` returns.
 */
export async function withTransaction(fn) {
  const backend = await getBackend();
  const client = await backend.pool.connect();
  const tx = {
    query: async (text, params = []) => (await client.query(text, params)).rows,
  };
  const backup = backend.memDb ? backend.memDb.backup() : null;

  try {
    await client.query('BEGIN');
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the connection may already be unusable; the restore below still runs */
    }
    if (backup) {
      try {
        backup.restore();
      } catch {
        /* best effort — the original error is the one that matters */
      }
    }
    throw err;
  } finally {
    client.release();
  }
}
