# pi-context-thrift

**In-flight compaction of context in the [pi](https://github.com/earendil-works/pi)
harness.** Evicts thinking and tool output while waiting for the user, replaced by short
inferred evidence.

> **Status: alpha** (`v0.2.0-alpha.2`) — verified against pi **0.86.1** (real wire-level
> checks: prefill is a byte-exact prefix of the next request, takeover compaction entries,
> loader acceptance). Expect API drift on future pi releases — see
> [Known limitations](#known-limitations-alpha).

## What it does

After every turn the agent hands the session back — while the user is still reading —
a **checkpoint** pass compresses the finished work:

1. **Evidence summary** — one capped model call (≤ 512 tokens, thinking allowed, *only the
   reply is kept*) weighs the tool-call outputs as empirical evidence against the
   reasoning trace.
2. **Checkpoint commit** — one append-only entry joins an off-session **golden store**:
   covered texts preserved verbatim, tool calls listed line-by-line, then the summary.
   The checkpoint stream *is* the golden context — it grows, never rewrites.
3. **Purge** — on the next request the covered range is hollowed: tool outputs → short
   handles, *all* thinking stripped, covered text folded into handles (lossless — the text
   lives in the checkpoint). The assistant's final reply stays verbatim at the tail bottom
   until the next checkpoint folds it. Messages are never deleted (tool call ↔ result
   pairing stays valid).
4. **Warm prefill** — a `max_tokens:1` request sends the exact next-request bytes so the
   prefix cache is already warm when the user replies.
5. **Context counter** — the footer shows `ckpt [N] · est 22.5k→6.4k tok` when a
   checkpoint lands, replaced by `· measured 6.3k tok` once the engine reports real usage.

Three triggers, one machinery (`commitCheckpoint`):

| trigger | when |
|---|---|
| **idle** | `agent_settled` — after each finished turn (+ warm prefill) |
| **in-flight** | the `context` hook — when the **measured** context (last response's KV usage + growth since) crosses `contextFullPct` (default **80 %**) of the model window, fold *before the request goes out*, mid-run included |
| **takeover** | `session_before_compact` — `/compact` (and any pi compaction entry point) runs **our** compaction instead of pi's summarizer; pi's `threshold` triggers are re-verified against the measured size first and **cancelled when the window isn't actually near full** (`manual` and `overflow` always proceed) |

## Install

Requires pi ≥ 0.86 (verified against 0.86.1).

```sh
pi install git:github.com/ganzuul/pi-context-thrift
```

or from a local clone:

```sh
git clone https://github.com/ganzuul/pi-context-thrift.git
pi install ./pi-context-thrift
```

manual (no package manager) — copy the extension into your agent dir:

```sh
mkdir -p ~/.pi/agent/extensions/golden-context
cp golden-context.ts ~/.pi/agent/extensions/golden-context/index.ts
cp golden-core.ts    ~/.pi/agent/extensions/golden-context/
```

Optional — install the documented defaults (otherwise built-in defaults apply):

```sh
mkdir -p ~/.pi/agent/golden-context
cp golden-context.config.json ~/.pi/agent/golden-context/config.json
```

## Recommended setup: disable pi's built-in compaction

**Add this key to your pi settings so this extension owns compaction:**

```json
"compaction": { "enabled": false }
```

### Where

| scope | file | notes |
|---|---|---|
| **global** (all sessions) | `~/.pi/agent/settings.json` | pi's *agent-dir* `settings.json`. If you run pi with `PI_CODING_AGENT_DIR=/path`, it is `/path/settings.json` instead. |
| **per-project override** | `<project>/.pi/settings.json` | pi deep-merges project settings over the global file (nested objects merge recursively), so a project file needs only the `compaction` key — it overrides the global value for those keys. |

### How

Merge the key into the **top level** of the file (keep your existing keys; JSON forbids
comments):

```jsonc
// ~/.pi/agent/settings.json
{
  "lastChangelogVersion": "0.86.1",
  "theme": "dark",
  "defaultModel": "llamacpp/occamy",
  "compaction": { "enabled": false },
  "packages": [ … your existing packages … ]
}
```

Settings are read at pi startup — restart pi after editing. If the key is **absent**, pi
defaults it to `enabled: true`.

### Why

- pi's built-in compaction issues its summary request **with no timeout**; if the engine
  stalls mid-summary, `isCompacting` wedges forever and the whole session freezes
  ([FINDINGS.md](FINDINGS.md) §11 — reproduced and root-caused).
- This extension replaces it with the three bounded triggers above; every evidence call
  carries `timeoutMs: 20000`, so no code path can hang the session the way the summarizer
  can.

### What changes when it's disabled

- **No pi auto/threshold/overflow compaction.** Timing is governed by this extension:
  idle checkpoints after each turn, plus the in-flight fold at `contextFullPct`
  (default 80 % of the window) — so the request stays under pi's `max_tokens` clamp by
  construction.
- **`/compact` still works** — the `session_before_compact` takeover supplies a
  golden-based compaction result (or reports *"Compaction cancelled"* when the last
  checkpoint already covered everything).
- **If you skip this setting:** the takeover still intercepts every pi compaction trigger,
  so pi's summarizer never runs (no wedge) — but *pi's threshold decides when*: with the
  default `reserveTokens` of 16384 it fires at `window − 16384` tokens, i.e. very eagerly
  on smaller windows (≈ 7.6 k tokens on a 24 k model). Disabling it hands timing fully to
  this extension.

The sandbox runner in this repo (`./run-golden-context.sh`) writes this setting into its
sandbox automatically.

## Commands

| command | what it does |
|---|---|
| `/golden-status` | store state, config, spent ids, context usage line |
| `/golden-render` | the exact `<golden>` bytes the model sees right now |
| `/golden-commit [kind] [spend:ids] <text>` | model-independent checkpoint/decision commit |
| `/golden-eject` | dry-run: what would be ejected/stripped right now |
| `/golden-undo [n]` | hard-truncate the store by the last N entries (default 1); popped lines are **archived** to `golden.undone.jsonl`, never deleted. Undoing a checkpoint lifts its purge coverage — messages still in the live branch reappear next request (entries pi already sealed into a compaction stay sealed). Seq numbers are never reused, even across restarts (the archive holds the high-water mark). Assumes **one pi writer per scope dir** — concurrent sessions in the same directory can race the truncate |

## Configuration

Load order: `PI_GOLDEN_CONFIG=<path>` env → `<agentDir>/golden-context/config.json` →
built-in defaults.

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | master switch (`false` = full no-op) |
| `autoCheckpoint` | `true` | run checkpoints (idle + in-flight) automatically |
| `contextFullPct` | `80` | % of the model window (measured, KV-anchored size) that triggers the in-flight fold |
| `takeoverCompaction` | `true` | `/compact` & pi triggers run our compaction (set `false` to A/B against pi's built-in behavior) |
| `checkpointPolicy` | `"with-tools"` | only checkpoint turns that made tool calls (`"always"` = every turn) |
| `summaryMaxTokens` / `summaryTargetTokens` | `512` / `128` | evidence call caps |
| `callLineMaxChars` | `160` | tool-call line truncation inside checkpoints |
| `hollowCoveredText` | `true` | fold covered text into handles (lossless) |
| `prefillAfterCheckpoint` | `true` | every idle settle warms the predicted next-request bytes with one `max_tokens=1` request — folded or unfolded (so post-takeover compaction is covered), based on the *observed wire* system prompt with the golden block swapped in; byte-dedup + one 3s deferred re-check (FINDINGS §16) |
| `autoEjectOldToolResults` | `false` | additionally auto-prune old/large tool results (conservative) |
| `tailKeepToolResults` | `4` | results kept in the tail when auto-ejecting |
| `minResultBytesToEject` | `2048` | auto-eject size floor (text-only results) |
| `stripThinkingOnSpend` | `true` | strip thinking of explicitly-spent turns (DISTILL) |
| `maxGoldenSectionBytes` | `16000` | render cap for the `<golden>` section (oldest lines drop) |
| `scope` | `cwd` | store scoping: `cwd` (one store per launch directory), `git` (one per repo, `cwd` fallback), or `global` (single machine-wide store — the behavior before store scoping existed) |
| `goldenStoreRel` | `golden-context/golden.jsonl` | store path relative to the agent dir; the `scope` key is inserted as a directory segment |
| `handleTemplate` | see config | the eject-handle text |

## Environment variables

| var | effect |
|---|---|
| `PI_GOLDEN_DUMP=1` or `PI_GOLDEN_DUMP=<path>` | record every provider request body (agent / evidence / prefill) — *what the LLM actually sees*. Default path: `<agentDir>/golden-context/requests.jsonl` |
| `PI_GOLDEN_DEBUG=1` | trace prefill / skip decisions to the UI |
| `PI_GOLDEN_CONFIG=<path>` | alternate config file |
| `PI_DIR=<path>` | *(tests)* pi install dir; default: auto-detected from the `pi` binary on `PATH` |

## Where your data lives

- **Golden store**: `<agentDir>/golden-context/<scope>/golden.jsonl` — append-only JSONL, scoped by
  launch directory (`scope`, default `cwd`) so a new project starts with a fresh golden instead of
  inheriting another project's decisions. `<scope>` uses pi's own per-directory naming
  (`--some-repo-subdir--`), so it lines up with `sessions/--…--`; `PI_CODING_AGENT_DIR` still
  relocates the whole thing, keeping it portable and isolatable.
- **This repo ships no session data.** The replay harness needs a session JSONL of your
  own (`PI_REPLAY_FIXTURE=…`); it copies the file per test arm and never modifies the
  original.
- `PI_GOLDEN_DUMP` output and `FINDINGS.md` may contain conversation content and local
  paths — think twice before sharing either.

## How it works

```
[system][golden: …ckpt₁ ckpt₂ ckptₙ][purged tail][final reply]
                                   ↑ new checkpoint appends ↑
```

- The `<golden>` system-prompt section is injected via `before_agent_start` and
  **section-diffs** stably, so growth is a stable prefix — only the newest bytes are ever
  (re)prefilled.
- Purge runs on **raw transcript roles first**, then the LLM projection
  (`convertToLlm`-style), matching pi's pipeline exactly — verified: the prefill body is a
  strict prefix of the next real request (21573/21574 chars; only the trailing new user
  message differs), system + tools byte-identical.
- **All triggers size from an engine-measured anchor**, never from the chat history: the
  prompt tokens of the last response (`input + cacheRead + cacheWrite` — what actually sat
  in the KV cache) plus a chars/4 estimate of only what was added since. Raw history reads
  "full" while the cache is mostly empty; pi's own threshold check falls back to exactly
  that (stale pre-compaction usage or whole-window estimates — findings §14), which is why
  the takeover gate exists.
- Evidence calls are capped (`maxTokens` 512, `timeoutMs` 20000) — bounded by construction.

Design rationale, reproduction recipes, and every verified assumption:
**[FINDINGS.md](FINDINGS.md)** (§11 = the compaction wedge root-cause, §13 = the takeover).

## Development & tests

```sh
node test/run.mjs          # offline suite — no GPU, no model, no pi startup (151 checks)
./test/scope-e2e.sh        # real pi, two directories, no GPU: proves per-directory golden
                           # negative control: SCOPE_OVERRIDE=global ./test/scope-e2e.sh must FAIL
./test/replay.sh [arm]     # drives REAL pi over RPC against a mock backend
                           # arms: pi-only | plugin | plugin-eject | plugin-ckpt | plugin-hang
node test/loader-probe.mjs <agentDir>   # pi's real loader accepts the extension
./run-golden-context.sh    # isolated sandbox TUI (never touches ~/.pi); --selfcheck for CI
```

- `test/replay.sh` needs `PI_REPLAY_FIXTURE=<your session JSONL>` (no session data ships
  with the repo).
- `test/tui-probe.py` drives the real interactive TUI over a PTY; `test/mock-backend.mjs`
  is the mock model backend (`MOCK_HANG_SUMMARY=1` wedges the summarizer to reproduce
  pi's bug — that's the `plugin-hang` arm, which sets `takeoverCompaction: false`).

## Known limitations (alpha)

- **Version drift**: verified on pi 0.86.1; the extension API is young. Hook-signature
  drift fails loudly at load; drift in pi's `convertToLlm` strings degrades warm prefill
  to a cache miss (safe, never corrupt).
- **Cold start**: until the first response lands there is no measurement to anchor on, so
  the very first request is sized with the full-history estimate (bounds the problem only
  until usage arrives).
- **Prefill degrades** if another extension appends a custom system-prompt section *after*
  the golden one: the splice gate refuses and skips the prefill (nothing else breaks).
- **No rescue for a single oversized message**: if one message alone exceeds the window,
  there is nothing left to fold.
- **Store grows unbounded** (append-only by design); past `maxGoldenSectionBytes` the
  render drops the oldest lines.
- One ≤ 512-token evidence call per checkpoint — tune `checkpointPolicy`,
  `autoCheckpoint`, or `contextFullPct` if per-turn cost matters on cloud models.

## License

[Apache-2.0](LICENSE)
