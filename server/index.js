/**
 * server/index.js — the local entry point.
 *
 * `npm start` runs this file. The Vercel entry point is the root `server.js`,
 * which imports the same app without listening (build contracts §2.2).
 */

import app from './app.js';

const PORT = Number.parseInt(process.env.PORT ?? '', 10) || 3000;

app.listen(PORT, () => {
  console.log(`[recalllab] listening on http://localhost:${PORT}`);
});
