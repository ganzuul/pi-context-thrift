#!/usr/bin/env bash
# scope-e2e.sh — prove, with REAL pi and no GPU, that the golden store is per-directory.
#
# This is the regression test for the reported bug: "Pi started in a different directory should
# get a fresh context, but the plugin gave us a global one." Offline tests drive the adapter with
# a stub, so they cannot show that pi really hands us a per-session cwd. This does:
#
#   run 1  projA  -> commit_decision fires; store lands under projA's scope dir
#   run 2  projA  -> the committed line MUST be in the system prompt it sends (persistence)
#   run 3  projB  -> that line MUST NOT be in its system prompt (fresh context per directory)
#
#   ./scope-e2e.sh            # exit 0 = isolation proven
#
# Uses golden-context/test/mock-backend.mjs, so no model is loaded and nothing touches ~/.pi.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(dirname "$HERE")"
SBX="${SBX:-/tmp/pi-scope-e2e-sbx}"
PORT="${PORT:-18141}"
FULL="${FULL:-/tmp/pi-scope-e2e-full.jsonl}"
A_DIR="${A_DIR:-/tmp/pi-scope-e2e-projA}"
B_DIR="${B_DIR:-/tmp/pi-scope-e2e-projB}"
CANARY="E2E-SCOPE-CANARY-8813"

rm -rf "$SBX" "$A_DIR" "$B_DIR"; mkdir -p "$SBX/extensions/golden-context" "$A_DIR" "$B_DIR"
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

# Negative control: SCOPE_OVERRIDE=global restores the historic single machine-wide store, which
# MUST make "project B starts FRESH" fail. Run it that way to prove this test can detect the leak
# rather than passing vacuously.
if [ -n "${SCOPE_OVERRIDE:-}" ]; then
  mkdir -p "$SBX/golden-context"
  printf '{"scope": "%s"}\n' "$SCOPE_OVERRIDE" > "$SBX/golden-context/config.json"
  echo "NOTE: scope override = $SCOPE_OVERRIDE (expect the isolation assertions to FAIL)"
fi

# The commit text MUST be the same string the assertions grep for. Derive it from $CANARY so a
# caller cannot desync the two (an external MOCK_COMMIT_TEXT override silently broke a run).
MOCK_LOG=/tmp/pi-scope-e2e-req.jsonl MOCK_FULL=1 MOCK_FULL_LOG="$FULL" MOCK_COMMIT_TEXT="$CANARY" \
  node "$HERE/mock-backend.mjs" --port "$PORT" --toolcall 2 --loopcalls 1 --bigoutput 4000 \
  > /tmp/pi-scope-e2e-server.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT INT TERM
for _ in $(seq 1 40); do curl -s -m 1 "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1 && break; sleep 0.25; done

fails=0
run_pi() { # $1 = label, $2 = dir, $3 = prompt
  local before; before=$(wc -l < "$FULL")
  ( cd "$2" && PI_CODING_AGENT_DIR="$SBX" timeout 120 pi -p --model tinyclip "$3" >/dev/null 2>&1 )
  local after; after=$(wc -l < "$FULL")
  tail -n +$((before + 1)) "$FULL" > "/tmp/pi-scope-e2e-run-$1.jsonl"
  echo "  ($2 -> $((after - before)) request(s) logged into run-$1)"
}
want() { # $1 = file, $2 = 0|1 (must/must-not contain), $3 = needle, $4 = label
  # A missing or empty capture means the run never happened: that is a harness failure,
  # NOT a pass — "must not contain" would otherwise succeed vacuously.
  if [ ! -s "$1" ]; then echo "  FAIL - $4 (capture $1 is empty: the run produced no payload)"; fails=$((fails+1)); return; fi
  local present=0
  grep -q -- "$3" "$1" 2>/dev/null && present=1
  if [ "$present" -eq "$2" ]; then echo "  ok  - $4"; else echo "  FAIL - $4 (found=$present want=$2)"; fails=$((fails+1)); fi
}

echo "=== run 1: project A (commit_decision is forced) ==="
run_pi r1-A "$A_DIR" "Run bash once, then commit a decision."
echo "=== run 2: project A again ==="
run_pi r2-A "$A_DIR" "Just say OK."
echo "=== run 3: project B ==="
run_pi r3-B "$B_DIR" "Just say OK."

echo; echo "=== stores on disk ==="
find "$SBX/golden-context" -name "golden.jsonl" | sed 's/^/  /' || true

echo; echo "=== assertions ==="
want "/tmp/pi-scope-e2e-run-r2-A.jsonl" 1 "$CANARY" "project A keeps its own golden across sessions"
want "/tmp/pi-scope-e2e-run-r3-B.jsonl" 0 "$CANARY" "project B starts FRESH (no leak from A)"
want "/tmp/pi-scope-e2e-run-r3-B.jsonl" 1 "tinyclip" "project B really did run (sanity: payload captured)"
# the mock commits its own canary text; make sure it matched the tool result too
grep -rq "$CANARY" "$SBX/golden-context" && echo "  ok  - the canary lives inside a scoped store" || { echo "  FAIL - canary not in any store"; fails=$((fails+1)); }

echo
if [ "$fails" -eq 0 ]; then echo "SCOPE E2E: PASS — per-directory golden proven on real pi"; exit 0
else echo "SCOPE E2E: FAIL ($fails)"; exit 1; fi
