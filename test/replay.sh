#!/usr/bin/env bash
# replay.sh — reproduce "compaction makes pi features unresponsive" on a COPIED real
# session, GPU-free, against the mock backend. One fresh sandbox per arm; the repo
# fixture is never modified (pi appends to its sandbox copy).
#
#   ./golden-context/test/replay.sh                 # run all arms, print comparison
#   ./golden-context/test/replay.sh plugin-hang      # run a single arm
#
# Arms:
#   pi-only      no extension — baseline pi compaction on the old session
#   plugin       golden-context loaded, default (conservative) config
#   plugin-eject golden-context with autoEjectOldToolResults=true — "our compaction"
#                actually rewriting spent results of the old session
#   plugin-ckpt  golden-context idle checkpointing: a tool-using turn against the mock,
#                then the background checkpoint (evidence summary + purge + prefill)
#   plugin-hang  plugin + MOCK_HANG_SUMMARY=1: the compaction summary request never
#                completes (engine stall) -> the wedge signature to recognize live
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"     # .../golden-context/test
SRC="$(dirname "$HERE")"                                  # .../golden-context
FIXTURE="${PI_REPLAY_FIXTURE:-$HERE/fixtures/session-01a12612.jsonl}"
BASE_OUT="${BASE_OUT:-/tmp/pi-replay}"
BASE_PORT="${BASE_PORT:-18201}"

[ -f "$FIXTURE" ] || {
  echo "error: session fixture not found: $FIXTURE" >&2
  echo "hint:  the repo ships no session data (privacy). Point PI_REPLAY_FIXTURE at one" >&2
  echo "       of your own pi session JSONL files; replay COPIES it per arm and never" >&2
  echo "       modifies the original." >&2
  exit 1; }

ALL_ARMS=(pi-only plugin plugin-eject plugin-ckpt plugin-hang)
ARMS=("$@")
[ ${#ARMS[@]} -eq 0 ] && ARMS=("${ALL_ARMS[@]}")

run_arm() {
  local arm="$1" idx="$2"
  local port=$((BASE_PORT + idx))
  local sbx="$BASE_OUT/$arm/sbx"
  local out="$BASE_OUT/$arm"
  rm -rf "$out"; mkdir -p "$sbx/golden-context" "$out"

  # ---- assemble sandbox agent dir ----
  if [ "$arm" != "pi-only" ]; then
    mkdir -p "$sbx/extensions/golden-context"
    cp "$SRC/golden-context.ts"          "$sbx/extensions/golden-context/index.ts"
    cp "$SRC/golden-core.ts"             "$sbx/extensions/golden-context/golden-core.ts"
  fi
  case "$arm" in
    plugin-eject)
      cat > "$sbx/golden-context/config.json" <<'JSON'
{ "autoEjectOldToolResults": true, "tailKeepToolResults": 2, "minResultBytesToEject": 1024 }
JSON
      ;;
    plugin-hang)
      # The wedge repro must exercise PI's own summarizer (that's the untimeouted call
      # that hangs), so the golden takeover is switched off for this arm only.
      cat > "$sbx/golden-context/config.json" <<'JSON'
{ "takeoverCompaction": false }
JSON
      ;;
    *)
      cp "$SRC/golden-context.config.json" "$sbx/golden-context/config.json" 2>/dev/null || true
      ;;
  esac

  cat > "$sbx/models.json" <<JSON
{
  "providers": {
    "mock": {
      "baseUrl": "http://127.0.0.1:$port/v1",
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
  echo '{}' > "$sbx/auth.json"

  # Compaction budgets the model can actually honor: pi's defaults (reserve 16384 /
  # keepRecent 20000) retain MORE than a 24k window can hold, so prepareCompaction
  # finds nothing to cut on this session ("Nothing to compact (session too small)") —
  # the same trap documented in findings-golden-context.md §10.3. Same shape as the
  # recommended live fix, keyed by exact provider/modelId. No `packages` key here:
  # that would trigger pi's ~220-package npm install at startup.
  cat > "$sbx/settings.json" <<'JSON'
{
  "compaction": {
    "modelOverrides": {
      "mock/tinyclip": { "reserveTokens": 4096, "keepRecentTokens": 6000 }
    }
  }
}
JSON

  # The session fixture gets COPIED per arm (pi writes to it as it runs). It must NOT sit
  # directly in the agent dir: pi's startup migration ("migrate sessions from
  # <agentDir>/*.jsonl to proper session directories") MOVES such files into
  # sessions/--<cwd>--/ and the --session lookup then starts an empty session in their
  # place. Keep it next to the report output instead.
  cp "$FIXTURE" "$out/session.jsonl"

  # ---- mock backend ----
  # (env must be passed via `env`: a shell-var-expanded "VAR=1" prefix is parsed as a
  # command name, not an assignment — that silently skipped the mock in the hang arm)
  local -a mockcmd=(env "MOCK_LOG=$out/mock-requests.jsonl")
  local -a mockargs=(--port "$port" --toolcall -1 --loopcalls 0)
  [ "$arm" = "plugin-hang" ] && mockcmd+=("MOCK_HANG_SUMMARY=1")
  # plugin-ckpt: two bash tool calls then a text reply -> a tool-using turn to checkpoint
  [ "$arm" = "plugin-ckpt" ] && mockargs=(--port "$port" --toolcall -1 --loopcalls 2)
  "${mockcmd[@]}" node "$HERE/mock-backend.mjs" "${mockargs[@]}" \
      > "$out/mock-server.log" 2>&1 &
  local srv=$!
  trap 'kill $srv 2>/dev/null || true' RETURN
  for _ in $(seq 1 40); do
    curl -s -m 1 "http://127.0.0.1:$port/v1/models" >/dev/null 2>&1 && break
    sleep 0.25
  done

  # ---- drive pi ----
  echo "=== arm: $arm (mock :$port, sandbox $sbx) ==="
  PI_CODING_AGENT_DIR="$sbx" LLAMA_BASE_URL="http://127.0.0.1:$port" \
    node "$HERE/replay.mjs" --session "$out/session.jsonl" --out "$out" \
      --model mock/tinyclip --prompts "${PROMPTS:-1}" --compact-timeout 15000 --step-timeout 10000 --settle-ms 1500 --gap-ms "${GAP_MS:-0}" \
      || true

  kill $srv 2>/dev/null || true
  trap - RETURN

  # ---- EXPORT PARITY (findings §17 invariant) ----
  # /export embeds SESSION STORAGE as a base64 JSON blob (pi renders it client-side), so raw
  # grep never sees transcript text. Decode and assert two STRUCTURAL properties (no fixture
  # content is hardcoded here — users supply their own session file): (1) the payload carries
  # every message/compaction entry the storage file has, (2) wire-only fold labels never leaked
  # into storage. Fold labels exist only on the wire; finding one in the payload means a purge
  # mutated storage, breaking the invariant.
  if [ -f "$out/replay-export.html" ] && [ -f "$out/session.jsonl" ]; then
    PARITY=$(python3 - "$out/replay-export.html" "$out/session.jsonl" <<'PY'
import re, base64, json, sys
h = open(sys.argv[1], encoding="utf8", errors="replace").read()
m = re.search(r'([A-Za-z0-9+/=]{2000,})', h)
if not m:
    print("[parity] FAIL: no embedded session payload"); raise SystemExit
j = json.loads(base64.b64decode(m.group(1)).decode("utf8", "replace"))
file_n = 0
for line in open(sys.argv[2], encoding="utf8", errors="replace"):
    line = line.strip()
    if line and json.loads(line).get("type") in ("message", "compaction"):
        file_n += 1
payload_n = sum(1 for e in j.get("entries", []) if e.get("type") in ("message", "compaction"))
leaked = "folded into checkpoint" in json.dumps(j)
if payload_n >= file_n and not leaked:
    print(f"[parity] export=vanilla: all {payload_n} storage entries present, zero wire fold-labels")
else:
    print(f"[parity] FAIL: payload={payload_n} file={file_n} fold-labels-leaked={leaked}")
PY
) || PARITY="[parity] FAIL: python check crashed"
    echo "  $PARITY"
  fi
  echo
}

idx=0
for arm in "${ARMS[@]}"; do
  run_arm "$arm" "$idx"
  idx=$((idx + 1))
done

# ---- comparison table ----
echo "════════ summary ════════"
printf '%-14s %-10s %-10s %s\n' "arm" "compact" "export" "notes"
for arm in "${ARMS[@]}"; do
  rep="$BASE_OUT/$arm/report.json"
  [ -f "$rep" ] || { printf '%-14s %-10s %-10s %s\n' "$arm" "-" "-" "no report"; continue; }
  python3 - "$arm" "$rep" <<'PY'
import json, sys
arm, rep = sys.argv[1], sys.argv[2]
r = json.load(open(rep))
notes = []
for s in r["steps"]:
    if s["status"] != "ok":
        notes.append(f"{s['step']}:{s['status']}")
state1 = next((s for s in r["steps"] if s["step"] == "state1"), {})
if "isCompacting=true" in state1.get("note", ""):
    notes.append("isCompacting STUCK")
print(f"{arm:<14} {r['compact']:<10} {r['export']:<10} {'; '.join(notes) or 'all steps ok'}")
PY
done
echo
echo "evidence per arm: $BASE_OUT/<arm>/{report.json,events.jsonl,mock-requests.jsonl,replay-export.html}"
