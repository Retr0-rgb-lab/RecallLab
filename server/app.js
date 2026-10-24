/**
 * server/app.js — builds and exports the Express app.
 *
 * There is deliberately **no** `listen()` call here: `server/index.js` is the
 * local entry point and the root `server.js` is the Vercel entry point
 * (build contracts §2.2).
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { router, HttpError } from './routes/nodes.js';
import shell from './shell.js';
import { dbMode } from './db/client.js';
import { seed } from './db/seed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

export const app = express();

app.disable('x-powered-by');

/* JSON body parsing. */
app.use(express.json({ limit: '256kb' }));

/* The REST API. */
app.use('/api', router);

/*
 * Static assets. Vercel ignores express.static() and serves public/** from
 * its CDN, but the middleware is required for local development and for the
 * Render/Fly path (build contracts §2.2).
 */
app.use(express.static(publicDir));

/*
 * SPA fallback: every non-API GET returns the shell so the client router can
 * resolve deep links such as /f/<folderId>. Express 5 has no string
 * wildcards, so the catch-all is a regular expression.
 */
app.get(/.*/, (req, res, next) => {
  if (req.path === '/api' || req.path.startsWith('/api/')) return next();
  res.type('html').send(shell);
});

/*
 * The explicit error-handling middleware (build contracts §2.2). Express
 * swallows errors and renders its own 500, which can stop Vercel from
 * recycling the function, so this handler must exist — and it must be the
 * LAST middleware in the chain.
 */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message },
    });
  }

  // Malformed JSON is a client mistake, not an internal failure.
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    return res.status(400).json({
      error: { code: 'invalid_request', message: 'Malformed request body.' },
    });
  }

  console.error(err);
  res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
});

/*
 * Development convenience: with no DATABASE_URL the app runs on pg-mem, an
 * in-memory database that starts empty on every boot. Applying the Lecture 01
 * tree here means `npm start` shows the real course structure. The seed is
 * guarded by a marker row, so it never duplicates anything.
 */
if (dbMode() === 'memory') {
  try {
    const outcome = await seed();
    if (outcome.applied) {
      console.log(`[recalllab] seeded the development database (${outcome.nodes} nodes).`);
    }
  } catch (err) {
    console.warn(`[recalllab] development seed failed: ${err.message}`);
  }
}

export default app;
