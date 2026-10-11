# Gate A — cache_probe results (2026-10-10)

Live measurement against `llama-swap` `:8080` → Occamy/beellama with the **exact production
flags**. Counter read is server-side, in-band: `usage.prompt_tokens_details.cached_tokens`
(confirmed emitted by beellama `server-task.cpp:401-403`), **not** wall-clock.

Model was already resident (my earlier detached warm-load survived; ready in 2.3 s).

## Cases (prefix ≈ 9043 chars ≈ 2687 tokens)

| case | prefix | suffix | prompt_tokens | cached | uncached | prompt_ms | meaning |
|---|---|---|---|---|---|---|---|
| A seed | long stable | A | 2687 | 0 | 2687 | 6255 | seeds prompt cache |
| B reuse | **identical** | B | 2689 | **2560** | 129 | 1176 | **95.2% prefix reused** ✅ |
| C mutate-head | first line changed | A | 2663 | **0** | 2663 | 5051 | proves **prefix-keyed**, not "any prompt" ✅ |
| D append-only | + one appended line | A | 2692 | **2560** | 132 | 1331 | growth prefills **only the delta** ✅ |

- cached quantum is block-aligned (2560 = block multiple; ~256-block), so the last partial
  block of the prefix isn't reused — negligible at golden scale.

## Prefill timing sweep (unique seeds → no cross-reuse)

| chars | prompt_n | prompt_ms | marginal t/s |
|---|---|---|---|
| 500 | 466 | 2189 | 213 (fixed-cost dominated) |
| 2000 | 1873 | 3137 | 597 |
| 6000 | 5040 | 7456 | 676 |
| 12000 | 10362 | 13781 | 752 |
| 24000 | 17438 | 22878 | 762 |

Derived constants (**cold / uncached** upper bounds — a *separate* warm-delta probe,
`rules_probe.py`, is needed for the steady-state number the rules actually turn on):
- **Marginal uncached prefill ≈ 1.3 ms/token (~760 t/s)** at scale — independently matches the
  pasted doc's "750 tok/s" premise.
- **Per-request fixed overhead ≈ 0.4–0.9 s**; cases B/D had only ~130 uncached tokens yet took
  ~1.2 s, so there is fixed/cache-handling cost beyond `uncached * 1.3 ms` that a warm-tail sweep
  must isolate before any threshold is set.
- cached=2560 is a **block-ish quantum** (mechanism NOT confirmed — could be block size,
  ctx-checkpointing, or a template boundary); don't assume 256 until tested.

## What this settles

1. beellama's automatic prompt cache **does** reuse a byte-stable prefix for OpenAI
   `/v1/chat/completions` traffic (the path pi uses) — **Gate A engine-half = PASS.**
2. Append-only golden growth costs only the appended delta → `renderGoldenSection`'s
   strict-prefix invariant (26/26 unit tests) is confirmed to be load-bearing on the real engine.

## Caveats / NOT yet measured

- **pi-rendering half**: this probe used a hand-built stable prefix. Still to confirm on a live
  pi run that pi's own system-prompt *section-diff* + chat-template render keeps the leading
  prefix byte-stable across turns (so the 95% reuse actually applies to pi, not just to curl).
  Note: pi-ai's normalized `Usage` type had **no** `cached_tokens` field (grep returned nothing),
  so observing reuse *through pi's session entries* may require reading the raw response.
- **VRAM/token**: the actual "more experts on GPU" lever needs KV bytes-per-token, not just prefill
  ms. NOT measured here. Needed to convert "eject N tokens" → "frees X MiB → enables Y more expert
  layers" → the compaction-rule size threshold. Suggest next probe: sample `nvidia-smi` used-MiB at
  several resident prompt sizes.
- **Ejection churn tradeoff**: pruning a *deep/old* tail result invalidates cache from that position
  onward → a one-time re-prefill of the remaining suffix (~1.3 ms/token). The steady-state win is
  **VRAM + deferring pi's ctx-ceiling rewrite-compaction**, not per-turn prefill (which the stable
  prefix already keeps near-zero). Rule design must account for this — see next section.

## Tentative rule implications (pre-advisor; needs VRAM/token to finalize)

- `tailKeepToolResults`: can be generous (≈6–8): under a stable prefix, keeping recent results
  costs little prefill; the binding constraint is the ctx/VRAM ceiling, not tokens/sec.
- `minResultBytesToEject`: keep **high** (≥ a few KB): prune only results large enough to matter for
  VRAM, because each ejection churns the tail from that point (one-time re-prefill). Big blobs give
  the most VRAM saved per churn.
- `autoEjectOldToolResults`: stay OFF by default; enable once a ctx budget (lower `--ctx-size`) is set.
- The dominant cost to avoid is a **prefix-busting full re-prefill** (pi rewrite-compaction at the
  ctx ceiling): at ~32k that is ~40 s, dwarfing per-token savings. So the ejection policy should be
  framed as "keep working set under the compaction trigger," i.e. threshold tied to a fraction of
  `--ctx-size`, not to per-token prefill.
