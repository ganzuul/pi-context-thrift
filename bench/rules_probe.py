#!/usr/bin/env python3
"""
rules_probe (lean) — locate the beellama prompt-cache REUSE CEILING and warm-tail cost,
using the TRUE prompt_tokens echoed by the server (my fill() over-counts tokens ~6.6x).
Runs against warm llama-swap (:8080 -> Occamy). reps=1; bounded so it won't run long.

Key question this answers for compaction-rule design: below what prompt-token size does a
byte-stable prefix actually STAY cached across two requests, and where does reuse collapse
(hypothesis: `--cache-ram 2048` MiB caps retained KV ~ a few thousand tokens)?
"""
import json, subprocess, time, urllib.request

BASE = "http://127.0.0.1:8080/v1"
MODEL = "occamy"

def post(content, timeout=200):
    req = urllib.request.Request(BASE + "/chat/completions",
        data=json.dumps({"model": MODEL, "messages": [{"role": "user", "content": content}],
                         "max_tokens": 1, "temperature": 0}).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.loads(r.read().decode())
    u = d.get("usage", {}) or {}; det = u.get("prompt_tokens_details", {}) or {}; t = d.get("timings", {}) or {}
    return {"prompt": u.get("prompt_tokens"), "cached": det.get("cached_tokens"),
            "prompt_ms": round(t.get("prompt_ms") or 0)}

def fill(units, seed):  # deterministic; TRUE token count read back from response
    return " ".join(f"w{seed}_{i}" for i in range(units))

def gpu():
    try:
        return int(subprocess.check_output(["nvidia-smi","--query-gpu=memory.used","--format=csv,noheader,nounits"],text=True,timeout=10).strip().splitlines()[0])
    except Exception:
        return None

print("warm:", post("ping"))

print("\n== reuse ceiling scan: seed a stable prefix, immediately resend identical ==")
rows = []
for units in (200, 400, 800, 1200, 1800):
    p = fill(units, seed=units)          # unique per row so rows don't cross-seed each other
    seed = post(p)                        # prefill + cache
    again = post(p)                       # should hit cache if under ceiling
    frac = (again["cached"]/again["prompt"]) if again["prompt"] else 0
    print(f"  ~{units:4d} units -> prompt={seed['prompt']} tok | resend cached={again['cached']} "
          f"uncached={(again['prompt'] or 0)-(again['cached'] or 0)} reuse={frac:.0%} resend_ms={again['prompt_ms']}")
    rows.append({"units": units, "prompt": seed["prompt"], "seed_ms": seed["prompt_ms"],
                 "resend_cached": again["cached"], "resend_ms": again["prompt_ms"], "reuse": round(frac,3)})
    if (again["prompt"] or 0) > 13000:    # stop once clearly past the hypothesized ceiling
        print("   (past ~13k tokens; enough to locate the collapse)")
        break

print("\n== warm-tail marginal cost (stable ~400-unit prefix cached, grow tail) ==")
base = fill(400, seed=5000)
post(base)  # seed
prev = None
for tl in (0, 128, 256, 512):
    r = post(base + " " + fill(tl, seed=6000+tl))
    unc = (r["prompt"] or 0) - (r["cached"] or 0)
    print(f"  tail+{tl:4d}  prompt={r['prompt']} cached={r['cached']} uncached={unc} ms={r['prompt_ms']}")
    if prev and tl:
        print(f"      delta vs prev: +{(r['prompt_ms']-prev[1])}ms / +{(r['prompt']-prev[0])} tok "
              f"= {(r['prompt_ms']-prev[0])/max((r['prompt']-prev[0]),1):.2f} ms/new-tok")
    prev = (r["prompt"], r["prompt_ms"])

print("\n== GPU used_MiB across growing resident prompt (flat => KV pool preallocated to --ctx-size) ==")
pts = []
for tok in gpu is not None and [1000, 5000, 11000] or []:
    post(fill(tok//6, seed=tok))
    time.sleep(0.4)
    g = gpu(); pts.append({"units": tok//6, "used_mib": g})
    print(f"  ~{tok} tok request -> used_MiB={g}")
if len(pts) >= 2 and pts[0]["used_mib"] and pts[-1]["used_mib"]:
    d = pts[-1]["used_mib"] - pts[0]["used_mib"]
    print(f"  => {d} MiB swing over the scan "
          f"({'FLAT: pool fixed by --ctx-size, runtime ejection frees ~0 VRAM' if abs(d)<300 else 'grows: KV tracks usage'})")

json.dump({"ceiling": rows}, open("rules_probe_results.json","w"), indent=2)
print("\nwrote rules_probe_results.json")
