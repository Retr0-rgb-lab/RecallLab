/**
 * server/shell.js — the SPA shell.
 *
 * The shell is read once, at module load, with the
 * `new URL('../public/index.html', import.meta.url)` form on purpose: it is
 * the pattern Vercel's file tracer understands, so `public/index.html` is
 * guaranteed to be inside the deployed function bundle (build contracts §2.2).
 *
 * A failed read must never crash the process at boot, so the read is guarded
 * and falls back to a minimal inline page that says the shell is missing.
 */

import fs from 'node:fs';

const FALLBACK_SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>RecallLab — shell missing</title>
    <style>
      body { font: 16px/1.6 system-ui, sans-serif; margin: 0; padding: 4rem 1.5rem; color: #1c1c1c; background: #f7f7f5; }
      main { max-width: 42rem; margin: 0 auto; }
      code { background: #ececea; padding: 0.15em 0.4em; border-radius: 4px; }
      h1 { font-size: 1.4rem; }
      p { color: #4a4a48; }
    </style>
  </head>
  <body>
    <main>
      <h1>RecallLab — the SPA shell is missing</h1>
      <p>
        <code>public/index.html</code> could not be read, so the single-page
        application cannot be served. The API under <code>/api</code> is
        unaffected.
      </p>
    </main>
  </body>
</html>
`;

function loadShell() {
  try {
    return fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  } catch (err) {
    console.warn(
      `[recalllab] could not read public/index.html (${err.message}); serving the fallback shell.`,
    );
    return FALLBACK_SHELL;
  }
}

/** The SPA shell HTML. */
export const shell = loadShell();

export default shell;
