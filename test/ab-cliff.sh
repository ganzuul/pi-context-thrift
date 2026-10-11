#!/usr/bin/env bash
# ab-cliff.sh — GPU-free A/B proof of what actually stalls pi on a small-context model,
# and what golden-context changes about it.
#
# pi clamps every request with (pi-ai/dist/api/simple-options.js):
#     max_tokens = min(model.maxTokens, max(1, contextWindow - estimate - 4096))
# so on a 24k model, once pi's own context estimate passes ~19.9k, max_tokens floors at 1:
# the model emits one token, reports finish_reason "length", and pi returns an EMPTY answer.
# That is the signature of the hung session (usage.output=1, thinking "The", stopReason "length").
#
# Each arm gets a FRESH mock server (its own turn counter) and an identical prompt, so the only
# variable is the extension's ejection behaviour:
#   inert     -> enabled:false            (extension loaded, does nothing)
#   autoeject -> autoEjectOldToolResults  (spent tool outputs replaced by handles on the wire)
#
#   ./ab-cliff.sh            # both arms
#   ./ab-cliff.sh autoeject  # one arm
#
# Never touches ~/.pi or the GPU. Requires: node, pi, ../golden-context built by the caller.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"     # .../golden-context/test
SRC="$(dirname "$HERE")"                                  # .../golden-context
SBX="${SBX:-/tmp/pi-golden-ab-sbx}"
PORT="${PORT:-18100}"
LOG="${LOG:-/tmp/pi-golden-ab-requests.jsonl}"
ROUNDS="${ROUNDS:-5}"
BIGCH="${BIGCH:-20000}"
PROMPT="Run bash several times, printing a large block each time, then summarise what you saw."

mkdir -p "$SBX/extensions/golden-context" "$SBX/golden-context"
cp "$SRC/golden-context.ts" "$SBX/extensions/golden-context/index.ts"
cp "$SRC/golden-core.ts"    "$SBX/extensions/golden-context/golden-core.ts"

cat > "$SBX/models.json" <<JSON
{
  "providers": {
    "mock": {
      "baseUrl": "http://127.0.0.1:$PORT/v1",
      "api": "openai-completions",
      "apiKey": "none",
      "models": [{
        "id": "tinyclip", "name": "Mock tinyclip", "reasoning": true,
        "thinkingLevelMap": {"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":null},
        "input": ["text"], "contextWindow": 24000, "maxTokens": 8192,
        "compat": {"maxTokensField":"max_tokens","supportsUsageInStreaming":true,"thinkingFormat":"qwen-chat-template"}
      }]
    }
  }
}
JSON
[ -f "$SBX/auth.json" ] || echo '{}' > "$SBX/auth.json"

# arm configs
printf '{"enabled": false}\n'                                        > /tmp/golden-inert.json
printf '{"enabled": true, "autoEjectOldToolResults": true, "tailKeepToolResults": 2, "minResultBytesToEject": 2048, "stripThinkingOnSpend": true, "maxGoldenSectionBytes": 16000, "goldenStoreRel": "golden-context/golden.jsonl", "handleTemplate": "[golden] {toolName} #{id} ejected ({bytes}B) - consumed into later work"}\n' > /tmp/golden-autoeject.json

# pi-side fix: the defaults (reserveTokens 16384 / keepRecentTokens 20000) RETAIN MORE THAN a
# 24000-token window can hold once pi's own 4096-token safety reserve is subtracted, so
# compaction cannot free room and max_tokens stays floored. Keyed by exact provider/model id.
cat > /tmp/golden-budgets.json <<'JSON'
{
  "compaction": {
    "enabled": true,
    "modelOverrides": {
      "mock/tinyclip": { "reserveTokens": 4096, "keepRecentTokens": 6000 }
    }
  }
}
JSON

run_arm() {
  local name="$1" cfg="$2" settings="${3:-}"
  rm -f "$LOG" "$SBX/golden-context/golden.jsonl"
  # pi reads <agentDir>/settings.json; only compaction token budgets here, NO `packages` key
  # (a packages list would npm install ~220 packages on startup).
  [ -n "$settings" ] && [ -f "$settings" ] && cp "$settings" "$SBX/settings.json" || rm -f "$SBX/settings.json"
  MOCK_LOG="$LOG" node "$HERE/mock-backend.mjs" --port "$PORT" --toolcall -1 \
      --loopcalls "$ROUNDS" --bigoutput "$BIGCH" > "/tmp/golden-ab-server-$name.log" 2>&1 &
  local srv=$!
  # wait for the port rather than a fixed sleep
  for _ in $(seq 1 40); do
    curl -s -m 1 "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1 && break
    sleep 0.25
  done

  local out="/tmp/golden-ab-$name.out" err="/tmp/golden-ab-$name.err"
  PI_CODING_AGENT_DIR="$SBX" PI_GOLDEN_CONFIG="$cfg" \
    timeout 180 pi -p --model mock/tinyclip "$PROMPT" > "$out" 2> "$err"
  local rc=$?
  kill "$srv" 2>/dev/null; wait "$srv" 2>/dev/null

  echo "───────── arm=$name  (PI_GOLDEN_CONFIG=$cfg)  pi_exit=$rc  answer=$(wc -c <"$out")B"
  python3 - "$LOG" <<'PY'
import json, sys
try:
    lines = open(sys.argv[1]).read().splitlines()
except OSError:
    print("   (no requests recorded)"); raise SystemExit
for l in lines:
    r = json.loads(l)
    tag = "SUMMARY" if r["msgCount"] == 2 and not r["tools"] else ("agent  " if r["tools"] else "other  ")
    print(f"   turn={r['turn']:2d} {tag} max_tokens={str(r['max_tokens']):5s} est={r['prompt_tokens']:6d} "
          f"handles={r.get('handles')} prefix={r['prefixHash'][:10]}")
PY
  [ -s "$err" ] && { echo "   stderr:"; sed 's/^/     /' "$err" | head -5; }
  echo
}

ARMS="${1:-all}"
echo "model=mock/tinyclip contextWindow=24000 maxTokens=8192  rounds=$ROUNDS bigoutput=$BIGCH"
echo "pi reserve: max_tokens = min(8192, max(1, 24000 - estimate - 4096))  ->  floors at 1 past est ~19904"
echo
# 1) control: extension present but disabled, pi's default 16384/20000 budgets
# 2) pi-side fix: same extension state, per-model budgets that fit inside the window
# 3) golden-side fix: default pi budgets, but spent tool results ejected before serialization
if [ "$ARMS" = "all" ] || [ "$ARMS" = "inert" ]; then     run_arm inert     /tmp/golden-inert.json;     fi
if [ "$ARMS" = "all" ] || [ "$ARMS" = "budgetfix" ]; then run_arm budgetfix /tmp/golden-inert.json     /tmp/golden-budgets.json; fi
if [ "$ARMS" = "all" ] || [ "$ARMS" = "autoeject" ]; then run_arm autoeject /tmp/golden-autoeject.json; fi
