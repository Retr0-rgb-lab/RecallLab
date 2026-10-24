// RecallLab — Vercel entry point.
//
// Vercel's Express framework preset only auto-detects the app at:
//   app.js | index.js | server.js | src/app.js | src/index.js | src/server.js
// (a FILE named server.js inside src/ — not a server/ directory).
// Our Express app lives in server/, so this root-level server.js is the file
// Vercel traces. The default export is what Vercel runs as the Function.
//
// The local entry is server/index.js, which calls app.listen().
//
// See docs/specs/2026-10-24-recalllab-contracts.md section 2.2.
import app from './server/app.js';

export default app;
