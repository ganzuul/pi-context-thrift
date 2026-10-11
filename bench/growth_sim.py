#!/usr/bin/env python3
"""
growth_sim — quantify the ACTUAL objective: make *used* context grow slowly, so many more
tool-using turns happen before a full compaction and the context stays uncluttered.

Sends PI-SHAPED payloads (OpenAI /v1/chat/completions format that pi uses): a system message
carrying an XML-wrapped <golden> section + assistant tool_calls + tool results, so beellama's
qwen chat template renders real wire bytes (closes the "synthetic vs pi traffic" gap).

Compares two modes, turn by turn, reading server-echoed usage.prompt_tokens (+ cached):
  RAW    : every turn's tool result accumulates verbatim  -> context grows fast
  EJECT  : tool results older than tailKeep collapse to handles -> growth flattened
Reports tokens/turn slope and how many turns fit under a candidate compaction ceiling
(e.g. 16k / 32k tokens) before pi's rewrite-compaction would fire.

Note: 'drift reduction' from a cleaner context is a MODEL-behavior hypothesis, NOT measured here.
"""
import json, urllib.request

BASE = "http://127.0.0.1:8080/v1"; MODEL = "occamy"
TAILKEEP = 3          # keep the last 3 tool results verbatim (mirrors golden-context.ts default spirit)
EJECT_MIN_TOK = 500   # only collapse tool results this large (proxy for bytes; conservative)

def post(messages, timeout=200):
    req = urllib.request.Request(BASE + "/chat/completions",
        data=json.dumps({"model": MODEL, "messages": messages, "max_tokens": 1,
                         "temperature": 0, "tools": TOOLS}).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.loads(r.read().decode())
    u = d.get("usage", {}) or {}; det = u.get("prompt_tokens_details", {}) or {}; t = d.get("timings", {}) or {}
    return {"prompt": u.get("prompt_tokens"), "cached": det.get("cached_tokens"), "prompt_ms": round(t.get("prompt_ms") or 0)}

TOOLS = [{"type":"function","function":{"name":"read","description":"read a file","parameters":
         {"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}]

def sys_msg(golden):
    return {"role":"system","content":
        "You are pi, a coding agent.\n"
        + (f"<golden>\n{golden}\n</golden>\n" if golden else "")}

def build_turns(n, unique_seed):
    # realistic accumulation: each turn = user asks -> assistant calls read -> tool returns a big blob
    m = [sys_msg("")]
    for i in range(n):
        m.append({"role":"user","content": f"step {i}: inspect artifact {i}_{unique_seed}"})
        m.append({"role":"assistant","content": None, "tool_calls":
                  [{"id":f"call_{i}","type":"function","function":{"name":"read","arguments": json.dumps({"path": f"/f{i}"})}}]})
        blob = " ".join(f"d{j}={(j+i*97)%1000}" for j in range(900))  # ~big, deterministic-ish per i
        m.append({"role":"tool","tool_call_id":f"call_{i}","content": blob})
    return m

def eject(msgs):
    out=[dict(m) for m in msgs]
    # collapse tool results older than the last TAILKEEP (by position) if large
    toolidx=[i for i,m in enumerate(out) if m["role"]=="tool"]
    for rank,i in enumerate(toolidx):
        if rank < len(toolidx)-TAILKEEP:
            txt=out[i]["content"]
            if len(txt) > EJECT_MIN_TOK*4:  # crude token->char proxy
                out[i]={**out[i],"content": f"[golden] read #call{i} ejected (was {len(txt)} chars)"}
    return out

print("warm:", post([{"role":"user","content":"ping"}]), flush=True)
N=8
print(f"\n== RAW growth (every turn verbatim), {N} turns ==")
raw=[]
for n in range(1,N+1):
    m=build_turns(n, 1)
    r=post(m); raw.append((n, r["prompt"], r["cached"]))
    print(f"  turn {n:2d}: prompt_tokens={r['prompt']:6} cached={r['cached']} ms={r['prompt_ms']}")
    if (r["prompt"] or 0) > 20000: print("  (stopping raw scan past 20k to bound time)"); break
print(f"\n== EJECT growth (older tool results collapsed), same {N} turns ==")
ej=[]
for n in range(1,N+1):
    m=eject(build_turns(n, 1))
    r=post(m); ej.append((n, r["prompt"], r["cached"]))
    print(f"  turn {n:2d}: prompt_tokens={r['prompt']:6} cached={r['cached']} ms={r['prompt_ms']}")

print("\n== growth comparison (tokens resident vs turn) ==")
for (n,tp,_),(n2,tp2,c2) in zip(raw,ej):
    print(f"  turn {n:2d}  RAW={tp:6}  EJECT={tp2:6}  saved={ (tp or 0)-(tp2 or 0) }")

def turns_to_ceiling(series, ceil):
    return next((n for (n,tp,_) in series if (tp or 0) >= ceil), None)
for ceil in (16000, 32000):
    print(f"  turns before {ceil}-token compaction: RAW={turns_to_ceiling(raw, ceil)}  EJECT={turns_to_ceiling(ej, ceil)}")

print("\nNOTE: 'drift' reduction is NOT measured here (needs task-quality eval, not token counts).")
json.dump({"raw":raw,"eject":ej}, open("growth_sim_results.json","w"), indent=2)
