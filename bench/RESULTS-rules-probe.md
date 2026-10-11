# rules_probe v2 — findings (2026-10-10, warm Occamy via llama-swap :8080)

Source of truth: `rules_probe_results.json` + the live run log. Read `usage.prompt_tokens`
(TRUE, echoed by the server), `usage.prompt_tokens_details.cached_tokens`, and
`timings.prompt_ms`. This supersedes the pre-advisor "tentative" section of `RESULTS.md`.

## Finding 1 (HARD) — KV VRAM is preallocated by `--ctx-size`; runtime ejection frees ~0 MiB
GPU `memory.used` while growing the **resident** prompt (nvidia-smi, RTX 2070 SUPER 8 GiB):
```
~1000 tok  -> 6590 MiB
~5000 tok  -> 6590 MiB
~11000 tok -> 6583 MiB      (swing = -7 MiB, i.e. noise)
```
FLAT. With `--ctx-size 96000 --kv-unified` the KV pool is allocated at load, independent of how
many tokens are actually resident. **This invalidates the plan's runtime premise**: "eject spent
tool results → free VRAM → more MoE experts on GPU" does **not** work by pruning live tokens.
VRAM for experts is recovered only by **setting a smaller `--ctx-size` at load**; ejection's role
becomes *making that smaller ceiling safe* (working set must fit under it), not freeing VRAM itself.

## Finding 2 (HARD, but the mechanism is NOT confirmed) — `cached_tokens` is not a time-saved proxy
Identical prefix, seed then immediate resend:
```
prompt   resend_cached  reuse   seed_ms  resend_ms
 1500          1499      1.00    3031     2969
 3100          3099      1.00    4715     4689
 6300          6299      1.00    9003     8994
10900         10899      1.00   14889    14886
16900         16899      1.00   22914    22829
```
`cached_tokens ≈ prompt` at EVERY size, yet `resend_ms ≈ seed_ms ≈ full prefill` (~1.3 ms/tok,
no speedup at all). Two candidate explanations — **not yet separated**:
- (a) the prompt cache did NOT actually engage (back-to-back identical requests never let the slot
  go *idle*, and beellama's `--cache-idle-slots` parks a slot's KV into the prompt cache only on
  the *next* task → so `cached_tokens` is reported from a different accounting than the compute); OR
- (b) `prompt_ms` is total prompt handling (incl. cache lookup/verify) and the real saved compute is
  small but masked — i.e. reuse DID happen and ms is simply not the right signal.

**Do not assert the idle-slot mechanism from this alone.** The one genuinely real reuse signal
available is `cache_probe`'s **different-suffix-after-seed** pattern (case A full 6.25 s vs case B
1.2 s at 2.7k tok, cached 2560/2689) — there the *time* moved, which is why that probe is trusted
more than this counter. **v3 methodology fix:** force a slot-idle between seed and probe (insert a
distinct other-prompt request), and compare *time*, not `cached_tokens`.

## Finding 3 (ROBUST) — cold prefill ≈ 1.3 ms/token (~760 t/s)
Independently re-confirmed: 7998 uncached tokens → 11030 ms (1.38 ms/tok); the seed series above
is linear at ~1.3 ms/tok. This is the cost of a genuine full prefill / any prefix-busting event.
It matches the pasted doc's "750 tok/s" premise.

## What this settles for Gate A
- Prefix reuse demonstrably exists and **saves wall time** when the slot idles (`cache_probe`
  A→B: ~5× faster, cached 2560/2689 at 2.7k). Engine-half = **PASS**, but *conditional* on
  idle-slot mechanics + the working set fitting `--cache-ram 2048` MiB.
- `pi`'s compaction trigger uses **provider `usage`** (agent-session.js `_checkCompaction` →
  `calculateContextTokens(assistantMessage.usage)`) → ejection does lower pi's compaction signal,
  *even though* it frees no VRAM.
- Gate A is NOT fully closed: (i) the "stable prefix actually reuses across consecutive *pi* turns"
  is shown on synthetic curl, not on real `pi` serialization (needs a payload-diff capture); and
  (ii) the reuse-vs-timing accounting is unresolved (Finding 2).

## Corrected rule implications (supersedes RESULTS.md "tentative")
- **Do NOT** size `minResultBytesToEject` off "ms saved per token." Runtime ejection frees no VRAM;
  its prefill saving only appears via idle-slot cache and is masked in the counters.
- **Reframe around a WINDOW, not per-token:** the real lever is a deliberately-smaller `--ctx-size`
  at load (needs its own sweep: `--ctx-size` → GPU-free-MiB → `--n-cpu-moe` → tok/s — NOT measured,
  heavy/multi-cold-load). Ejection's job: keep `system+golden+tail` under BOTH (a) that `--ctx-size`
  and (b) the `--cache-ram` retainable window (else golden stops being cached → full re-prefill).
- Dominant cost to avoid remains a prefix-busting full re-prefill (~1.3 ms/tok × window = seconds),
  i.e. pi's rewrite-compaction at the ceiling.
- `tailKeepToolResults` is now **absolute** in code (model cannot prune an in-tail result).

## Still unmeasured — the actual premise test
`--cache-ram 2048` → token count it can retain (golden size ceiling); and the `--ctx-size` → VRAM →
expert-offload → tok/s curve. Until that sweep runs, the whole "more experts → faster" chain is a
hypothesis, not a measurement. Recommend deciding with the user whether to run it (heavy) before
finalizing any compaction rule.
