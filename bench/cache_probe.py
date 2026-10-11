#!/usr/bin/env python3
"""
Gate A cache_probe — measure whether beellama's AUTOMATIC prefix cache reuses KV for a
byte-stable leading prefix, using an in-band server-side counter (NOT wall-clock):
  usage.prompt_tokens_details.cached_tokens   (from /v1/chat/completions)

Runs against the live llama-swap proxy (:8080) so it uses the EXACT production flags.
This exercises the disputed claim directly: it does not merely pass; it measures cache reuse.

Cases (single-user-message prompt = prefix + suffix, temp 0, max_tokens 1):
  A  fresh long prefix                -> seeds the prompt cache (cached ~0)
  B  identical prefix, new suffix     -> cached_tokens ~= prefix (the stable-prefix win)
  C  FIRST line of prefix mutated     -> cached_tokens ~0 (proves prefix-keyed, not "any prompt")
  D  prefix + one appended sentence   -> cached ~= prefix (append-only growth prefills only delta)
Then a no-shared-prefix prefill sweep (unique seed per size) to estimate prompt tokens/sec,
which feeds the compaction-rule guesstimate (cost of an uncached token vs a pruned one).

Usage:  python3 cache_probe.py [--model occamy] [--base http://127.0.0.1:8080/v1] [--prefix-chars 9000]
"""
import argparse, hashlib, json, sys, time, urllib.request

def post(base, payload, timeout):
    req = urllib.request.Request(base.rstrip("/") + "/chat/completions",
                                 data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

def wait_ready(base, model, max_wait=360):
    """Trigger cold load with a tiny request; retry until it answers or timeout."""
    t0 = time.time()
    small = {"model": model, "messages": [{"role": "user", "content": "ping"}],
             "max_tokens": 1, "temperature": 0}
    while time.time() - t0 < max_wait:
        try:
            post(base, small, timeout=min(120, max_wait - int(time.time()-t0) + 5))
            return time.time() - t0
        except Exception as e:
            sys.stderr.write(f"  [load] still warming: {e}\n")
            time.sleep(3)
    raise RuntimeError("model never became ready")

def stable_prefix_lines(n):
    """Deterministic, realistic 'tool-result-like' lines. Identical for every caller."""
    out = []
    for i in range(n):
        out.append(f"line {i:05d}: const value_{i%17} = compute(step={i}) // deterministic filler block for cache prefix")
    return out

def build_prefix(target_chars):
    lines = []
    total = 0
    i = 0
    while total < target_chars:
        ln = stable_prefix_lines(10000)[i]
        lines.append(ln); total += len(ln) + 1; i += 1
    return "\n".join(lines)

def run_case(base, model, prefix, suffix, label):
    payload = {"model": model, "messages": [{"role": "user", "content": prefix + suffix}],
               "max_tokens": 1, "temperature": 0}
    try:
        r = post(base, payload, timeout=120)
    except Exception as e:
        print(f"{label:14s} ERROR {e}"); return None
    usage = r.get("usage", {}) or {}
    details = usage.get("prompt_tokens_details", {}) or {}
    cached = details.get("cached_tokens")
    prompt = usage.get("prompt_tokens")
    tim = r.get("timings", {}) or {}
    pms = tim.get("prompt_ms"); ptoks = tim.get("prompt_n")
    tps = (ptoks / (pms/1000.0)) if (pms and ptoks) else None
    print(f"{label:14s} prompt_tokens={prompt} cached={cached} "
          f"uncached={(prompt-cached) if (prompt is not None and cached is not None) else '?'} "
          f"prompt_ms={pms} prompt_tps={round(tps) if tps else '?'}")
    return {"label": label, "prompt_tokens": prompt, "cached_tokens": cached,
            "prompt_ms": pms, "prompt_n": ptoks}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="occamy")
    ap.add_argument("--base", default="http://127.0.0.1:8080/v1")
    ap.add_argument("--prefix-chars", type=int, default=9000)
    args = ap.parse_args()

    print(f"== waiting for {args.model} to be ready (cold load can take a few minutes) ==")
    print(f"   ready in {wait_ready(args.base, args.model):.1f}s")

    prefix = build_prefix(args.prefix_chars)
    prefix_tokens_approx = None
    print(f"\n== prefix built: {len(prefix)} chars (cases) ==")
    res = []
    res.append(run_case(args.base, args.model, prefix, "\n\nQ: A\n", "A seed"))
    res.append(run_case(args.base, args.model, prefix, "\n\nQ: B totally different\n", "B reuse"))
    mutated = ("CHANGED " + prefix.split("\n", 1)[1]) if "\n" in prefix else "CHANGED"
    res.append(run_case(args.base, args.model, mutated, "\n\nQ: A\n", "C mutate-head"))
    res.append(run_case(args.base, args.model, prefix + "\nnewline appended golden decision", "\n\nQ: A\n", "D append-only"))

    # prefill sweep: unique prefix per size (no cross-reuse) to measure prompt t/s.
    print("\n== prefill sweep (unique seeds -> uncached) ==")
    sweep = []
    for chars in (500, 2000, 6000, 12000, 24000):
        seed = hashlib.sha1(str(chars).encode()).hexdigest()
        body = " ".join(f"{seed}{i}" for i in range(max(1, chars // 12)))[:chars]
        payload = {"model": args.model, "messages": [{"role": "user", "content": body + "\nQ:\n"}],
                   "max_tokens": 1, "temperature": 0}
        try:
            r = post(args.base, payload, timeout=120)
        except Exception as e:
            print(f"  {chars:6d} chars ERROR {e}"); continue
        tim = r.get("timings", {}) or {}; pms = tim.get("prompt_ms"); ptoks = tim.get("prompt_n")
        tps = (ptoks/(pms/1000.0)) if (pms and ptoks) else None
        print(f"  {chars:6d} chars  prompt_n={ptoks} prompt_ms={pms} prompt_tps={round(tps) if tps else '?'}")
        sweep.append({"chars": chars, "prompt_n": ptoks, "prompt_ms": pms, "prompt_tps": tps})

    print("\n== verdict ==")
    b = res[1] if len(res) > 1 else None
    if b and b["prompt_tokens"] is not None and b["cached_tokens"] is not None:
        frac = b["cached_tokens"] / b["prompt_tokens"]
        print(f"  reuse fraction on stable prefix: {frac:.2%} "
              f"({'CONFIRMS automatic prefix cache' if frac > 0.5 else 'LOW/none — see analysis'})")

    with open("cache_probe_results.json", "w") as f:
        json.dump({"cases": res, "sweep": sweep}, f, indent=2)
    print("\nwrote cache_probe_results.json")

if __name__ == "__main__":
    main()
