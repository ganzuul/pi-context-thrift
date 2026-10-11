#!/usr/bin/env bash
# Isolated runner for the golden-context pi extension.
# Builds a PI_CODING_AGENT_DIR sandbox so it NEVER touches your live ~/.pi.
#
# The sandbox is PERSISTENT (default: ~/.local/state/pi-golden-sandbox) — sessions and the
# golden store SURVIVE between runs. (It used to live in /tmp and was rm -rf'd on every
# start; that destroyed an in-flight debugging session's whole transcript — "nothing
# survived". Use --fresh for the old wipe-everything behavior.)
#
# Layout: pi auto-loads every top-level `extensions/*.ts`, so the multi-file extension lives in a
# SUBDIR as `index.ts` (which imports the sibling `golden-core.ts`); golden-core.ts is NOT at the
# top level, or pi tries to run it as a second extension and fails "does not export a factory".
#
#   ./run-golden-context.sh              # interactive pi with the extension loaded
#   ./run-golden-context.sh --fresh      # ...after wiping the sandbox (old behavior)
#   ./run-golden-context.sh --selfcheck  # headless: run the loader probe, print PASS/FAIL, no model
#   ./run-golden-context.sh -c           # continue the most recent sandbox session
#
# Extension/config sources are re-copied on every start (so edits here take effect), but
# sessions/, the golden store, and anything else in the sandbox are left alone.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"     # repo root
SRC="$HERE/golden-context"
[ -f "$SRC/golden-context.ts" ] || SRC="$HERE"          # flattened checkout (pi-context-thrift)
SBX="${SBX:-$HOME/.local/state/pi-golden-sandbox}"

[ -f "$SRC/golden-context.ts" ] && [ -f "$SRC/golden-core.ts" ] || {
  echo "error: missing $SRC/golden-context.ts or golden-core.ts" >&2; exit 1; }

FRESH=0
for a in "$@"; do [ "$a" = "--fresh" ] && FRESH=1; done
[ "$FRESH" = "1" ] && rm -rf "$SBX"
mkdir -p "$SBX/extensions/golden-context" "$SBX/golden-context"
cp "$SRC/golden-context.ts"          "$SBX/extensions/golden-context/index.ts"
cp "$SRC/golden-core.ts"             "$SBX/extensions/golden-context/golden-core.ts"
cp "$SRC/golden-context.config.json" "$SBX/golden-context/config.json"

# pi's built-in rewrite-compaction is DISABLED here: golden-context owns compaction
# (idle checkpoints + in-flight context-full folding + session_before_compact takeover),
# and pi's summarizer has no timeout (findings §11 — the wedge). Only this one key:
# a `packages`/`extensions` list in settings.json would trigger pi's ~220-package npm
# install / load unrelated extensions. (The takeover hook is the safety net if this file
# is absent — e.g. a live install.)
cat > "$SBX/settings.json" <<'JSON'
{ "compaction": { "enabled": false } }
JSON

# Only an INTERACTIVE session needs model+auth. Copy them transiently (never settings.json: its
# `packages` list triggers a ~220-package npm install and its `extensions` list loads unrelated
# extensions, which would confound the check). --selfcheck runs the model-free loader probe, so it
# does NOT copy auth.json — we avoid leaving a credentials copy around. For interactive runs the
# copy is removed again at exit (the persistent sandbox must not become a second credential store).
SELF=0; [ "${1:-}" = "--selfcheck" ] && SELF=1
MOCK=0; [ "${1:-}" = "--mock" ] && MOCK=1 && shift
COPIED_AUTH=0
if [ "$SELF" -eq 0 ] && [ "$MOCK" -eq 0 ]; then
  REAL="${REAL_AGENT_DIR:-$HOME/.pi/agent}"
  for f in models.json auth.json; do [ -f "$REAL/$f" ] && cp "$REAL/$f" "$SBX/$f" || true; done
  [ -f "$SBX/auth.json" ] && COPIED_AUTH=1
fi
cleanup() { [ "$COPIED_AUTH" = "1" ] && rm -f "$SBX/auth.json"; }
trap cleanup EXIT INT TERM

export PI_CODING_AGENT_DIR="$SBX"
export LLAMA_BASE_URL="${LLAMA_BASE_URL:-http://127.0.0.1:8080}"

if [ "$SELF" -eq 1 ]; then
  echo "sandbox : $SBX"
  echo "extension: $SBX/extensions/golden-context/index.ts"
  exec node "$SRC/test/loader-probe.mjs" "$SBX"
fi

# --mock: run REAL pi against a dependency-free local backend. No GPU, no llama-swap, no model
# load — and it is the only way to see the whole loop (loader -> commit_decision -> golden.jsonl
# -> <golden> section -> on-the-wire ejection) without waking the shared stack.
if [ "$MOCK" -eq 1 ]; then
  MOCK_PORT="${MOCK_PORT:-18123}"
  cat > "$SBX/models.json" <<JSON
{
  "providers": {
    "mock": {
      "baseUrl": "http://127.0.0.1:$MOCK_PORT/v1",
      "api": "openai-completions",
      "apiKey": "none",
      "models": [{
        "id": "tinyclip", "name": "Mock tinyclip (GPU-free harness)", "reasoning": true,
        "thinkingLevelMap": {"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":null},
        "input": ["text"], "contextWindow": 24000, "maxTokens": 8192,
        "compat": {"maxTokensField":"max_tokens","supportsUsageInStreaming":true,"thinkingFormat":"qwen-chat-template"}
      }]
    }
  }
}
JSON
  echo '{}' > "$SBX/auth.json"
  MOCK_LOG="${MOCK_LOG:-/tmp/pi-golden-mock-requests.jsonl}"
  export MOCK_LOG
  node "$SRC/test/mock-backend.mjs" --port "$MOCK_PORT" --toolcall -1 --loopcalls 0 \
      > /tmp/pi-golden-mock-server.log 2>&1 &
  SRV=$!
  trap 'kill $SRV 2>/dev/null || true' EXIT INT TERM
  for _ in $(seq 1 40); do
    curl -s -m 1 "http://127.0.0.1:$MOCK_PORT/v1/models" >/dev/null 2>&1 && break
    sleep 0.25
  done
  echo "sandbox  : $PI_CODING_AGENT_DIR"
  echo "backend  : http://127.0.0.1:$MOCK_PORT/v1  (mock, NO GPU)"
  echo "requests : $MOCK_LOG  (one JSON line per LLM call)"
  echo "golden   : $SBX/golden-context/golden.jsonl (appears after first commit_decision)"
  case " $* " in *" --model "*) ;; *) set -- "$@" --model mock/tinyclip ;; esac
  pi "$@"; rc=$?
  echo "── recorded requests ──"
  python3 -c "
import json,sys
try: lines=open('${MOCK_LOG:-/tmp/pi-golden-mock-requests.jsonl}').read().splitlines()
except OSError: print('  (none)'); sys.exit()
for l in lines:
    r=json.loads(l)
    print(f\"  turn={r['turn']} est={r['prompt_tokens']:6d} max_tokens={str(r['max_tokens']):5s} \"
          f\"handles={r.get('handles')} commit={'Y' if 'commit_decision' in r['tools'] else 'n'} prefix={r['prefixHash'][:10]}\")
" 2>/dev/null || cat "${MOCK_LOG:-/tmp/pi-golden-mock-requests.jsonl}"
  exit $rc
fi

echo "sandbox  : $PI_CODING_AGENT_DIR"
echo "extension: $SBX/extensions/golden-context/index.ts"
echo "golden log: $SBX/golden-context/golden.jsonl (persistent; survives across runs)"
pi "$@"
rc=$?
exit $rc
