/**
 * tests/schema.test.js — the schema is applied in BOTH database modes.
 *
 * The in-memory mode is exercised for real: a child process boots the client
 * with no `DATABASE_URL`, so pg-mem applies `schema.sql` and the `nodes` table
 * answers a query.
 *
 * The Postgres mode cannot be run against a real database here, so the `pg`
 * driver is replaced with a stub that records every statement it is given.
 * The test then asserts that the schema DDL is among them — issued on the
 * first connection, before any other statement.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/* ---------------------------------------------------------------------------
 * The stub `pg` driver
 * ------------------------------------------------------------------------ */

const STUB_PG = `
const statements = [];

export class Pool {
  constructor(options) {
    this.options = options;
    globalThis.__recalllabPgStatements = statements;
  }

  async query(text, params) {
    statements.push({ text: String(text), params: params ?? null });
    return { rows: [], rowCount: 0, command: 'SELECT', fields: [] };
  }

  async connect() {
    const pool = this;
    return {
      async query(text, params) {
        return pool.query(text, params);
      },
      release() {},
    };
  }

  async end() {}
}

export default { Pool };
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'pg') {
      return { url: 'recalllab-stub-pg', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'recalllab-stub-pg') {
      return { format: 'module', source: STUB_PG, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

/* ---------------------------------------------------------------------------
 * The schema file itself
 * ------------------------------------------------------------------------ */

test('the schema file is idempotent', async () => {
  const sql = await readFile(path.join(REPO, 'server', 'db', 'schema.sql'), 'utf8');
  assert.match(sql, /create table if not exists nodes/i);
  assert.match(sql, /create index if not exists nodes_parent_position_idx/i);
  assert.match(sql, /create index if not exists nodes_parent_idx/i);
  assert.doesNotMatch(sql, /create table nodes/i);
});

/* ---------------------------------------------------------------------------
 * Postgres mode — the stub driver records the DDL
 * ------------------------------------------------------------------------ */

test('the Postgres branch applies the schema on the first connection', async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://user:secret@127.0.0.1:5432/recalllab';

  try {
    const client = await import('../server/db/client.js');
    assert.equal(client.dbMode(), 'postgres', 'the module picked the Postgres branch');

    await client.query('select 1 from nodes limit 1');

    const statements = globalThis.__recalllabPgStatements ?? [];
    assert.ok(statements.length >= 2, 'the stub driver was called');

    const ddl = statements[0].text;
    assert.match(ddl, /create table if not exists nodes/i);
    assert.match(ddl, /create index if not exists nodes_parent_position_idx/i);
    assert.match(ddl, /create index if not exists nodes_parent_idx/i);

    /* The DDL comes first: the table exists before the first query runs. */
    assert.equal(statements[1].text, 'select 1 from nodes limit 1');
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

/* ---------------------------------------------------------------------------
 * In-memory mode — pg-mem applies the same file
 * ------------------------------------------------------------------------ */

test('the pg-mem branch applies the same schema and answers a query', () => {
  const script = `
    const client = await import('./server/db/client.js');
    const rows = await client.query('select id from nodes limit 3');
    process.stdout.write(JSON.stringify({ mode: client.dbMode(), rows: rows.length }));
  `;

  const env = { ...process.env };
  delete env.DATABASE_URL;

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });

  assert.equal(result.status, 0, `the in-memory client failed:\n${result.stderr}`);

  const outcome = JSON.parse(result.stdout.trim());
  assert.equal(outcome.mode, 'memory');
  assert.equal(outcome.rows, 0, 'the table exists and is empty before the seed');
});
