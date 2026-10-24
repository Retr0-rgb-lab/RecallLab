#!/usr/bin/env bash
#
# scripts/verify.sh — RecallLab local verification.
#
# Runs the automated test suite and then drives a live server over HTTP,
# asserting the API contract and the SPA routing that the design spec fixes.
#
#   bash scripts/verify.sh
#
# What it does:
#   1. `npm test`                       — the node:test suite in tests/
#   2. boots the app on a free port     — no DATABASE_URL, so the in-memory
#                                         Postgres (pg-mem) is used and the
#                                         COMP3421 tree is auto-seeded at boot
#   3. asserts the API and the routing   — health, tree, root level, create,
#                                         update, delete, deep link, API 404
#   4. kills the server on exit          — always, including on Ctrl-C
#
# Options:
#   --skip-tests        do not run `npm test` (smoke test only)
#   --timeout <secs>    how long to wait for the server to become ready
#                       (default 180; a cold boot on a Windows-mounted drive
#                        can take tens of seconds)
#   -h, --help          print this help
#
# Exit code is 0 only when every assertion passed.
#
set -euo pipefail

# ---------------------------------------------------------------- location --

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# ------------------------------------------------------------------ options --

SKIP_TESTS=0
READY_TIMEOUT=180

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-tests) SKIP_TESTS=1; shift ;;
    --timeout) READY_TIMEOUT="${2:?--timeout needs a value}"; shift 2 ;;
    --timeout=*) READY_TIMEOUT="${1#*=}"; shift ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown option: %s (try --help)\n' "$1" >&2; exit 2 ;;
  esac
done

# ----------------------------------------------------------------- reporting --

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'PASS  %s\n' "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf 'FAIL  %s\n' "$1"
  if [ "$#" -ge 2 ] && [ -n "$2" ]; then
    printf '      %s\n' "$2"
  fi
}

section() {
  printf '\n== %s ==\n' "$1"
}

# ------------------------------------------------------------------ cleanup --

TMP_DIR="$(mktemp -d)"
SERVER_PID=""
SERVER_LOG="${TMP_DIR}/server.log"
CLEANED=0

cleanup() {
  local status="${1:-0}"
  if [ "${CLEANED}" -eq 1 ]; then
    exit "${status}"
  fi
  CLEANED=1

  if [ -n "${SERVER_PID}" ] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "${SERVER_PID}" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "${SERVER_PID}" 2>/dev/null; then
      kill -9 "${SERVER_PID}" 2>/dev/null || true
    fi
    wait "${SERVER_PID}" 2>/dev/null || true
  fi

  case "${TMP_DIR}" in
    /tmp/*) rm -rf "${TMP_DIR}" ;;
  esac

  exit "${status}"
}

trap 'cleanup $?' EXIT
trap 'cleanup 130' INT
trap 'cleanup 143' TERM

# -------------------------------------------------------------------- helpers --

BODY_FILE="${TMP_DIR}/body"
HEADER_FILE="${TMP_DIR}/headers"
BASE_URL=""
HTTP_STATUS=""

# http <method> <path> [json-body] — performs the request and leaves the
# status code in HTTP_STATUS, the body in BODY_FILE, the headers in HEADER_FILE.
http() {
  local method="$1" path="$2" payload="${3:-}"
  local -a args=(
    --silent
    --show-error
    --max-time 20
    --output "${BODY_FILE}"
    --dump-header "${HEADER_FILE}"
    --write-out '%{http_code}'
    --request "${method}"
  )
  if [ -n "${payload}" ]; then
    args+=(--header 'Content-Type: application/json' --data "${payload}")
  fi
  HTTP_STATUS="$(curl "${args[@]}" "${BASE_URL}${path}" 2>/dev/null || true)"
  [ -n "${HTTP_STATUS}" ] || HTTP_STATUS="000"
}

# header_value <name> — the value of a response header, lower-cased name.
header_value() {
  grep -i "^$1:" "${HEADER_FILE}" 2>/dev/null | head -n 1 | cut -d' ' -f2- | tr -d '\r' || true
}

# json_eval <js-expression> — evaluates the expression against the parsed
# response body read from stdin and prints the result.
json_eval() {
  node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      let data;
      try { data = JSON.parse(raw); } catch { process.exit(2); }
      const result = eval(process.argv[1]);
      if (result === null || result === undefined) { process.stdout.write(""); return; }
      process.stdout.write(typeof result === "object" ? JSON.stringify(result) : String(result));
    });
  ' "$1"
}

# ---------------------------------------------------------------------- banner --

printf 'RecallLab — local verification\n'
printf 'repo:   %s\n' "${REPO_ROOT}"
printf 'node:   %s\n' "$(node --version)"
printf 'mode:   in-memory Postgres (pg-mem), auto-seeded at boot\n'

if [ ! -d "${REPO_ROOT}/node_modules" ]; then
  printf '\nnode_modules is missing — run `npm install` first.\n' >&2
  exit 1
fi

# --------------------------------------------------------------- 1. the tests --

if [ "${SKIP_TESTS}" -eq 1 ]; then
  section "test suite (skipped)"
  printf 'SKIP  npm test (--skip-tests)\n'
else
  section "test suite"
  if npm test > "${TMP_DIR}/tests.log" 2>&1; then
    pass "npm test — the node:test suite passes"
  else
    fail "npm test — the node:test suite fails" "the failing subtests:"
    grep -E '^not ok ' "${TMP_DIR}/tests.log" | sed 's/^/      /' || true
    printf '\n'
    tail -n 12 "${TMP_DIR}/tests.log" || true
  fi
fi

# ------------------------------------------------------------- 2. the server --

section "smoke test"

PORT="$(node -e '
  const net = require("net");
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => process.stdout.write(String(port)));
  });
')"

if [ -z "${PORT}" ]; then
  fail "could not find a free port" "the smoke test cannot start"
  exit 1
fi

BASE_URL="http://127.0.0.1:${PORT}"

# DATABASE_URL and CRON_SECRET are removed on purpose: the app must run on the
# in-memory database, and /api/health must answer without a bearer token.
env -u DATABASE_URL -u CRON_SECRET PORT="${PORT}" \
  node server/index.js > "${SERVER_LOG}" 2>&1 &
SERVER_PID=$!

READY=0
DEADLINE=$((SECONDS + READY_TIMEOUT))
while [ "${SECONDS}" -lt "${DEADLINE}" ]; do
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    break
  fi
  PROBE="$(curl --silent --output /dev/null --max-time 5 --write-out '%{http_code}' \
    "${BASE_URL}/api/health" 2>/dev/null || true)"
  if [ "${PROBE}" = "200" ]; then
    READY=1
    break
  fi
  sleep 1
done

if [ "${READY}" -ne 1 ]; then
  fail "the server did not become ready on ${BASE_URL} within ${READY_TIMEOUT}s" \
    "server log:"
  tail -n 20 "${SERVER_LOG}" 2>/dev/null || true
  exit 1
fi

pass "the server is ready on ${BASE_URL}"

# ------------------------------------------------------------- 3. the asserts --

# --- GET /api/health -------------------------------------------------------
http GET /api/health
if [ "${HTTP_STATUS}" = "200" ]; then
  OK="$(json_eval 'data.ok === true && data.db === "up"' < "${BODY_FILE}" 2>/dev/null || true)"
  if [ "${OK}" = "true" ]; then
    pass 'GET /api/health -> 200 { ok: true, db: "up" }'
  else
    fail 'GET /api/health -> ok:true and db:"up"' "body: $(head -c 200 "${BODY_FILE}")"
  fi
else
  fail 'GET /api/health -> 200 { ok: true, db: "up" }' "status ${HTTP_STATUS}"
fi

# --- GET /api/tree ---------------------------------------------------------
http GET /api/tree
if [ "${HTTP_STATUS}" = "200" ]; then
  TREE_COUNT="$(json_eval 'data.nodes.length' < "${BODY_FILE}" 2>/dev/null || true)"
  if [ -n "${TREE_COUNT}" ] && [ "${TREE_COUNT}" -gt 0 ] 2>/dev/null; then
    pass "GET /api/tree -> 200, ${TREE_COUNT} nodes"
  else
    fail "GET /api/tree -> a non-empty tree" "nodes: ${TREE_COUNT:-<none>}"
  fi
else
  fail "GET /api/tree -> a non-empty tree" "status ${HTTP_STATUS}"
fi

# --- GET /api/nodes (root level) -------------------------------------------
http GET /api/nodes
ROOT_IDS=""
if [ "${HTTP_STATUS}" = "200" ]; then
  ROOT_IDS="$(json_eval 'data.nodes.map((node) => node.id)' < "${BODY_FILE}" 2>/dev/null || true)"
  ROOT_PARENTS="$(json_eval 'data.nodes.every((node) => node.parentId === null)' < "${BODY_FILE}" 2>/dev/null || true)"
  ROOT_COUNT="$(json_eval 'data.nodes.length' < "${BODY_FILE}" 2>/dev/null || true)"
  if [ "${ROOT_PARENTS}" = "true" ] && [ "${ROOT_COUNT:-0}" -gt 0 ] 2>/dev/null; then
    pass "GET /api/nodes -> 200, the root level (${ROOT_COUNT} node(s), parentId null)"
  else
    fail "GET /api/nodes -> the root level" "count ${ROOT_COUNT:-<none>}, every parentId null: ${ROOT_PARENTS:-<none>}"
  fi
else
  fail "GET /api/nodes -> the root level" "status ${HTTP_STATUS}"
fi

# --- GET /api/nodes?parent=root --------------------------------------------
http GET '/api/nodes?parent=root'
if [ "${HTTP_STATUS}" = "200" ]; then
  ROOT_QUERY_IDS="$(json_eval 'data.nodes.map((node) => node.id)' < "${BODY_FILE}" 2>/dev/null || true)"
  if [ -n "${ROOT_QUERY_IDS}" ] && [ "${ROOT_QUERY_IDS}" = "${ROOT_IDS}" ]; then
    pass "GET /api/nodes?parent=root -> 200, the same level as GET /api/nodes"
  else
    fail "GET /api/nodes?parent=root -> the same level as GET /api/nodes" \
      "${ROOT_QUERY_IDS:-<none>} != ${ROOT_IDS:-<none>}"
  fi
else
  fail "GET /api/nodes?parent=root -> the same level as GET /api/nodes" "status ${HTTP_STATUS}"
fi

# --- POST /api/nodes -------------------------------------------------------
CARD_TITLE="verify-smoke-$$-$(date +%s)"
http POST /api/nodes \
  "{\"parentId\": null, \"kind\": \"card\", \"title\": \"${CARD_TITLE}\", \"body\": \"smoke prompt\", \"answer\": \"smoke answer\"}"
CARD_ID=""
if [ "${HTTP_STATUS}" = "201" ]; then
  CARD_ID="$(json_eval 'data.node.id' < "${BODY_FILE}" 2>/dev/null || true)"
  LOCATION="$(header_value location)"
  if [ -n "${CARD_ID}" ] && [ "${LOCATION}" = "/api/nodes/${CARD_ID}" ]; then
    pass "POST /api/nodes -> 201 with Location: ${LOCATION}"
  else
    fail "POST /api/nodes -> 201 with a Location header" \
      "id ${CARD_ID:-<none>}, location ${LOCATION:-<none>}"
  fi
else
  fail "POST /api/nodes -> 201 with a Location header" \
    "status ${HTTP_STATUS}, body: $(head -c 200 "${BODY_FILE}")"
fi

# --- PUT /api/nodes/:id ----------------------------------------------------
if [ -n "${CARD_ID}" ]; then
  http PUT "/api/nodes/${CARD_ID}" \
    "{\"title\": \"${CARD_TITLE} updated\", \"body\": \"updated prompt\", \"answer\": \"updated answer\"}"
  if [ "${HTTP_STATUS}" = "200" ]; then
    NEW_TITLE="$(json_eval 'data.node.title' < "${BODY_FILE}" 2>/dev/null || true)"
    if [ "${NEW_TITLE}" = "${CARD_TITLE} updated" ]; then
      pass "PUT /api/nodes/:id -> 200, the update is returned"
    else
      fail "PUT /api/nodes/:id -> 200, the update is returned" "title: ${NEW_TITLE:-<none>}"
    fi
  else
    fail "PUT /api/nodes/:id -> 200, the update is returned" "status ${HTTP_STATUS}"
  fi
else
  fail "PUT /api/nodes/:id -> 200, the update is returned" "no card was created"
fi

# --- DELETE /api/nodes/:id -------------------------------------------------
if [ -n "${CARD_ID}" ]; then
  http DELETE "/api/nodes/${CARD_ID}"
  if [ "${HTTP_STATUS}" = "204" ]; then
    http GET "/api/nodes/${CARD_ID}"
    if [ "${HTTP_STATUS}" = "404" ]; then
      pass "DELETE /api/nodes/:id -> 204, and the node is gone (404 afterwards)"
    else
      fail "DELETE /api/nodes/:id -> 204, and the node is gone" "status ${HTTP_STATUS} after the delete"
    fi
  else
    fail "DELETE /api/nodes/:id -> 204, and the node is gone" "status ${HTTP_STATUS}"
  fi
else
  fail "DELETE /api/nodes/:id -> 204, and the node is gone" "no card was created"
fi

# --- GET /f/<uuid> (the SPA deep link) -------------------------------------
DEEP_ID="${CARD_ID:-00000000-0000-4000-8000-000000000000}"
http GET "/f/${DEEP_ID}"
DEEP_TYPE="$(header_value content-type)"
if [ "${HTTP_STATUS}" = "200" ] && printf '%s' "${DEEP_TYPE}" | grep -qi 'text/html'; then
  if head -c 1 "${BODY_FILE}" | grep -q '[{[]'; then
    fail "GET /f/<uuid> -> the SPA shell (HTML), not JSON" "the body starts with JSON"
  else
    pass "GET /f/<uuid> -> 200, the SPA shell (${DEEP_TYPE})"
  fi
else
  fail "GET /f/<uuid> -> the SPA shell (HTML), not JSON" \
    "status ${HTTP_STATUS}, content-type ${DEEP_TYPE:-<none>}"
fi

# --- GET /api/nonexistent (a JSON 404, not the shell) ----------------------
http GET /api/nonexistent
API_TYPE="$(header_value content-type)"
if [ "${HTTP_STATUS}" = "404" ] && printf '%s' "${API_TYPE}" | grep -qi 'application/json'; then
  ERROR_CODE="$(json_eval 'data.error.code' < "${BODY_FILE}" 2>/dev/null || true)"
  if [ "${ERROR_CODE}" = "not_found" ]; then
    pass "GET /api/nonexistent -> 404 with a JSON body (code not_found)"
  else
    fail "GET /api/nonexistent -> 404 with a JSON body" "code: ${ERROR_CODE:-<none>}"
  fi
else
  fail "GET /api/nonexistent -> 404 with a JSON body, not the shell" \
    "status ${HTTP_STATUS}, content-type ${API_TYPE:-<none>}"
fi

# -------------------------------------------------------------------- summary --

printf '\n%d passed, %d failed\n' "${PASS_COUNT}" "${FAIL_COUNT}"

if [ "${FAIL_COUNT}" -ne 0 ]; then
  printf '\nserver log:\n'
  tail -n 20 "${SERVER_LOG}" 2>/dev/null || true
  exit 1
fi

exit 0
