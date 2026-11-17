#!/usr/bin/env bash
# scope-e2e.sh — prove, with REAL pi and no GPU, that the golden store is per pi session.
#
# Regression test for: "stores golden context per directory instead of per pi session."
#
#   run 1  projA (session 1) -> commit_decision fires; store lands under sessions/<id1>/
#   run 2  projA (session 2, SAME dir) -> must NOT see session 1's golden (fresh session)
#   run 3  projA (resume session 1) -> MUST see session 1's golden (persistence across resume)
#
#   ./scope-e2e.sh            # exit 0 = session isolation & resume persistence proven
#   SCOPE_OVERRIDE=cwd ./scope-e2e.sh   # negative control: MUST FAIL on run 2
#
# Uses golden-context/test/mock-backend.mjs, so no model is loaded and nothing touches ~/.pi.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(dirname "$HERE")"
SBX="${SBX:-/tmp/pi-scope-e2e-sbx}"
PORT="${PORT:-18141}"
FULL="${FULL:-/tmp/pi-scope-e2e-full.jsonl}"
A_DIR="${A_DIR:-/tmp/pi-scope-e2e-projA}"
CANARY="E2E-SCOPE-CANARY-8813"

rm -rf "$SBX" "$A_DIR"; mkdir -p "$SBX/extensions/golden-context" "$A_DIR"
cp "$SRC/golden-context.ts" "$SBX/extensions/golden-context/index.ts"
cp "$SRC/golden-core.ts"    "$SBX/extensions/golden-context/golden-core.ts"
cat > "$SBX/models.json" <<JSON
{"providers":{"mock":{"baseUrl":"http://127.0.0.1:$PORT/v1","api":"openai-completions","apiKey":"none",
"models":[{"id":"tinyclip","name":"Mock tinyclip","reasoning":true,
"thinkingLevelMap":{"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":null},
"input":["text"],"contextWindow":96000,"maxTokens":8192,
"compat":{"maxTokensField":"max_tokens","supportsUsageInStreaming":true,"thinkingFormat":"qwen-chat-template"}}]}}}
JSON
echo '{}' > "$SBX/auth.json"
: > "$FULL"

# Negative control: SCOPE_OVERRIDE=cwd (or global) restores per-dir sharing, which MUST make
# "fresh session in same dir starts FRESH" fail.
if [ -n "${SCOPE_OVERRIDE:-}" ]; then
  mkdir -p "$SBX/golden-context"
  printf '{"scope": "%s"}\n' "$SCOPE_OVERRIDE" > "$SBX/golden-context/config.json"
  echo "NOTE: scope override = $SCOPE_OVERRIDE (expect the isolation assertions to FAIL)"
fi

MOCK_LOG=/tmp/pi-scope-e2e-req.jsonl MOCK_FULL=1 MOCK_FULL_LOG="$FULL" MOCK_COMMIT_TEXT="$CANARY" \
  node "$HERE/mock-backend.mjs" --port "$PORT" --toolcall 2 --loopcalls 1 --bigoutput 4000 \
  > /tmp/pi-scope-e2e-server.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT INT TERM
for _ in $(seq 1 40); do curl -s -m 1 "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1 && break; sleep 0.25; done

fails=0
run_pi() { # $1 = label, $2 = dir, $3 = prompt, $4... = extra pi args
  local label="$1" dir="$2" prompt="$3"; shift 3
  local before; before=$(wc -l < "$FULL")
  ( cd "$dir" && PI_CODING_AGENT_DIR="$SBX" timeout 120 pi -p --model tinyclip "$@" "$prompt" >/dev/null 2>&1 )
  local after; after=$(wc -l < "$FULL")
  tail -n +$((before + 1)) "$FULL" > "/tmp/pi-scope-e2e-run-$label.jsonl"
  echo "  ($dir -> $((after - before)) request(s) logged into run-$label)"
}
want() { # $1 = file, $2 = 0|1 (must/must-not contain), $3 = needle, $4 = label
  if [ ! -s "$1" ]; then echo "  FAIL - $4 (capture $1 is empty: the run produced no payload)"; fails=$((fails+1)); return; fi
  local present=0
  grep -q -- "$3" "$1" 2>/dev/null && present=1
  if [ "$present" -eq "$2" ]; then echo "  ok  - $4"; else echo "  FAIL - $4 (found=$present want=$2)"; fails=$((fails+1)); fi
}

echo "=== run 1: project A, session 1 (commit_decision is forced) ==="
run_pi r1-A-s1 "$A_DIR" "Run bash once, then commit a decision."
SESS1="$(ls -1t "$SBX"/sessions/*/*.jsonl 2>/dev/null | head -n1 || true)"
echo "  session 1 file: ${SESS1:-none}"

echo "=== run 2: project A, fresh session 2 in SAME directory ==="
run_pi r2-A-s2 "$A_DIR" "Just say OK."

echo "=== run 3: project A, resume session 1 ==="
if [ -n "$SESS1" ]; then
  run_pi r3-A-s1-resume "$A_DIR" "Just say OK." --session "$SESS1"
else
  echo "  FAIL - no session 1 file created to resume"
  fails=$((fails+1))
fi

echo; echo "=== stores on disk ==="
find "$SBX/golden-context" -name "golden.jsonl" | sed 's/^/  /' || true

echo; echo "=== assertions ==="
want "/tmp/pi-scope-e2e-run-r2-A-s2.jsonl" 0 "$CANARY" "fresh session in same dir starts FRESH (no leak from session 1)"
want "/tmp/pi-scope-e2e-run-r2-A-s2.jsonl" 1 "tinyclip" "session 2 really did run (sanity: payload captured)"
want "/tmp/pi-scope-e2e-run-r3-A-s1-resume.jsonl" 1 "$CANARY" "resuming session 1 preserves ITS golden"
grep -rq "$CANARY" "$SBX/golden-context" && echo "  ok  - the canary lives inside a scoped store" || { echo "  FAIL - canary not in any store"; fails=$((fails+1)); }

echo
if [ "$fails" -eq 0 ]; then echo "SCOPE E2E: PASS — per-session golden proven on real pi"; exit 0
else echo "SCOPE E2E: FAIL ($fails)"; exit 1; fi
