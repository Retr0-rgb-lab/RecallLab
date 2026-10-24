/**
 * server/db/seed.js — the COMP3421 Lecture 01 tree.
 *
 * The tree reproduces the course structure of design spec §5.4. Every card
 * carries a real prompt and a real answer written from the content of
 * `docs/Lecture_01_Overview.pptx` (29 slides: the client-server model, HTTP
 * and URLs, Node.js, Express/REST/CRUD, advanced integration, performance and
 * optimisation, the five-layer request path and the week-by-week plan).
 *
 * Idempotency: the seed is guarded by a marker row — the root `COMP3421`
 * node has a fixed id, so re-running the script finds the marker and does
 * nothing. A redeploy can never duplicate the tree.
 *
 * `npm run seed` runs this file. It applies to whatever database
 * `DATABASE_URL` points at; with no `DATABASE_URL` it applies to the
 * in-memory development database, which is discarded when the process exits
 * (the app re-applies the same seed at boot in that mode).
 */

import { pathToFileURL } from 'node:url';

import { query, withTransaction, dbMode } from './client.js';
import { insertNode, getTree } from './queries.js';

/** The marker row: the root of the seeded tree has a fixed id. */
const MARKER_ID = 'c0de0001-0000-4000-8000-000000000000';

const UUID_PREFIX = 'c0de';

/** Deterministic id for a node, so the seed is reproducible. */
function nodeId(group, index) {
  return `${UUID_PREFIX}000${group}-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

const TREE = [
  {
    id: nodeId(1, 0),
    title: 'COMP3421',
    children: [
      {
        id: nodeId(1, 1),
        title: '01 The Big Picture',
        children: [
          {
            id: nodeId(1, 2),
            title: 'Client–Server Model',
            body: 'In the client–server model, what does the client do, what does the server do, and what do the two of them speak to each other?',
            answer:
              'The client is the browser: it renders pages and runs JavaScript — HTML for structure, CSS for style, JS for behaviour. The server is the web server: it stores resources, serving files and running the application logic, and it answers every request. The relationship is one-to-many: thousands of clients can talk to the same server. Client and server speak one language — HTTP — which you master in Week 9.',
          },
          {
            id: nodeId(1, 3),
            title: 'One Request End to End',
            body: 'Six steps happen every time you type a URL. What is the one loop that runs, worldwide, millions of times per second?',
            answer:
              'One loop, every time — request in, response out. Six steps happen each time you type a URL: the web is this loop running millions of times per second, worldwide. The request carries a method, a URL and headers; the server answers with a status, headers and a body. HTTP is dissected in Week 9.',
          },
          {
            id: nodeId(1, 4),
            title: 'The Stack Layer by Layer',
            body: 'Every web application is three layers talking to each other. Name them, and say what each one does.',
            answer:
              'CLIENT — the browser (HTML, CSS, JavaScript): renders pages and captures input. SERVER — Node.js / Express: logic, routes and APIs; answers requests and runs code. DATABASE — SQL / NoSQL: your application’s data; stores, queries and returns rows. The client sends an HTTP request, the server replies with an HTTP response, and the server talks to the database with a SQL query that comes back as data rows. The web is distributed: client and server may be continents apart — they only need a network. You build all three layers this semester.',
          },
        ],
      },
      {
        id: nodeId(2, 0),
        title: '02 Front-End',
        children: [
          {
            id: nodeId(2, 1),
            title: 'HTML',
            body: 'What is HTML, what problem does it solve, how do you write it, and what can it do?',
            answer:
              'HTML is the language that gives a page its structure and meaning. It solves the problem that raw text has no shape — HTML turns it into a tree of elements the browser can render and search engines can read. You write it with tags that wrap content — <h1>, <p>, <a>, <img>… — closed in reverse order of opening so that they nest properly. It can do forms, links, images, accessibility, and even vector graphics with <svg>. Week 2: elements, the DOM, forms and SVG, with examples you edit live.',
          },
          {
            id: nodeId(2, 2),
            title: 'CSS',
            body: 'What is CSS, what problem does it solve, and what shape is a CSS rule?',
            answer:
              'CSS is the language that controls how a page looks. It solves the problem that plain HTML looks the same everywhere — CSS separates presentation, so the same page can look any way you (or your designer) want. You write it as rules of the form selector { property: value; } — one rule per style, stacked in cascade order. It can do layout, colour, typography, motion and responsive design — Flexbox, Grid, media queries, custom properties. Weeks 3–5: selectors and cascade, the box model, then Flexbox, Grid and animation.',
          },
          {
            id: nodeId(2, 3),
            title: 'JavaScript',
            body: 'What is JavaScript, what problem does it solve, and which version of the language does the course use?',
            answer:
              'JavaScript is the language that makes a page interactive. It solves the problem that static pages cannot react to users — JS listens, computes and updates the page in place, without a full reload. The course uses modern ES6+: const, arrow functions, template strings, modules, async/await — the language of the browser. It can do click handlers, fetch data from servers, animate, build full single-page apps — anything a user can do. Weeks 6–8: ES6+, the DOM, events, then async and fetch.',
          },
          {
            id: nodeId(2, 4),
            title: 'DevTools',
            body: 'Which DevTools panels do you use for inspecting and debugging a page, and what does each one give you?',
            answer:
              'Elements / Inspector: see the HTML and the applied CSS together, edit styles live in the panel, and understand layout with the box model, Flexbox and Grid overlays. Console: run JS, see errors, log values while debugging. Network tab: watch every request and response your page makes. The whole stack is visible — headers, status codes, timings — from Week 2 on. If you learn one habit this semester, make it this: inspect everything.',
          },
        ],
      },
      {
        id: nodeId(3, 0),
        title: '03 Back-End',
        children: [
          {
            id: nodeId(3, 1),
            title: 'Part I — Node.js Runtime',
            children: [],
          },
          {
            id: nodeId(3, 2),
            title: 'Part II — Express · REST · CRUD & Data',
            children: [],
          },
          {
            id: nodeId(3, 3),
            title: 'Part III — Advanced Integration',
            children: [],
          },
          {
            id: nodeId(3, 4),
            title: 'Part IV — Performance & Optimization',
            children: [],
          },
          {
            id: nodeId(3, 5),
            title: 'HTTP',
            body: 'What does an HTTP request consist of, and what does an HTTP response consist of?',
            answer:
              'A request has a start line (GET /index.html HTTP/1.1), headers (Host, User-Agent, Accept, Cookie…) and sometimes a body (form data, JSON — when you POST). A response has a status line (HTTP/1.1 200 OK — or 404, 500…), headers (Content-Type, Set-Cookie, Cache-Control…) and a body (the HTML, JSON, image or file you asked for). One protocol, every exchange, all semester — Week 9 goes deep.',
          },
          {
            id: nodeId(3, 6),
            title: 'URLs',
            body: 'What are the parts of a URL, and what does each part do?',
            answer:
              'Take https://www.polyu.edu.hk:443/comp3421/week1?q=web#top. The scheme is how to talk (https — secure; also http, file…). The host or domain says which machine (www.polyu.edu.hk). The port says which door (:443). The path says which resource (/comp3421/week1…). The query carries extra parameters (?q=web, or ?q=web&lang=en). The fragment marks a place inside the resource (#top). Every piece has a job — and the browser hides all of it in the address bar. Week 9: URL anatomy in depth, and how to build them properly.',
          },
        ],
      },
      {
        id: nodeId(4, 0),
        title: '04 The Journey',
        children: [
          {
            id: nodeId(4, 1),
            title: 'Personal Site Architecture',
            body: 'What is the simplest real website one person can run, and what happens on a visit to it?',
            answer:
              'Just one of each: one browser, one domain, one server (files + CMS), one database. A visit goes: Visitor → HTTPS → DNS → Website files → Database. It is the smallest architecture that is still a real website, and every large-scale architecture grows out of it.',
          },
          {
            id: nodeId(4, 2),
            title: 'Large-Scale Deployment',
            body: 'What is a large-scale website, which components make it up, and how are they organised into layers?',
            answer:
              'A large website is not one program on one machine — it is a collection of distributed services working together for scale, availability and speed. The components: DNS; the user’s browser; load balancer; web app servers; caching service; message queue; job servers / workers; full-text search service; microservices / services; analytics / data pipeline; data warehouse; cloud storage; and the CDN. They organise into five layers: User → Traffic Management → Application → Data & Services → Cloud & CDN.',
          },
          {
            id: nodeId(4, 3),
            title: 'Five Layers',
            body: 'A request visits five layers on its way through the stack. What is in each layer, and what does that layer do?',
            answer:
              '1 User’s browser — your computer, phone, IoT, anything HTTP speaks; renders HTML/CSS/JS, runs JavaScript and talks to servers; the origin of every request. 2 Traffic management — DNS resolves the domain to an IP, the load balancer spreads traffic across web servers, the CDN serves static files from edge servers near users; spread, secure, accelerate. 3 Application — web app servers run your code, job queues and workers handle async tasks, a full-text search service answers keyword queries; execute the business logic. 4 Data & services — the database stores persistent state, a caching service holds hot data (Redis), microservices cover auth, payment and messaging; persist, retrieve, search. 5 Cloud & CDN — object storage for files and backups, a data warehouse for analytics, a pipeline streaming events to BI dashboards; bytes at scale, insights. Eleven moving parts, five layers, one journey per request.',
          },
          {
            id: nodeId(4, 4),
            title: 'Scale Each Piece Independently',
            body: 'What breaks first as traffic grows, and how do you scale each piece of the stack independently?',
            answer:
              'Web traffic increases → add more web app servers behind the same load balancer; applications are stateless. The database is the bottleneck → introduce a caching service (Redis) or database replicas, so reads fan out while writes stay. Latency for far-away users → push a CDN to the edge, so static assets and even API responses are hit from a nearby node. Async or heavy work piles up → move it to a job queue and job servers, keeping the user-facing path fast. Each component grows on its own: web: +1 server | data: +Redis | edge: +CDN node | async: +1 worker.',
          },
        ],
      },
      {
        id: nodeId(5, 0),
        title: '05 Wrap-Up & Takeaways',
        children: [
          {
            id: nodeId(5, 1),
            title: 'Week by Week',
            body: 'What do you build in each week of the course?',
            answer:
              'Weeks 2–5, HTML + CSS: Week 2 HTML — structure and forms; Week 3 CSS — selectors and cascade; Week 4 CSS — layout and responsive; Week 5 CSS — Flexbox, Grid and motion. Weeks 6–8, JavaScript: Week 6 ES6+ and the DOM; Week 7 functions, closures and classes; Week 8 async, fetch and AJAX. Weeks 9–11, HTTP + Node: Week 9 the HTTP protocol and URLs; Week 10 Node.js and npm; Week 11 Express, REST and databases. Weeks 12–13, full-stack: Week 12 WebSocket, SPA and deployment; Week 13 performance and optimisation. Tentative — the lab column in the course overview has the full list.',
          },
          {
            id: nodeId(5, 2),
            title: 'By the End of Week 13',
            body: 'What will you be able to do by the end of Week 13?',
            answer:
              'Build a complete web application — and explain every layer of it. Design the stack: choose front-end, back-end and database, and justify the choice. Build the front-end: semantic HTML, modern CSS, interactive JavaScript. Build the back-end: a Node.js + Express REST API talking to a database. Connect them: fetch, JSON and HTTP done properly. Ship it: deploy to the cloud with a real URL. Make it fast: caching, CDN and performance fundamentals. Your final project proves all of it.',
          },
          {
            id: nodeId(5, 3),
            title: 'Key Takeaways',
            body: 'What are the five things to take away from Lecture 1?',
            answer:
              '1. The web is three layers — browser, server, database — talking HTTP. 2. Front-end is HTML (structure) + CSS (presentation) + JS (behaviour). 3. Back-end is Node.js + Express + a database — the same JavaScript. 4. A real website is many distributed services, each scaling on its own. 5. This semester you build every layer and ship a real app. Next week: HTML — structure, DevTools and forms.',
          },
        ],
      },
    ],
  },
];

/**
 * Flatten the tree into rows, assigning the position of every node within its
 * level. Folders come first in each level, matching the server-enforced
 * ordering.
 *
 * @returns {{id: string, parentId: string|null, kind: string, title: string, body: string, answer: string, position: number}[]}
 */
function flatten(nodes, parentId = null) {
  const rows = [];
  // A node that carries a `children` array is a folder (the array may be
  // empty); a node without one is a card.
  const ordered = [
    ...nodes.filter((node) => node.children !== undefined),
    ...nodes.filter((node) => node.children === undefined),
  ];

  ordered.forEach((node, index) => {
    rows.push({
      id: node.id,
      parentId,
      kind: node.children !== undefined ? 'folder' : 'card',
      title: node.title,
      body: node.body ?? '',
      answer: node.answer ?? '',
      position: index,
    });
    if (node.children) {
      rows.push(...flatten(node.children, node.id));
    }
  });

  return rows;
}

/**
 * Apply the seed. Safe to call repeatedly: the marker row stops it from
 * running twice.
 *
 * @returns {Promise<{applied: boolean, nodes: number, reason?: string}>}
 */
export async function seed() {
  const marker = await query('select id from nodes where id = $1', [MARKER_ID]);
  if (marker.length > 0) {
    return { applied: false, nodes: (await getTree()).length, reason: 'already seeded' };
  }

  const rows = flatten(TREE);

  await withTransaction(async (tx) => {
    for (const row of rows) {
      await insertNode(row, tx);
    }
  });

  return { applied: true, nodes: rows.length };
}

/* Run directly: `npm run seed`. */
const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  try {
    const outcome = await seed();
    if (outcome.applied) {
      console.log(
        `[recalllab] seeded ${outcome.nodes} nodes into the ${dbMode()} database.`,
      );
      if (dbMode() === 'memory') {
        console.log(
          '[recalllab] DATABASE_URL is not set: this is the in-memory development ' +
            'database, so the tree is discarded when this process exits. The app ' +
            're-applies the same seed at boot.',
        );
      }
    } else {
      console.log(
        `[recalllab] the ${dbMode()} database is already seeded (${outcome.nodes} nodes) — nothing to do.`,
      );
    }
  } catch (err) {
    console.error('[recalllab] seed failed:', err);
    process.exitCode = 1;
  }
}
