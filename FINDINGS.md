# Golden Context / In-Flight Compaction — verified findings against the installed stack

Purpose: reconcile the pasted `Lumo_golden-contex.md` + `Lumo_in-flight-compaction.md`
strategy with the inference stack that is actually installed, and record the
design the user confirmed on 2026-10-10, before committing to a `pi` plugin build.
Every "Reality" line below was checked against the live builds, not the doc text.

## Thesis (user-confirmed 2026-10-10)

This is a **compaction policy + timing** design, not a KV-storage design.

| Layer | Contents | Decided by | Timing |
|-------|----------|-----------|--------|
| **Tail** | last N turns verbatim | harness (cheap rotation) | continuously |
| **Filter** | record / summarize-as-churn / discard | **the model, while generating** | in-flight |
| **Golden** | committed decisions + summaries, **append-only** | **the model** (explicit commit signal) | when committed |
| **Load** | restore golden at session start | harness | once |

**Why it is more efficient:** a conventional compactor *rewrites* old turns into a
summary, which breaks the cached KV prefix and forces a full re-prefill. Here the
**golden block is append-only and model-committed**, so the long prefix stays warm;
only the small rolling tail plus the new decision are prefilled. Compaction never
touches bytes that are already cached. **The win is prefix-cache *stability*, not
survival across server teardown.**

**Confirmed commit mechanism:** a **structured tool call** (e.g. `commit_decision`),
observed by a harness hook — not a prose meta-tag. (Contingent on pi's tool API; see §5.)

## 0. Terminology collision (do not conflate these)

The pasted strategy and your existing `prefix_caching_runway/` docs share words
("prefix caching", "head/tail", "runway", "warm") but describe **two different
objects**:

| | `prefix_caching_runway` (existing prior art) | this strategy (pasted docs) |
|---|---|---|
| What is cached | **model weight tensors** (RAM head vs NVMe tail) | **prompt KV activations** (the append-only golden conversation prefix) |
| Mechanism | `mlock` + `madvise`/`io_uring` tiered weight streaming | prompt-cache + model-driven append-only commit |
| Status | `DESIGN_REVIEW.md` verdict: **DO NOT INTEGRATE AS-IS** (races, alignment, `cb_eval` misuse); collides with staged PR #26824 MoE hot-store | n/a |

Building in-flight compaction does **NOT** touch or reuse the runway weight-tiering
code; the runway's defects are irrelevant here. The shared vocabulary is a trap.

## 1. Per-claim verdict table (pasted doc vs. installed engines)

Engines under test:
- `beellama.cpp` v0.4.6-dev (build 11794, commit `78af83265`), fork of
  `github.com/Anbeeld/beellama.cpp` — Occamy model.
- `llama.cpp-vanilla` (nemotron-expert-padding patch) — nemotron model.

| # | Document claim | Reality on the installed stack | Verdict |
|---|---|---|---|
| A | `--cache-prompt` server flag | Present on **both** builds; **default: enabled**. Config already passes it for occamy. | ✅ real, already on |
| B | `--kv-unified` flag | Present on both builds; already set for occamy. | ✅ real, already on |
| C | `--slot-save-path=…` | Present on both builds (default disabled; not set in config). | ✅ real, unused |
| D | `POST /control/context/load` | **Does not exist.** Only routes are `GET /slots` and `POST /slots/:id_slot` (`server.cpp:286-287`). | ❌ fictional endpoint |
| E | "slot states keyed by prefix hash", saved as `golden_${SESSION}.json` | Two mechanisms conflated. Slot save/load writes **binary `<name>.bin` + `<name>.meta`** keyed by a **chosen filename** (`server-context.cpp:5485 action=="save"`, 6001-6003). Prefix-hash reuse is the *in-memory prompt cache*, not the on-disk slot file. | ❌ wrong mechanism |
| F | `n_predict:0` with empty `prompt` to "pre-warm" | An **empty** prompt caches nothing. Caching happens when the *actual* stable prefix is sent (prompt-cache runs on prefill). | ⚠️ misleading |
| G | `slot_id:42` pinning per request | Fork supports slot ids (`--kv-unified-per-slot`, `/slots/:id`), but the OpenAI `/v1/chat/completions` path pi uses does not pin a slot per turn, and llama-swap multiplexes — see §2. | ⚠️ clashes with the proxy |
| H | "reuse warm KV on tail, only prefill new decisions" | **The engine has the necessary flags present and enabled, but actual prefix-cache hits for `pi`-shaped traffic are UNVERIFIED.** `--cache-prompt` + `--cache-idle-slots` (**default on**, needs `--cache-ram 2048`, which you set) + `--kv-unified` + `--ctx-checkpoints 2` *can* retain warm prompt KV and reuse a stable prefix — but flag presence ≠ cache hit. Whether a byte-identical golden prefix in `pi` requests actually reuses KV across turns is an open empirical question (§5). No engine recompile is expected to be needed for v1, pending that measurement. | ⚠️ flags exist; cache-hit behavior for pi traffic unverified |

## 2. The llama-swap reality that bounds *persistence* (an optional hardening, not the core)

Because the efficiency win is **prefix stability while the server is alive** (§1-H),
the fork flags already deliver it. The one place llama-swap still bites is the
**golden prefix losing its warm KV on process teardown**:

- `globalTTL: 1800` → after 30 min idle the model process is torn down; with it goes
  the in-RAM prompt cache / slot KV / ctx-checkpoints.
- Switching occamy ↔ nemotron kills the server → warm KV gone; the golden text
  reloads and re-prefills on the next request.

So "golden survives a reload" = **nice-to-have hardening**, achieved only by
`--slot-save-path` + real `POST /slots/:id {action:save|load}` around teardown/startup
(binary files, not JSON), or by raising the TTL / pinning the model. It is NOT the
idea's core and does NOT require recompiling the engine.

**Verify (not yet confirmed):** whether llama-swap **proxies** the backend's native
`GET /slots` / `POST /slots/:id` through :8080, or only the OpenAI routes. This
decides whether a pi plugin can reach slot save/load at all without bypassing the
proxy — only relevant if you later opt into §2 hardening.

## 3. Fork tooling already present (don't reinvent)

- `beellama.cpp/tools/server/tests/prompt_cache_real_usage.py` — harness that
  **measures** whether the prompt cache actually hits across requests. This is the
  instrument to confirm the append-only golden prefix really keeps hitting the cache.
- `test_kv_tail_prompt_cache.py`, `test_kv_keep_only_active.py` — exercise
  `--cache-idle-slots` / checkpoint behavior (`__TEST_TAG_CACHE_IDLE_SLOTS_ENABLED__`).

## 4. Config-comment inconsistency (flag, do not silently fix)

The `nemotron-lightning` block comment says the vanilla build has
"no cache-ram/kv-unified/cache-prompt/ctx-checkpoints (beellama fork features)".
But `llama.cpp-vanilla … --help` **does** list `--kv-unified`, `--cache-prompt`,
`--cache-idle-slots`, `--slot-save-path`. Either the comment is stale or only some
of those are functional on vanilla. Confirm against vanilla `--help` for `--cache-ram`
/ `--ctx-checkpoints` / `--checkpoint-min-step` before trusting it.

## 5. Verification gates — evidence, not code, is the next step

The strategy is conceptually aligned with the user, but two assumptions are still
unproven. Do **not** write plugin code until both gates return.

### Gate A — does the engine actually reuse the golden prefix's KV for `pi` traffic?
Flag presence (§1-H) does not prove cache hits. Required experiment:
- Use the fork's `tools/server/tests/prompt_cache_real_usage.py` (or a controlled
  two-request fixture) against Occamy with the *same* flags the config uses
  (`--cache-prompt --cache-idle-slots --cache-ram 2048 --kv-unified --ctx-checkpoints 2`).
- Prefer **server-side evidence** (prompt-eval / cache-hit counts from logs or the
  harness output) over wall-clock latency, which is noisy.
- Test **both** raw `/completion` with a fixed long prompt **and**
  `/v1/chat/completions` with a fixed message list shaped like pi traffic —
  the OpenAI path may behave differently.
- ⚠️ If loading the 14.7 GB GGUF requires starting a server **outside** the running
  llama-swap process, **ask the user first** — do not disrupt the shared stack.
- Treat `--ctx-checkpoints 2` (config) vs the README/test default of 32 as a variable,
  not a defect. Do not change the shared config until the experiment justifies it.

### Gate B — does `pi` expose the needed plugin surface? **RESOLVED 2026-10-10: YES** (matrix in §7).
`pi` v0.86.1 has a supported, **jiti-loaded Extension API** (`~/.pi/agent/extensions/*.ts`;
the dir is currently empty = clean target). Every required hook exists; **no fork, no HTTP
proxy** needed. The `package.json` export `"./experimental/plugin"` is declared-but-**not
shipped** (`dist/experimental/` absent) — do not chase it; use Extensions. Only nuance:
guaranteeing *identical serialized wire bytes* (vs just identical messages) is reachable
from an external plugin via `before_provider_request` or a custom `streamSimple`.

### Known hazards the experiment must also cover
- **Tool schema stability:** if the `commit_decision` schema is dynamically rendered or
  the tool list order changes per turn, it invalidates the prefix → cache miss. Verify
  byte-stable tool rendering.
- **Canonical golden serialization:** golden may be stored JSONL, but prompt injection
  must come from an immutable canonical form. Old golden bytes must never be rewritten;
  volatile metadata (timestamp, source turn id, checksum over older entries) must NOT
  re-render committed entries — append only. Truncation for rollback is valid but
  invalidates cache from the cut point onward (expected, not a bug).
- **Tail/golden promotion boundary:** when a tail item is committed to golden, define
  whether the verbatim tail copy is kept until natural roll-off, removed on promote,
  or replaced by a handle. Not a blocker; make it explicit before implementing.

## 6. pi plugin contract (confirmed design; API RESOLVED — see §7)

An external pi plugin must, per the confirmed thesis:

1. **Own the context layout** so the request keeps a byte-stable prefix:
   `[system][golden, append-only][rolling tail][new turn]`. If pi re-renders the
   golden block differently per turn, the prefix hash changes and the cache misses —
   defeating the entire win. The plugin must guarantee golden bytes never change once
   committed.
2. **Register a `commit_decision` tool** the model calls to promote an outcome into
   golden (record) vs summarize-as-churn vs discard.
3. **Intercept the tool call** via a hook and append to the append-only golden store
   (append-only JSONL is the natural format; enables the review/rollback the original
   doc valued).
4. **Rotate the tail** in the harness (keep last N turns verbatim); golden is
   append-only, tail is the only mutable region.
5. **(optional, later) teardown persistence** per §2 — only if the warm-prefix loss on
   TTL/model-switch reload is measured to matter.

All of items 1–5 are **reachable from an external Extension** (see §7). The plugin drops
into `~/.pi/agent/extensions/golden-context.ts`, default-exporting
`function (pi: ExtensionAPI) { pi.on(...) ; pi.registerTool(...) }`.

**Correction (verified 2026-10-10):** my earlier provisional lead that `~/.pi/context-mode/`
"hinting pi already has a context-shaping feature" was **wrong**. That dir exists on disk
but is **stale SQLite** (`.db`/`-wal` files last touched Sep 6; live agent dir is Oct 9)
with **0 references** in the shipped v0.86.1 package. It is a **legacy/abandoned artifact**,
NOT a mechanism to build on. pi's current persistence is JSONL sessions
(`~/.pi/agent/sessions/--<cwd>--/<ts>_<id>.jsonl`) + the `SessionManager` + the built-in
`compaction/` and `cache-warmer.js` subsystems (§7.1).

## 7. pi capability matrix + what pi already does

Source: `Explore` agent map of `@earendil-works/pi-coding-agent@0.86.1`, paths relative to
`.../pi-coding-agent/`. All citations verified against unbundled `dist/` (bundled chunks in
`dist/bundle/` are third-party SDK noise).

| Capability | Verdict | Mechanism (file:line) |
|---|---|---|
| Stable prefix injection | **PARTIAL** | Message-level yes: `context` event `types.d.ts:515` returns `{messages}`; leading system msg is stable across turns (section patches only, `system-prompt.js:67/150`, `session-manager.js:201`). Keep golden in `preamble`/`addendum`; **never** set `forceSystemPrompt`/return `systemPrompt` (documented cache miss). Exact *wire* bytes need provider control → `before_provider_request` `types.d.ts:518` or custom `streamSimple`. |
| Custom tool `commit_decision` | **YES** | `ExtensionAPI.registerTool(ToolDefinition)` `types.d.ts:1017+` (TypeBox params, `execute(...)`). |
| Intercept tool call before model continues | **YES** | `tool_call` event `types.d.ts:~757` (`{block,reason,terminate}`, mutable `input`); then `pi.appendEntry`/`pi.sendMessage({customType})`. |
| Session start/end hooks | **YES** | `session_start`/`session_shutdown` (`reason`, `previousSessionFile`) in `types.d.ts`. |
| Provider transport | OpenAI-compat `/v1/chat/completions`, **streaming**; NOT raw `/completion` | Built-in llama ext `dist/extensions/llama/provider.js` → `api:"openai-completions"`, baseUrl `${LLAMA_BASE_URL:-http://127.0.0.1:8080}/v1` (`client.js:103`). pi emits **no** `cache_prompt`/`/slots`/`slot_id`. |
| `~/.pi/context-mode/` | **legacy, ignore** | stale SQLite, 0 pkg refs (verified this session). |

### 7.1 What pi already does → the genuinely-new delta is narrow

pi **already ships both halves** of the golden-context idea, in different form:
- **Rewrite-based compaction**: `dist/core/compaction/` + `session_before_compact`/`session_compact`; seals old turns into a `CompactionEntry.systemMessage` checkpoint (`firstKeptEntryId`). This is exactly the approach the strategy *rejects* (it rewrites the prefix → cache miss).
- **Prompt-cache warmer**: `dist/core/cache-warmer.js` `CacheWarmer` + `cache_warming_decision` event + `PI_CACHE_RETENTION` (`short|long`), Anthropic-style `cache_control` markers (`compat.cacheControlFormat`). pi keeps a cache entry alive by re-sending with `maxTokens:1` before TTL.

**So the plugin's real contribution = replacing pi's rewrite-compaction with append-only,
model-committed golden commits, while keeping pi's stable-section prefix + cache-warming
intact.** Not building a KV system from scratch.

### 7.2 Wire mismatch — sharpens Gate A (§5)

pi's caching is **`cache_control` markers + a warmer**; beellama's is **automatic prefix
caching** (`--cache-prompt`, `--cache-idle-slots`+`--cache-ram`, `--kv-unified`), keyed on
*identical leading tokens*, ignoring `cache_control`. pi's own llama path never emits
`cache_prompt`. ⇒ Under pi→llama-swap→beellama, the golden prefix hits beellama's automatic
cache **only if the leading serialized tokens are byte-identical across turns**. Gate A must
measure exactly that (server-side prompt-eval/cache-hit counts, not latency), and check whether
pi's `maxTokens:1` warmer re-send is helpful or a wasted prefill against llama.cpp.
`--ctx-checkpoints 2` (config) vs fork default 32 is a variable in this test, not yet a defect.

## 8. STATUS 2026-10-10 — v1 skeleton built + offline-tested

Goal corrected (per user): **eject spent tool results → smaller working set → run at a lower
`--ctx-size` → free VRAM → offload more MoE experts to GPU → speed** (the "VRAM-for-experts"
chain), with append-only golden as the stable, warm-cache prefix. Layer choice: **rely on
beellama's automatic prefix cache** (no custom provider, no engine recompile for v1).

Built in `golden-context/`:
- `golden-core.ts` — pure, pi-independent logic (config, canonical golden render, ejection).
- `golden-context.ts` — thin adapter wiring verified pi hooks: `before_agent_start`→
  `systemPromptOptions.sections["golden"]` (stable prefix); `context`→ spent-toolResult
  **ejection by content-swap, never deletion** (keeps tool_call↔toolResult pairing);
  `commit_decision` `registerTool` for the model-committed signal.
- `golden-context.config.json` — conservative defaults (`autoEjectOldToolResults:false`).
- `test/run.mjs` — offline jiti test w/ stubbed pi: **26 checks pass**, incl. the two load-bearing
  invariants (render is a strict string prefix of its future self; ejection never deletes).

Still NOT done (deliberately deferred / needs consent):
- Loader smoke test against real pi (loads Occamy on shared `:8080` → needs user OK).
- **Gate A**: prove the byte-stable prefix actually reuses KV for pi traffic (`/slots` is
  NOT proxied at `:8080` — confirmed via probe; read `usage`/`timings` or backend port instead).
- The provenance "spent" rule and any engine/`--ctx-size` tuning ("set up plugin first, then
  tune rules/engine" — user directive).

## 9. The DISTILL rule (user-provided 2026-10-10) — implemented + verified-feasible

User's rule: rewrite `⟨thinking_i, tool_output_i⟩ → ⟨tool_input_{i+1}, hindsight_i⟩` — once the
next action encodes what was extracted, eject reasoning + raw output, keep a distilled "hindsight".
Unit of ejection is a **turn triple**; supersession is semantic, not size/recency. Goal: slow
growth of *used* context (more turns before full compaction), less clutter; (hypothesis) less drift.

Verified feasible against the real pi serializer (`transform-messages.js`): `ThinkingContent` is a
strippable assistant block (pi-ai `types.d.ts:247–355`); llama compat does NOT set
`requiresReasoningContentOnAssistantMessages` → stripping reasoning is safe; pi injects synthetic
results for orphaned calls → confirms collapse-in-place, never delete.

Implemented: `applyEjection` strips `ThinkingContent` from any assistant turn that emitted a spent,
non-protected `toolCallId` (gated by `stripThinkingOnSpend`, default true; auto-eject never strips
reasoning); added `distill` to `DecisionKind`; `context` handler fires on `reasoningStripped>0` too.
Offline suite **33/33**, incl. explicit DISTILL tests (strip, absolute-tail protects reasoning,
`stripThinkingOnSpend=false` fallback, `distill` round-trip).

Honest caveat: "reduces drift" is a model-behavior hypothesis needing task-quality eval, not token
counts. See `golden-context/README.md` §2 for the isolated self-test.

## 10. The pi hang (2026-10-10) — root cause, and golden-context was NOT in it

A pi session run in this repo froze (`01a12612…`, 13:48:33Z→13:57:50Z, exported as the repo's
`pi-session-*.html`). Final entry is the fingerprint:

```
usage{input:3771, cacheRead:18754, total:22526, output:1}  stopReason:"length"  rawStopReason:"length"
content:[{type:"thinking", thinking:"The", thinkingSignature:"reasoning_content"}]
provider:"llamacpp"  model:"strata-coder"
```

### 10.1 The extension was not loaded in that run — three independent proofs

1. `~/.pi/agent/extensions/` is **empty** (dir mtime Sep 12) → nothing to auto-discover.
2. `~/.pi/agent/golden-context/` **does not exist**, but our `session_start` calls `ensureStoreDir`
   → any load would have created it.
3. The session's stored system message sections are `preamble, tools, rules, docs, cwd` — **no
   `golden` key** — and `commit_decision` appears nowhere in the session as a tool call. The file
   also lives in the **live** agent dir (`sessions/--home-nos-labware-pi-ctx--/`), so
   `PI_CODING_AGENT_DIR` was unset: this was plain `pi`, not `run-golden-context.sh` (whose sandbox
   has no `sessions/` dir at all).

So the hang cannot be attributed to our ejection loop: that code never executed.

### 10.2 The mechanism: pi floors `max_tokens` to 1 near the window edge

`pi-ai/dist/api/simple-options.js:3-9`:

```js
const CONTEXT_SAFETY_TOKENS = 4096;
const MIN_MAX_TOKENS = 1;
clampMaxTokensToContext(model, ctx, maxTokens) =
    Math.min(maxTokens, Math.max(1, model.contextWindow - estimateContextTokens(ctx).tokens - 4096));
```

`strata-coder` declares `contextWindow: 24000` in `~/.pi/agent/models.json` (written 16:47 local —
one minute before that run) and the Strata engine is configured `--max-context 24000`, so the two
agree. The floor therefore bites at `24000 - 4096 - 1 = 19903`: past it pi requests **exactly one
token**, the model emits one reasoning token (`"The"`), and the turn yields no text and no tool call.

pi cannot self-diagnose this (`pi-ai/dist/utils/overflow.js:131-158`): Case 2 (silent overflow)
requires `stopReason === "stop"` (we have `"length"`); Case 3 (server-truncated) requires
`usage.output === 0` (we have `1`). Neither fires, so it is never classified as overflow.
`isRecoverableLength(msg, model.maxTokens)` **is** true (`1 < 8192`) → `willRetry` → pi spends its
single compact-and-retry; a second such reply emits *"Truncated response recovery failed after one
compact-and-retry attempt."*

### 10.3 Why pi's own compaction cannot rescue a 24k window

Defaults (`compaction/compaction.js:76-80`): `reserveTokens 16384`, `keepRecentTokens 20000`;
`shouldCompact` fires at `tokens > 24000 - 16384 = 7616`. The arithmetic problem is the *retain*
side: after compacting, pi keeps `keepRecentTokens = 20000` verbatim, but a 24000 window minus
pi's own 4096 safety reserve leaves ~11712 for everything else. Compaction can therefore free
almost nothing, `max_tokens` stays clamped, and no amount of retrying makes progress.

### 10.4 GPU-free reproduction + A/B (`golden-context/test/mock-backend.mjs`, `ab-cliff.sh`)

`mock-backend.mjs` is a dependency-free OpenAI-compatible backend that logs each request
(`max_tokens`, msg roles, prefix hash/bytes, on-the-wire ejection-handle count) and is deliberately
*honest*: asked for ≤8 tokens it returns one token + `finish_reason:"length"` — the signature above.
`ab-cliff.sh` runs the identical prompt per arm against a fresh server (`contextWindow 24000`,
`maxTokens 8192`, 5 bash rounds × 20 000 chars):

| arm | est trajectory | after compaction | last `max_tokens` | verdict |
|---|---|---|---|---|
| `inert` (ext `enabled:false`, pi defaults) | 1806→6882→11959→17035 | **17831** | **2330** | compaction frees ~0 → keeps decaying |
| `budgetfix` (`reserveTokens 4096, keepRecentTokens 6000`) | 1806→…→17035 | **7678** | **8192** | recovers full response budget |
| `autoeject` (golden-context `autoEjectOldToolResults:true, tailKeepToolResults:2`) | 1806→…→**12052** (`handles=1`) | **12847** | **7314** | ejection holds it clear of the clamp |

`handles=1` at turn 4 is the proof the `context` hook rewrote a spent 20 000-char result *before*
pi serialized it: est 12052 vs 17035 for the same conversation position (≈4983 tokens, i.e. exactly
one 20 000-char result collapsed to a handle). An 8-round variant reached `max_tokens=1` and
`pi -p` exited with **0 bytes on stdout** — the empty/no-progress answer the user sees as a freeze.

Fix on the live stack (pi-side; keys must be exact `provider/modelId`, per `docs/settings.md:144,164`):

```json
{ "compaction": { "modelOverrides": { "llamacpp/strata-coder": { "reserveTokens": 4096, "keepRecentTokens": 6000 } } } }
```

### 10.5 What the same experiment PROVED about golden-context (closes §8/§9 "open" items)

All three links observed on **real pi**, no model load, no llama-swap request:

1. **Loader + registration**: `commit_decision` present in `tools[]` of every agent request
   (`['bash','commit_decision','edit','read','write']`) → user-dir `extensions/golden-context/index.ts`
   importing a sibling `./golden-core.ts` resolves under pi's jiti loader. `LOADER: PASS` re-confirmed.
2. **Commit + store**: `execute` wrote `golden.jsonl` —
   `{"seq":0,"ts":…,"kind":"distill","text":"…","spend":["call_mock_bash_1"]}`.
3. **Append-only golden injected as a stable section**: a **fresh** session seeded with one entry
   sent it inside the system prompt, pi XML-wrapped, verbatim:
   `… the live message tail.\n- [0] (distill) INJECT-CANARY-7731 durable decision line\n</golden>`.
4. **Gate A on genuine pi payloads (leading prefix)**: `prefixBytes=7082` with identical
   `prefixHash=1a056137be` across every agent-loop turn of a session (only the separate
   compaction-summary request differs). pi's system+tools serialization is byte-stable turn to
   turn — the assumption the append-only design rests on.

### 10.6 Real-engine prefix-cache evidence from the hung session (side result)

That session's usage table shows `cacheRead` ≈ the previous turn's `totalTokens` every turn
(1591→1880→2721→9880→10588→13437→14318→15750→17391→18754): strata-coder reused the whole leading
prefix each turn (~83 % of the final 22526-token request served from cache). Genuine pi traffic
does hit automatic prefix caching. The mock's `cached_tokens` is synthetic and is **not** engine
evidence.

### 10.7 Not proven / still open

* **Where those last minutes actually went.** Proven: pi requested 1 token and got an empty turn.
  Not proven: the freeze itself. The session writes **no** `compaction` entry, and there is no
  request/response timeout anywhere in pi's path (`timeoutMs` never set in `agent-session.js`; no
  `setTimeout` in the openai-completions API), so the most consistent explanation is pi waiting on
  an in-flight request the engine never completed. That is an engine-side question, not a
  plugin-side one.
* Whether the Strata engine hard-stalls when its 24000 pool is full while `--prompt-cache 2`
  retains older prefix copies — needs a look at that server, not a guess.
* DISTILL with a **real** model: the mock proves pi's plumbing, not whether a model spontaneously
  calls `commit_decision` and writes useful hindsight.
* "Reduces drift" still needs task-quality eval, not token counts.

## 11. The compaction wedge (2026-10-11) — reproduced, and it is NOT the plugin

Trigger: interactive use of the plugin reported "when compaction triggers, some of pi's essential
features become unresponsive — /export stopped functioning after our in-flight compaction
triggered". Investigated with two new GPU-free harnesses driving **real pi 0.86.1** over its JSONL
RPC protocol (`test/replay.mjs` + `test/replay.sh`) and its real TUI over a PTY
(`test/tui-probe.py`), replaying the COPIED live session
`test/fixtures/session-01a12612.jsonl` (the §10 session, 30 messages / 22.5k tokens).

### 11.1 Root cause of "features become unresponsive": a hung summarization request wedges compaction forever

pi's compaction summary call (`compaction/compaction.js` `completeSummarization` →
`streamFn`/`completeSimple`) has **no timeout** and `compact()` awaits it directly. If the engine
never completes that request (the §10.7 stall class, llama-swap teardown mid-request, backend
hang), then:

* `AgentSession.isCompacting` stays `true` forever (the controller is only cleared in
  `_runAutoCompaction`'s `finally`);
* the TUI shows `Auto-compacting... (escape to cancel)` and **queues every non-extension-command
  input** into `compactionQueuedMessages` (`interactive-mode.js` submit + followUp paths) —
  effectively the whole input pipeline is dead;
* `session.prompt()` throws *"Cannot submit a prompt while compaction is in progress"*.

Reproduced deterministically with `MOCK_HANG_SUMMARY=1` (mock stalls exactly the summarization
request; matched on the `<conversation>`/summarizer-prompt content — note pi serializes system
prompts as role `developer`, not `system`): `replay.sh plugin-hang` reports
`prompt-1:TIMEOUT compact:TIMEOUT isCompacting STUCK`; the TUI probe shows the same spinner
frame for the rest of the run.

**Escape hatch that already exists:** Esc aborts the stuck compaction
(`onEscape → session.abortCompaction()`), which fires `compaction_end` and drains the queued
input. Extension-registered commands also run *during* the wedge (pi routes them before the
isCompacting queue) — see §11.3.

### 11.2 /export is NOT part of the wedge (both engines of evidence)

Screen-level evidence from the real TUI during a stuck auto-compaction: `/export` printed
`Session exported to: pi-session-tui-session.html` *between* `Auto-compacting` spinner frames,
and the file is a complete, valid 408 KB HTML. Same via RPC (`export_html` answers while
`isCompacting=true`). pi dispatches slash commands *before* the compaction queue check
(`interactive-mode.js` submit handler), and `exportSessionToHtml` is defensive about custom
tools (try/catch → template fallback). So the reported "/export stopped functioning" is **not
explained** by compaction + this plugin so far; likely candidates are a transient status-toast
being covered by the compaction indicator, or a different failure mode. Repro question for the
user: exact symptom (error text vs. silence vs. "Queued message for after compaction").

### 11.3 Discrete commands added (the human-triggerable seam)

`registerCommand` now exposes: `/golden-status`, `/golden-render`,
`/golden-commit [kind] [spend:ids] <text>` (model-independent commit — drives DISTILL ejection
by hand), `/golden-eject` (dry-run of what the `context` hook would prune). These execute even
while compaction is wedged, so they double as live diagnostics ("find where the trouble starts").
Offline suite: 51/51. In the `plugin-eject` arm the dry-run on the old session reports
`would change 12 message(s) … ~54943B removed` — "our compaction" applied to a real transcript.

### 11.4 Harness traps found along the way (documented so they don't bite again)

* **Session files must not live directly in the agent dir**: pi's startup migration ("migrate
  sessions from `<agentDir>/*.jsonl` to proper session directories") *moves* such files into
  `sessions/--<cwd>--/`, and `--session <path>` then silently starts a **fresh** session at the
  old path. Keep replay copies outside `PI_CODING_AGENT_DIR`.
* pi's default `compaction.keepRecentTokens=20000` makes `prepareCompaction` find nothing to cut
  in a 22.5k-token session → *"Nothing to compact (session too small)"*. The replay sandbox sets
  `compaction.modelOverrides["mock/tinyclip"] = {reserveTokens: 4096, keepRecentTokens: 6000}` —
  the same shape as the live fix from §10.4.
* A shell-var-expanded env prefix (`MOCK_ENV=1 node …` with `$MOCK_ENV` from a variable) is
  parsed as a *command*, not an assignment — the hang arm's mock silently never started until
  this was switched to an explicit `env …` invocation.

### 11.5 Open after this session

* The exact /export symptom (see §11.2) — needs the user's observation.
* Whether golden-context should **take over compaction** via `session_before_compact` (return a
  golden-derived summary instead of letting pi call the model) — this removes the wedge
  by construction (no model call in the compaction path) and is the natural home for "our
  compaction rule". Not implemented; a design decision.
* Real-engine runs (Occamy): llama-swap vs `~/scripts/run_occamy.sh` — the replay harness is
  engine-agnostic (mock by default); pointing it at the real stack needs the user's call on
  stopping the llama-swap service.

## 12. Idle checkpointing v2 (2026-10-11) — user spec, implemented + wire-verified

User spec (confirmed while the wedge work of §11 was landing): in-flight compaction runs
**automatically after the agent hands the session back to the user**, so compaction is
underway while waiting. Per idle turn: (1) the model summarizes tool-call outputs as
empirical evidence against the thinking trace — short, max 512 tokens, target 128;
thinking allowed on that call but only the reply is kept; (2) thinking + tool outputs are
purged and the tool calls are listed line-by-line followed by the summary; (3) that block
goes above the last message for the user (the assistant's final reply text stays verbatim);
(4) the old-context checkpoint is appended (tool-call + summary + user message) — "the
checkpoint IS the golden context", it grows — and a prefill runs again so the session is
already getting ready while waiting for the user.

Implemented in `golden-core.ts` + `golden-context.ts` (offline suite 91/91):
`collectCheckpoint` (coverage split: coveredTs excludes the live reply, keepTs = its ts),
`buildCheckpointText`, evidence call via `ctx.modelRegistry.streamSimple` (capped 512,
text-only result), append-only `checkpoint` golden entries (coveredTs/keepTs recorded for
cross-reload purge continuity), coverage-aware `applyEjection` (purges covered outputs +
ALL covered thinking; folds covered text losslessly; keep-reply verbatim; overrides
tailKeep only for the covered range), and the warm prefill.

**Wire verification (replay.sh plugin-ckpt, PROMPTS=2 GAP_MS=3500, MOCK_FULL=1):** the
prefill body is a **strict prefix of the next real request — 21573/21574 chars identical**
(divergence only at the trailing new user message); system text and tools[] byte-identical
(mock prefixHash equal). Three fidelity traps were found and fixed by that experiment:

1. **tools**: extension tools (commit_decision) arrive via a LATER system-message patch —
   the loadout must be resolved across all system messages (`resolveToolLoadout`, mirrors
   pi-ai getCurrentTools) or the warm request misses the cache after the system text.
2. **pipeline order**: pi applies `transformContext` (our purge) to RAW transcript roles
   and only then projects custom roles to user messages (convertToLlm). Folding after
   projection diverges (compaction summaries would fold where the real request keeps them).
   Mirrored by `toLlmMessages` (copied verbatim — the package `exports` map blocks
   importing pi's).
3. **first checkpoint**: the run prompt has no golden section yet (empty store) — the
   splice must append the whole wrapped section (`\n\n<golden>…</golden>`, pi joins
   sections with "\n\n"), not grow an existing one. `spliceGoldenSection` handles both and
   returns null unless byte-exactness is provable (prefill then skips).

Also fixed this session: the runner's `rm -rf $SBX` destroyed sessions/golden store
(sandbox now persistent at ~/.local/state/pi-golden-sandbox; `--fresh` opts into wiping),
and the compaction wedge of §11 is reproducible via `replay.sh plugin-hang`.

Open: real-model behavior on Occamy 96k (does the model keep calling tools usefully after
purge? does the evidence summary stay ~128 tok?); DISTILL's "reduces drift" still needs
task-quality eval; run the plugin-ckpt flow against the live stack (run_occamy.sh,
llama-swap stopped — user-approved) and compare prefill-vs-next request prefixHash there.

## 13. Compaction takeover (2026-11) — golden-context owns compaction; pi's is disabled

Direction (user): "Instead we should have our own compatible solution for when context is
full and disable Pi's built-in compaction." Implemented — three triggers, one machinery
(`commitCheckpoint`):

1. **In-flight (context-full)**: the `context` hook measures the request against
   `contextFullPct` (default 80) of the model's window and folds the covered history into
   a checkpoint *before the request goes out* — mid-run (`toolUse` turns included). This
   is the "compatible solution for when context is full" and replaces pi's overflow
   recovery.
2. **Idle** (`agent_settled`): the proactive per-turn pass + warm prefill + context
   counter (unchanged).
3. **Takeover** (`session_before_compact`): `/compact` and any pi trigger run OUR
   compaction — a golden checkpoint plus a short pointer summary, `firstKeptEntryId` =
   the live reply's entry. pi's rewrite+summarizer (the untimeouted wedge path, §11) is
   never invoked. `takeoverCompaction:false` A/Bs back to pi's behavior (the §11 wedge
   repro arm needs it). When nothing new is foldable the hook cancels — `/compact` right
   after a checkpoint reports "Compaction cancelled" rather than summarizing empty history.

pi's auto-compaction is additionally disabled at the runner level
(`run-golden-context.sh` writes `{compaction:{enabled:false}}` into the sandbox — no
`packages` key, which would trigger pi's npm install). The takeover hook is the safety
net for installs without that settings file. Evidence calls are time-bounded
(`timeoutMs: 20000`) so the takeover can never recreate the §11 wedge from our side.

Verified: offline 110/110; replay matrix green (plugin arms' `compact` step produced
`compaction` entries with `fromHook:true` + our pointer summary + correct
`firstKeptEntryId`; `plugin-hang` still wedges pi's summarizer on demand); loader PASS.

## 14. Compaction-hierarchy sizing bug: chat history instead of KV (2026-10-11)

**Symptom (user report):** "Pi is reading context size from the chat window history
instead of from the KV cache. The result is that Pi thinks context is full when it isn't
and keeps triggering compaction."

### Where pi sizes the context (0.86.1)

| path | sizing input | verdict |
|---|---|---|
| `calculateContextTokens(usage)` (`dist/core/compaction/compaction.js`) | `usage.totalTokens \|\| input+output+cacheRead+cacheWrite`. Their `llamacpp` provider (`api: "openai-completions"`) computes `input = prompt − cached − write` per response, so `totalTokens = prompt + completion` — the KV truth **for that response**. | correct |
| `estimateContextTokens(messages)` | anchors on the last assistant usage **found in the message list**, plus `estimateTokens` (chars/4, self-described *"conservative (overestimates)"*) for everything after it; **with no usable anchor it sums chars/4 over the entire chat window**. | history-based fallback |
| `_checkCompaction` (`agent-session.js:1752`, threshold case) | direct usage when valid; falls back to `estimateContextTokens` on `stopReason === "error"` / zero usage — and **has** a stale-usage guard: *"Kept pre-compaction messages have stale usage reflecting the old (larger) context and would falsely trigger compaction right after one just finished."* | guarded |
| `_compactBeforeNextAssistantResponse` (`agent-session.js:282`), installed as the per-turn `prepareNextTurn` refresh — runs **before every assistant response** | `shouldCompact(estimateContextTokens(context.messages)…)` **unconditionally: no direct-usage path, no stale guard**, evaluated over RAW session messages (pre-purge). | **the bug** |

Reproduced against pi's own exports (`node` + `dist/core/compaction/index.js`, window
96 000, reserve 16 384):

- **stale anchor**: kept reply with `usage.totalTokens = 84000` (measured pre-compaction)
  + 2k trailing estimate → `estimateContextTokens = 86000` → `shouldCompact = true`,
  while the real KV prompt after our purge is ≈ **6 000**.
- **no usable usage** (error/zero-usage sessions): pure history estimate of two large
  tool outputs → `200 002` → `shouldCompact = true` regardless of what the KV holds.

So the hierarchy fired from *stored conversation size*, not *measured cache occupancy* —
"full" whenever history was big, repeatedly, since raw history never shrinks (our purge
keeps it in the store by design; pi's compaction keeps kept entries too).

### Our side had the same defect

The in-flight trigger sized `estimateContextChars(runSystemPrompt, rawMessages)/4` —
exactly the raw chat window — so a checkpointed session (huge store, tiny wire) read
"full" at `contextFullPct` and force-checkpointed in a loop. Same disease, ours.

### Fix (golden-context)

1. **`KvAnchor`** — on every `message_end`, record the **measured prompt tokens of that
   response's request** (`input + cacheRead + cacheWrite` — what actually sat in the KV
   cache) + the assistant message ts + the rendered system-prompt byte size.
2. **`estimateContextSize(system, messages, anchor)`** (golden-core) = anchor + chars/4
   of **only messages dated after the anchor** + system-prompt growth. Cold start (no
   measurement yet) falls back to the full history estimate — once, until the first
   response lands.
3. **In-flight trigger** sizes from the anchored number instead of the whole window.
4. **Takeover gate**: `session_before_compact` with `reason: "threshold"` re-checks the
   anchored size first — below `contextFullPct` → `{cancel: true}` (pi's false positive
   neutralized with zero model calls). `reason: "manual"` (`/compact`) and `"overflow"`
   (the engine itself refused) always proceed.
5. The footer counter is unchanged: display-only and honestly labeled `est`.

**Verified:** offline **118/118** (new: anchor/core sizing, threshold-gate cancel with no
evidence call, suppression against 400k chars of already-measured history,
manual-below-threshold proceeds, fires-when-measured-high); replay matrix green (all arms
as designed; auto-threshold cancels cleanly, `plugin-hang` wedge intact); loader PASS.
