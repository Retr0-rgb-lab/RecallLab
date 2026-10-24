#!/usr/bin/env bash
#
# scripts/deploy.sh — RecallLab deployment to Vercel.
#
#   bash scripts/deploy.sh [options]
#
# The script is idempotent: the seed is guarded by a marker row, and the
# environment variables are written with `vercel env add --force`, so running
# it twice changes nothing.
#
# Steps, in order:
#   1. preflight   — the Vercel CLI is on PATH, `vercel whoami` succeeds, and
#                    the directory is linked to a Vercel project
#   2. database    — DATABASE_URL is required (environment or a local .env);
#                    a deployed app without a database is worse than no deploy
#   3. schema      — the `nodes` table is created from server/db/schema.sql
#                    if the target database does not have it yet
#   4. seed        — `node server/db/seed.js` against that database. Vercel
#                    cannot run it, so it has to run from a machine that has
#                    the connection string
#   5. environment — `vercel env add DATABASE_URL production` and, when
#                    CRON_SECRET is set, `vercel env add CRON_SECRET production`
#   6. deploy      — `vercel --prod`
#   7. checklist   — what to open and check afterwards
#
# Options:
#   --skip-schema      do not create the `nodes` table if it is missing
#   --skip-seed        do not run the seed against the target database
#   --skip-env         do not write the Vercel production env variables
#   --skip-deploy      stop after the env variables; do not run `vercel --prod`
#   --skip-preflight   skip the Vercel CLI / auth / project-link checks
#   -h, --help         print this help
#
# Requirements:
#   - the Vercel CLI on PATH      npm i -g vercel
#   - an authenticated account    vercel login
#   - a linked Vercel project     vercel link
#   - DATABASE_URL in the environment, or in a .env file next to package.json
#
set -euo pipefail

# ---------------------------------------------------------------- location --

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# ------------------------------------------------------------------ options --

SKIP_SCHEMA=0
SKIP_SEED=0
SKIP_ENV=0
SKIP_DEPLOY=0
SKIP_PREFLIGHT=0

usage() {
  sed -n '2,38p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-schema) SKIP_SCHEMA=1; shift ;;
    --skip-seed) SKIP_SEED=1; shift ;;
    --skip-env) SKIP_ENV=1; shift ;;
    --skip-deploy) SKIP_DEPLOY=1; shift ;;
    --skip-preflight) SKIP_PREFLIGHT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown option: %s (try --help)\n' "$1" >&2; exit 2 ;;
  esac
done

# ------------------------------------------------------------------ helpers --

info() { printf '\n== %s ==\n' "$1"; }
note() { printf '    %s\n' "$1"; }
die() {
  printf '\nERROR: %s\n' "$1" >&2
  if [ "$#" -ge 2 ]; then
    printf '\n%s\n' "$2" >&2
  fi
  exit 1
}

# Read a key from a .env file (values may be quoted).
read_dotenv() {
  local key="$1" file="$2" value
  [ -f "${file}" ] || return 1
  value="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "${file}" | tail -n 1)"
  value="${value%$'\r'}"
  value="${value%"${value##*[![:space:]]}"}"
  if [ "${#value}" -ge 2 ]; then
    if [ "${value:0:1}" = '"' ] && [ "${value: -1}" = '"' ]; then
      value="${value:1:${#value}-2}"
    elif [ "${value:0:1}" = "'" ] && [ "${value: -1}" = "'" ]; then
      value="${value:1:${#value}-2}"
    fi
  fi
  [ -n "${value}" ] || return 1
  printf '%s' "${value}"
}

printf 'RecallLab — deployment\n'
printf 'repo:   %s\n' "${REPO_ROOT}"

# ------------------------------------------------------------- 1. preflight --

if [ "${SKIP_PREFLIGHT}" -eq 0 ]; then
  info "preflight"

  if ! command -v vercel > /dev/null 2>&1; then
    die "the Vercel CLI is not on PATH." \
      "Install it and try again:

    npm i -g vercel        # or: npx vercel --version"
  fi
  note "vercel: $(command -v vercel)"

  if ! WHOAMI="$(vercel whoami 2>&1)"; then
    die "the Vercel CLI is not authenticated (vercel whoami failed)." \
      "Log in and try again:

    vercel login

${WHOAMI}"
  fi
  note "logged in as: ${WHOAMI}"

  if [ ! -f "${REPO_ROOT}/.vercel/project.json" ]; then
    die "this directory is not linked to a Vercel project (.vercel/project.json is missing)." \
      "Link it and try again:

    vercel link

If the account has more than one scope, add it explicitly:

    vercel link --scope <team-slug>"
  fi
  note "project: $(sed -n 's/.*"projectId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${REPO_ROOT}/.vercel/project.json")"
fi

# ------------------------------------------------------------- 2. the database --

info "database"

if [ -z "${DATABASE_URL:-}" ]; then
  if DATABASE_URL="$(read_dotenv DATABASE_URL "${REPO_ROOT}/.env")"; then
    note "DATABASE_URL read from ${REPO_ROOT}/.env"
  else
    DATABASE_URL=""
  fi
fi

if [ -z "${DATABASE_URL}" ]; then
  die "DATABASE_URL is not set, and there is no DATABASE_URL in ${REPO_ROOT}/.env." \
    "The deploy is refused on purpose: an app without a database is worse than
no deploy. Set the pooled Supabase connection string and try again:

    export DATABASE_URL='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres'

or add it to ${REPO_ROOT}/.env (that file is git-ignored)."
fi

case "${DATABASE_URL}" in
  *:6543/*) note "DATABASE_URL uses the pooler on port 6543 (transaction mode) — correct for serverless." ;;
  *:5432/*) note "DATABASE_URL uses the direct connection on port 5432 — the documented fallback, not the preferred one." ;;
  *) note "DATABASE_URL does not end in :6543/ or :5432/ — check that it is the pooled Supabase URL." ;;
esac

# ------------------------------------------------------------ 3. the schema --

if [ "${SKIP_SCHEMA}" -eq 1 ]; then
  info "schema (skipped)"
  note "skipped with --skip-schema"
else
  info "schema"

  SCHEMA_PROGRAM="$(cat <<'NODE'
import { readFileSync } from "node:fs";
import { Pool } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}

const pool = new Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 15000,
});

try {
  const check = await pool.query("select to_regclass('public.nodes') as table_name");
  if (check.rows[0]?.table_name) {
    console.log("the nodes table already exists");
  } else {
    const sql = readFileSync("server/db/schema.sql", "utf8");
    await pool.query(sql);
    console.log("created the nodes table from server/db/schema.sql");
  }
} catch (error) {
  console.error(`schema check failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
NODE
)"

if ! DATABASE_URL="${DATABASE_URL}" node --input-type=module -e "${SCHEMA_PROGRAM}"; then
    die "the target database could not be reached, or the schema could not be applied." \
      "Nothing was deployed. Check DATABASE_URL (the pooler URL on port 6543) and
that the project is not paused in the Supabase dashboard."
  fi
fi

# ------------------------------------------------------------------ 4. the seed --

if [ "${SKIP_SEED}" -eq 1 ]; then
  info "seed (skipped)"
  note "skipped with --skip-seed"
else
  info "seed"
  if DATABASE_URL="${DATABASE_URL}" node server/db/seed.js; then
    note "the seed finished. It is idempotent: re-running it changes nothing."
  else
    die "the seed failed against the target database." \
      "Nothing was deployed. Check DATABASE_URL and that the 'nodes' table exists
(the schema is server/db/schema.sql), then try again."
  fi
fi

# ------------------------------------------------------- 5. the env variables --

if [ "${SKIP_ENV}" -eq 1 ]; then
  info "environment variables (skipped)"
  note "skipped with --skip-env"
else
  info "environment variables"

  note "adding DATABASE_URL to the production environment"
  if printf '%s' "${DATABASE_URL}" | vercel env add DATABASE_URL production --force --yes; then
    note "DATABASE_URL is set for production."
  else
    die "vercel env add DATABASE_URL failed." \
      "Nothing was deployed. If the account has several scopes, add one:

    vercel env add DATABASE_URL production --force --yes --scope <team-slug>"
  fi

  if [ -n "${CRON_SECRET:-}" ]; then
    note "adding CRON_SECRET to the production environment"
    if printf '%s' "${CRON_SECRET}" | vercel env add CRON_SECRET production --force --yes; then
      note "CRON_SECRET is set for production. /api/health now needs 'Authorization: Bearer <CRON_SECRET>'."
    else
      die "vercel env add CRON_SECRET failed." "Nothing was deployed."
    fi
  else
    note "CRON_SECRET is not set — /api/health will accept unauthenticated requests."
    note "Set it in the Vercel dashboard if the cron should be authenticated."
  fi
fi

# ---------------------------------------------------------------- 6. the deploy --

DEPLOY_URL=""

if [ "${SKIP_DEPLOY}" -eq 1 ]; then
  info "deploy (skipped)"
  note "skipped with --skip-deploy"
else
  info "deploy"
  DEPLOY_LOG="$(mktemp)"
  if vercel --prod --yes 2>&1 | tee "${DEPLOY_LOG}"; then
    DEPLOY_URL="$(grep -oE 'https://[A-Za-z0-9.-]+\.vercel\.app' "${DEPLOY_LOG}" | tail -n 1 || true)"
    rm -f "${DEPLOY_LOG}"
    note "deployed."
    if [ -n "${DEPLOY_URL}" ]; then
      printf '\nProduction URL: %s\n' "${DEPLOY_URL}"
    else
      printf '\nProduction URL: read it from the vercel output above, or run `vercel ls`.\n'
    fi
  else
    rm -f "${DEPLOY_LOG}"
    die "vercel --prod failed." "Nothing else was changed. The env variables above are still set."
  fi
fi

# ------------------------------------------------------------- 7. the checklist --

cat <<'CHECKLIST'

== post-deploy checklist ==

  1. open the production URL
  2. open <url>/api/health  ->  {"ok":true,"db":"up","mode":"postgres"}
     (if mode says "memory", DATABASE_URL did not reach the deployment:
      run `vercel env ls` and re-deploy)
  3. open <url>/api/tree    ->  the COMP3421 tree is there
  4. open the app: the file page shows the COMP3421 root, and a folder opens
  5. confirm the cron is registered:
       vercel cron list
     (the schedule is "0 3 * * *" — daily; Hobby plans run cron at most once
     a day)
  6. the seed was already applied to the hosted database in step 3, so the
     tree survives every redeploy

== if the app shows a database error ==

  Supabase pauses a free project after 7 days of low database activity, and a
  paused project returns errors until it is resumed in the dashboard:

    https://supabase.com/dashboard  ->  the project  ->  Resume project

  The daily cron (GET /api/health -> select 1) is the mitigation. It is not a
  guarantee.
CHECKLIST
