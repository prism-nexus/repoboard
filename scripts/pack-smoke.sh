#!/usr/bin/env bash
# RCB-120: smoke-test the published `repoboard` npm package end to end, from a tarball produced
# by `cd packages/server && npm pack`. Runs locally on macOS as well as in CI — no `timeout`
# binary, since it is not on macOS by default. Temp dir + fresh git repo, install the tarball,
# exercise CLI, HTTP, and MCP. Prints one line per step; exits non-zero on the first failure.
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <tarball>" >&2
  exit 1
fi

TARBALL="$1"
case "$TARBALL" in
  /*) ;;
  *) TARBALL="$(pwd)/$TARBALL" ;;
esac

if [ ! -f "$TARBALL" ]; then
  echo "pack-smoke: tarball not found: $TARBALL" >&2
  exit 1
fi

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/repoboard-pack-smoke.XXXXXX")"
cleanup() {
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "pack-smoke: workdir $WORKDIR"
cd "$WORKDIR"

git init -q
git config user.name 'pack-smoke'
git config user.email 'pack-smoke@example.com'
echo "pack-smoke: step 1/9 git init OK"

npm install --silent "$TARBALL" >/dev/null
echo "pack-smoke: step 2/9 npm install tarball OK"

EXPECTED_VERSION="$(node -e "
const { execFileSync } = require('node:child_process');
const out = execFileSync('tar', ['-xOzf', '$TARBALL', 'package/package.json']).toString('utf8');
console.log(JSON.parse(out).version);
")"
ACTUAL_VERSION="$(npx --no-install repoboard --version)"
if [ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "pack-smoke: FAIL --version printed '$ACTUAL_VERSION', expected '$EXPECTED_VERSION'" >&2
  exit 1
fi
echo "pack-smoke: step 3/9 --version == $EXPECTED_VERSION OK"

npx --no-install repoboard init >/dev/null
echo "pack-smoke: step 4/9 init OK"

npx --no-install repoboard card add "Hello: world" >/dev/null
echo "pack-smoke: step 5/9 card add OK"

CARD_LIST="$(npx --no-install repoboard card list)"
if ! echo "$CARD_LIST" | grep -q 'RB-2'; then
  echo "pack-smoke: FAIL card list did not contain RB-2:" >&2
  echo "$CARD_LIST" >&2
  exit 1
fi
echo "pack-smoke: step 6/9 card list contains RB-2 OK"

if ! npx --no-install repoboard check >/dev/null; then
  echo "pack-smoke: FAIL check exited non-zero" >&2
  exit 1
fi
echo "pack-smoke: step 7/9 check exits 0 OK"

PORT="$(node -e "
const net = require('node:net');
const srv = net.createServer();
srv.listen(0, '127.0.0.1', () => {
  console.log(srv.address().port);
  srv.close();
});
")"
npx --no-install repoboard serve --port "$PORT" >server.log 2>&1 &
SERVER_PID=$!

READY=0
for _ in $(seq 1 30); do
  if [ -n "${SERVER_PID:-}" ] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "pack-smoke: FAIL serve process exited early; log:" >&2
    cat server.log >&2 || true
    exit 1
  fi
  CODE="$(curl -s -o /tmp/pack-smoke-body.$$ -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)"
  if [ "$CODE" = "200" ]; then
    READY=1
    break
  fi
  sleep 1
done
if [ "$READY" != "1" ]; then
  echo "pack-smoke: FAIL server never returned 200 on /; log:" >&2
  cat server.log >&2 || true
  exit 1
fi
BODY="$(cat /tmp/pack-smoke-body.$$ 2>/dev/null || true)"
rm -f /tmp/pack-smoke-body.$$
if ! echo "$BODY" | grep -q '<title>repoboard</title>'; then
  echo "pack-smoke: FAIL / did not contain <title>repoboard</title>:" >&2
  echo "$BODY" >&2
  exit 1
fi
echo "pack-smoke: step 8/9 serve: GET / -> 200 with <title>repoboard</title> OK"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

MCP_REQUEST='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"pack-smoke","version":"1.0.0"}}}'
MCP_RESPONSE="$(printf '%s\n' "$MCP_REQUEST" | npx --no-install repoboard mcp 2>mcp.log | head -n 1 || true)"
if ! echo "$MCP_RESPONSE" | grep -q '"name":"repoboard"'; then
  echo "pack-smoke: FAIL mcp initialize response missing serverInfo.name repoboard:" >&2
  echo "$MCP_RESPONSE" >&2
  cat mcp.log >&2 || true
  exit 1
fi
echo "pack-smoke: step 9/9 mcp initialize -> serverInfo.name repoboard OK"

echo "pack-smoke: all steps passed"
