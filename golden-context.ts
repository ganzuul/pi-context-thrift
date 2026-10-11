/**
 * golden-context.ts — pi Extension adapter for in-flight golden context.
 *
 * This file is intentionally THIN: all real logic lives in golden-core.ts (unit-tested
 * without pi). Here we only wire pi's Extension API to those pure functions.
 *
 * Mechanism (see findings-golden-context.md):
 *   - golden (append-only, model-committed durable decisions) is injected as a
 *     *system-prompt section* (`sections.golden`) so pi keeps the leading prefix stable
 *     and only patches the section when it grows -> warm KV on a byte-identical prefix.
 *   - spent tool results are pruned, and (DISTILL) superseded reasoning is stripped, from the
 *     live message tail in the `context` event (before every LLM call). This slows the growth of
 *     *used* context -> more turns before a full compaction, less clutter. (It is NOT a runtime
 *     VRAM effect: the KV pool is fixed by --ctx-size; a smaller --ctx-size is a separate lever.)
 *   - commit_decision is a registered TOOL (the user-chosen structured signal).
 *
 * Discrete commands (the human-triggerable seam — also usable while pi is compacting,
 * when every non-command input is queued):
 *   /golden-status                  — store, config, spent ids, context usage
 *   /golden-render                  — the exact <golden> bytes the model sees
 *   /golden-commit [kind] [spend:ids] <text> — model-independent commit (triggers ejection)
 *   /golden-eject                   — dry-run: what would be ejected/stripped right now
 *
 * Install (isolated first): see README.md. Do NOT drop into the live ~/.pi/agent/extensions
 * until Gate A (cache-hit proof) is done.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "typebox";
// value imports — these are what the isolated test stubs out
import { buildSessionContext, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
// type-only imports — erased at runtime, so they need no stub
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  applyEjection,
  buildCheckpointText,
  buildEvidencePrompt,
  collectCheckpoint,
  collectSpentIds,
  coverageFromEntry,
  describeEjection,
  EVIDENCE_SYSTEM_PROMPT,
  entryToJsonLine,
  estimateContextChars,
  formatStatus,
  formatTokens,
  parseCommitArgs,
  parseConfig,
  parseGoldenLine,
  renderGoldenSection,
  resolveToolLoadout,
  spliceGoldenSection,
  toLlmMessages,
  type AnyMessage,
  type CheckpointCoverage,
  type CheckpointPlan,
  type DecisionKind,
  type GoldenConfig,
  type GoldenEntry,
} from "./golden-core.ts";

const GOLDEN_SECTION_NAME = "golden"; // systemPromptOptions.sections key

const CommitParams = Type.Object({
  decision: Type.Union(
    [Type.Literal("record"), Type.Literal("distill"), Type.Literal("churn"), Type.Literal("discard")],
    { description:
      "distill = replace a superseded turn's thinking+tool_output with this hindsight line (the core rule); " +
      "record = promote a durable decision; churn = note repeated no-progress; discard = drop noise." },
  ),
  text: Type.String({ description: "The distilled, self-contained hindsight/decision to persist in golden. Keep it short and re-derivable-free." }),
  spendToolCallIds: Type.Optional(
    Type.Array(Type.String(), { description: "toolCallIds whose thinking + output are now spent (extracted into `text` / superseded by a later action) and may be pruned from context." }),
  ),
});

/**
 * State is per pi process. A session-scoped store file keyed under the agent dir keeps the
 * golden log durable across reloads; cross-session portability (the whole point of golden)
 * lives in that file, read at session_start and appended on every commit.
 */
interface LiveState {
  cfg: GoldenConfig;
  entries: GoldenEntry[];
  seq: number;
  /** rendered system prompt of the active run (golden section included) — the prefill splice base */
  runSystemPrompt?: string | undefined;
  /** the golden section text as injected for the active run (strict prefix of any later render) */
  runGoldenRender?: string | undefined;
  /** idle checkpointing is a background task; guard against overlap */
  ckptInFlight: boolean;
  /** the in-flight checkpoint run (session_before_compact waits on it to serialize) */
  ckptPromise?: Promise<void> | undefined;
  /** footer counter line for the last checkpoint (est, then measured) */
  lastCkptStatus?: string | undefined;
  lastCkptMeasured?: boolean;
}

function resolveStorePath(cfg: GoldenConfig): string {
  // Golden store sits under the agent dir (honors PI_CODING_AGENT_DIR => isolated testing).
  return join(getAgentDir(), cfg.goldenStoreRel);
}

function loadConfig(): GoldenConfig {
  // Optional config file next to the store, or PI_GOLDEN_CONFIG path. Defaults are safe.
  const explicit = process.env.PI_GOLDEN_CONFIG;
  const candidates = explicit ? [explicit] : [join(getAgentDir(), "golden-context", "config.json")];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return parseConfig(JSON.parse(readFileSync(p, "utf8")));
    } catch {
      /* ignore malformed config, fall through to defaults */
    }
  }
  return parseConfig({});
}

function loadEntries(storePath: string): { entries: GoldenEntry[]; seq: number } {
  try {
    if (!existsSync(storePath)) return { entries: [], seq: 0 };
    const lines = readFileSync(storePath, "utf8").split("\n");
    const entries = lines.map(parseGoldenLine).filter((e): e is GoldenEntry => e !== null);
    const seq = entries.reduce((m, e) => Math.max(m, e.seq + 1), 0);
    return { entries, seq };
  } catch {
    return { entries: [], seq: 0 };
  }
}

async function appendLine(storePath: string, line: string): Promise<void> {
  await withFileMutationQueue(storePath, async () => {
    await appendFile(storePath, line + "\n", "utf8");
  });
}

function ensureStoreDir(storePath: string): void {
  const dir = dirname(storePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Request inspector: PI_GOLDEN_DUMP=1 (or =/path/to.jsonl) records the ACTUAL provider
 * request body — the exact bytes the model sees (system prompt, tools, post-purge
 * messages) — for every request: agent turns (via pi's before_provider_request hook),
 * plus our own evidence-summary and warm-prefill calls. Off by default; never mutates
 * the payload. This is the ground truth for "is the rewritten context what we expect".
 */
function dumpRequest(source: "agent" | "evidence" | "prefill", payload: unknown): void {
  const target = process.env.PI_GOLDEN_DUMP;
  if (!target) return;
  try {
    const path = target === "1" || target === "true" ? join(getAgentDir(), "golden-context", "requests.jsonl") : target;
    ensureStoreDir(path);
    void appendLine(path, JSON.stringify({ ts: Date.now(), source, payload })).catch(() => { /* best-effort */ });
  } catch {
    /* best-effort */
  }
}

export default function goldenContextExtension(pi: ExtensionAPI): void {
  const state: LiveState = { cfg: loadConfig(), entries: [], seq: 0, ckptInFlight: false };

  const refresh = (): Set<string> => collectSpentIds(state.entries);

  /** Shared commit path for the `commit_decision` tool, `/golden-commit`, and idle checkpoints. */
  async function commitEntry(kind: DecisionKind, text: string, spend: string[], coveredTs?: number, keepTs?: number): Promise<GoldenEntry> {
    const entry: GoldenEntry = {
      seq: state.seq++,
      ts: Date.now(),
      kind,
      text: text.trim(),
      spend: Array.isArray(spend) ? [...spend] : [],
      ...(coveredTs !== undefined ? { coveredTs } : {}),
      ...(keepTs !== undefined ? { keepTs } : {}),
    };
    const storePath = resolveStorePath(state.cfg);
    ensureStoreDir(storePath);
    await appendLine(storePath, entryToJsonLine(entry));
    state.entries.push(entry);
    return entry;
  }

  /** Coverage floor of the newest checkpoint entry (cross-reload safe; -Infinity when none). */
  function checkpointFloor(): number {
    for (let i = state.entries.length - 1; i >= 0; i--) {
      const e = state.entries[i];
      if (e.kind === "checkpoint" && e.coveredTs !== undefined) return e.coveredTs;
    }
    return Number.NEGATIVE_INFINITY;
  }

  /** Purge coverage of the newest checkpoint entry — what the `context` hook applies per request. */
  function currentCoverage(): CheckpointCoverage | undefined {
    for (let i = state.entries.length - 1; i >= 0; i--) {
      const e = state.entries[i];
      const cov = coverageFromEntry(e, state.cfg);
      if (cov) return cov;
    }
    return undefined;
  }

  /**
   * The LLM-visible message list for the live branch — pi's compaction-aware
   * `buildSessionContext` (the exact source of `agent.state.messages`), NOT raw entries:
   * when pi's own compaction ran, the raw entries would diverge from the real request.
   */
  function liveMessages(ctx: ExtensionContext): AnyMessage[] {
    return buildSessionContext(ctx.sessionManager.getBranch() as never).messages as unknown as AnyMessage[];
  }

  /**
   * Report output for commands. TUI gets a persistent panel via setWidget (long reports
   * like /golden-render don't fit a toast); every mode also gets a notify line, which is
   * what the headless RPC replay harness captures.
   */
  function report(ctx: ExtensionCommandContext, title: string, body: string): void {
    const lines = `${title}\n${body}`.split("\n");
    try {
      ctx.ui.setWidget("golden-report", lines);
    } catch {
      /* non-TUI modes have no widget surface */
    }
    try {
      ctx.ui.notify(lines.join("\n"), "info");
    } catch {
      /* output is best-effort */
    }
  }

  pi.on("session_start", async () => {
    state.cfg = loadConfig();
    const storePath = resolveStorePath(state.cfg);
    ensureStoreDir(storePath);
    const { entries, seq } = loadEntries(storePath);
    state.entries = entries;
    state.seq = seq;
  });

  pi.on("before_agent_start", (event) => {
    if (!state.cfg.enabled) return;
    // Capture the exact rendered prompt for the idle prefill FIRST (even when no golden
    // section exists yet — the FIRST checkpoint appends the whole wrapped section).
    state.runSystemPrompt = event.systemPrompt;
    const section = renderGoldenSection(state.entries, state.cfg);
    if (section) {
      // Mutate the *sections* map, not event.systemPrompt (a full replace = cache miss).
      event.systemPromptOptions.sections[GOLDEN_SECTION_NAME] = section;
      state.runGoldenRender = section;
    } else {
      state.runGoldenRender = "";
    }
  });

  pi.on("context", async (event, ctx: ExtensionContext) => {
    if (!state.cfg.enabled) return;
    // IN-FLIGHT compaction — "our own solution for when context is full": if the request
    // about to go out crosses contextFullPct of the window, fold the covered history into
    // a checkpoint RIGHT HERE (mid-run), then purge below. The evidence call is bounded
    // (timeoutMs), so this can never wedge the request the way pi's summarizer can.
    if (state.cfg.autoCheckpoint && ctx.model?.contextWindow && ctx.model.contextWindow > 0) {
      const projected = toLlmMessages(event.messages as never[]);
      const estTok = Math.round(estimateContextChars(state.runSystemPrompt ?? "", projected) / 4);
      if (estTok >= (ctx.model.contextWindow * state.cfg.contextFullPct) / 100) {
        await commitCheckpoint(ctx, projected, { prefill: false, requireCompletedTurn: false, force: true });
      }
    }
    const spent = refresh();
    const coverage = currentCoverage();
    // Nothing could possibly be pruned: no explicit spend, no coverage, AND auto-eject off.
    if (spent.size === 0 && !state.cfg.autoEjectOldToolResults && !coverage) return;
    const res = applyEjection(event.messages as never, state.cfg, spent, coverage);
    // fire on any axis: collapsed outputs (ejected), stripped reasoning (DISTILL), or folded text
    if (res.ejected > 0 || res.reasoningStripped > 0 || res.textFolded > 0) return { messages: res.messages as never };
    // nothing changed this call
  });

  // ---- idle checkpointing: "our compaction" runs while the user reads ----
  //
  // The heavy work is deliberately fire-and-forget: pi awaits extension handlers inside
  // _emitAgentSettled() before the session reports idle, so awaiting the summary call here
  // would keep the session "busy" and the user's next prompt would queue instead of send.

  async function callEvidenceSummary(ctx: ExtensionContext, plan: CheckpointPlan): Promise<string> {
    const model = ctx.model;
    if (!model) throw new Error("no model selected");
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok === false) throw new Error("no API key for the summary call");
    const stream = ctx.modelRegistry.streamSimple(model, {
      systemPrompt: EVIDENCE_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [{ type: "text", text: buildEvidencePrompt(plan, state.cfg) }],
        timestamp: Date.now(),
      }],
    } as never, {
      maxTokens: state.cfg.summaryMaxTokens,
      reasoning: ctx.thinkingLevel ?? "low",
      cacheRetention: "none",
      timeoutMs: 20_000, // bounded: this call can run inside session_before_compact / the
                         // context hook — never reproduce pi's untimeouted-summarizer wedge
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      onPayload: (payload: unknown) => { dumpRequest("evidence", payload); },
    } as never);
    const res = await stream.result();
    // "the model can think for the summary but its reply should be capped, and only the
    // reply is kept, not that final thinking" — text blocks only, hard safety clamp.
    const text = (res.content ?? [])
      .filter((b) => b && b.type === "text")
      .map((b) => (b as { text?: string }).text ?? "")
      .join("\n")
      .trim();
    return text.slice(0, 4096);
  }

  /** Build the exact next-request body (system + post-purge messages + tools), or null
   *  when byte-exactness cannot be guaranteed. Also the source of the ctx counter. */
  function buildWarmRequest(ctx: ExtensionContext): { system: string; messages: unknown[]; tools: unknown[] } | null {
    const cfg = state.cfg;
    const newRender = renderGoldenSection(state.entries, cfg); // includes the fresh checkpoint
    const warmSystem = spliceGoldenSection(state.runSystemPrompt ?? "", state.runGoldenRender ?? "", newRender);
    if (!warmSystem) return null; // byte-exactness not guaranteed -> skip (best-effort)
    // purge exactly what the next real request will purge — in the REAL pipeline order:
    // pi runs our `context` hook on the raw transcript roles and only THEN projects
    // custom roles (compactionSummary etc.) to user messages via convertToLlm. Folding
    // after projection would fold compaction summaries the real request keeps verbatim.
    const all = liveMessages(ctx);
    const coverage = currentCoverage();
    const purged = applyEjection(all.filter((m) => m.role !== "system") as never, cfg, refresh(), coverage);
    const messages = toLlmMessages(purged.messages as never[]);

    // the tool loadout must serialize identically to the next request (resolve like pi-ai's
    // getCurrentTools — extension tools arrive via later system-message patches)
    const tools = resolveToolLoadout(all);
    if (tools.length === 0) return null;
    return { system: warmSystem, messages, tools };
  }

  /** Best-effort warm prefill of the post-checkpoint prefix while the user reads. */
  async function warmPrefill(ctx: ExtensionContext, req: { system: string; messages: unknown[]; tools: unknown[] }): Promise<void> {
    const dbg = (why: string) => {
      if (process.env.PI_GOLDEN_DEBUG) {
        try { ctx.ui.notify(`golden prefill: ${why}`, "info"); } catch { /* best-effort */ }
      }
    };
    const model = ctx.model;
    if (!model) { dbg("skip: no model"); return; }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok === false) { dbg("skip: no api key"); return; }
    const stream = ctx.modelRegistry.streamSimple(model, {
      messages: [
        { role: "system", content: req.system, toolsAdded: req.tools, timestamp: Date.now() },
        ...(req.messages as never[]),
      ],
    } as never, {
      maxTokens: 1,
      cacheRetention: "none",
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      onPayload: (payload: unknown) => { dumpRequest("prefill", payload); },
    } as never);
    await stream.result(); // one-token reply; we only wanted the prefill side effect
    dbg("warm prefill sent");
  }

  /**
   * Commit one checkpoint over `messages` (LLM-projected). Shared by all three triggers:
   *  - idle (agent_settled): the proactive pass, prefill on,
   *  - in-flight (context hook, context-full): compacts THIS request before it goes out,
   *  - takeover (session_before_compact): what /compact and any pi trigger run.
   * Returns the committed entry, or null when there was nothing worth folding.
   */
  async function commitCheckpoint(
    ctx: ExtensionContext,
    messages: AnyMessage[],
    opts: { prefill: boolean; requireCompletedTurn: boolean; force: boolean },
  ): Promise<GoldenEntry | null> {
    const cfg = state.cfg;
    if (state.ckptInFlight) return null;
    try {
      if (!ctx.model) return null;
      if (messages.length === 0) return null;
      // idle path never checkpoints an unfinished turn (error/aborted/length turns are
      // not evidence); the in-flight path MUST compact mid-run (toolUse is the norm there)
      if (opts.requireCompletedTurn) {
        const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant") as { stopReason?: string } | undefined;
        if (lastAssistant?.stopReason && lastAssistant.stopReason !== "stop") return null;
      }

      const plan = collectCheckpoint(messages, checkpointFloor(), cfg);
      if (plan.coveredMessages.length === 0) return null;
      if (!opts.force) {
        if (cfg.checkpointPolicy === "with-tools" && plan.toolCallIds.length === 0) return null;
      } else if (plan.stats.outputBytes + plan.stats.thinkingBytes + plan.stats.textBytes < 512) {
        return null; // forced (context-full / manual): only when folding actually saves
      }

      state.ckptInFlight = true;
      try {
        ctx.ui.setStatus?.("golden", "checkpointing…");
        const evidence = await callEvidenceSummary(ctx, plan);
        const text = buildCheckpointText(plan, evidence);
        if (!text.trim()) return null;
        const entry = await commitEntry("checkpoint", text, plan.toolCallIds, plan.coveredTs, plan.keepTextTs);
        // Context counter: the projected request size before/after the purge ("est"),
        // pushed to the footer the moment the checkpoint lands — pi's own counter stays
        // usage-anchored on the pre-purge request until the next response. When that
        // response arrives, message_end replaces the estimate with the MEASURED size.
        const warmReq = buildWarmRequest(ctx);
        if (warmReq) {
          const preChars = estimateContextChars(state.runSystemPrompt ?? "", toLlmMessages(liveMessages(ctx).filter((m) => m.role !== "system")));
          const postChars = estimateContextChars(warmReq.system, warmReq.messages as never[]);
          state.lastCkptStatus = `ckpt [${entry.seq}] · est ${formatTokens(Math.round(preChars / 4))}→${formatTokens(Math.round(postChars / 4))} tok`;
          state.lastCkptMeasured = false;
          ctx.ui.setStatus?.("golden", state.lastCkptStatus);
          if (opts.prefill && cfg.prefillAfterCheckpoint) {
            if (ctx.isIdle()) {
              await warmPrefill(ctx, warmReq);
            } else if (process.env.PI_GOLDEN_DEBUG) {
              ctx.ui.notify("golden prefill: skip: session not idle", "info");
            }
          }
        } else {
          state.lastCkptStatus = `ckpt [${entry.seq}] committed`;
          state.lastCkptMeasured = false;
          ctx.ui.setStatus?.("golden", state.lastCkptStatus);
        }
        return entry;
      } finally {
        state.ckptInFlight = false;
        ctx.ui.setStatus?.("golden", undefined);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try { ctx.ui.notify(`golden checkpoint skipped: ${message}`, "warning"); } catch { /* best-effort */ }
      return null;
    }
  }

  async function runCheckpoint(ctx: ExtensionContext): Promise<void> {
    if (!ctx.isIdle()) return; // pi is compacting/streaming — never start interleaved
    const messages = toLlmMessages(liveMessages(ctx));
    await commitCheckpoint(ctx, messages, { prefill: true, requireCompletedTurn: true, force: false });
  }

  pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
    if (!state.cfg.enabled || !state.cfg.autoCheckpoint) return;
    if (state.ckptInFlight) return;
    state.ckptPromise = runCheckpoint(ctx).finally(() => { state.ckptPromise = undefined; }); // fire-and-forget on purpose (see note above)
  });

  /**
   * Takeover of pi's compaction entry points (`/compact`, threshold, overflow — whatever
   * reaches session_before_compact): instead of pi's rewrite + untimeouted summarizer,
   * run OUR compaction. The result keeps pi's machinery happy (CompactionEntry + kept
   * entries) while the content lives in golden: the summary is a short pointer to the
   * `<golden>` section, and only the live reply is kept verbatim. When an idle checkpoint
   * just covered everything, there is nothing to fold — cancel instead of summarizing
   * empty history. Set takeoverCompaction:false to A/B against pi's built-in behavior.
   */
  pi.on("session_before_compact", async (event, ctx: ExtensionContext) => {
    if (!state.cfg.enabled || !state.cfg.takeoverCompaction) return; // pi's compaction runs as-is
    const inflight = state.ckptPromise;
    if (inflight) {
      await Promise.race([inflight, new Promise((r) => setTimeout(r, 10_000))]);
    }
    const branchEntries = (event as { branchEntries?: SessionEntry[] }).branchEntries ?? ctx.sessionManager.getBranch();
    const messages = toLlmMessages(buildSessionContext(branchEntries as never).messages as unknown as AnyMessage[]);
    const entry = await commitCheckpoint(ctx, messages, { prefill: false, requireCompletedTurn: false, force: true });
    if (!entry) return { cancel: true };

    // pi keeps entries from firstKeptEntryId onward verbatim -> the live reply entry.
    let firstKeptEntryId: string | undefined;
    for (let i = branchEntries.length - 1; i >= 0; i--) {
      const e = branchEntries[i] as { id?: string; type?: string; message?: { role?: string; timestamp?: number } };
      if (e.type === "message" && e.message?.role === "assistant" && e.id &&
          (entry.keepTs === undefined || e.message.timestamp === entry.keepTs)) {
        firstKeptEntryId = e.id;
        break;
      }
    }
    if (!firstKeptEntryId) {
      for (let i = branchEntries.length - 1; i >= 0; i--) {
        const id = (branchEntries[i] as { id?: string }).id;
        if (id) { firstKeptEntryId = id; break; }
      }
    }
    if (!firstKeptEntryId) return { cancel: true };

    const tokensBefore = (event as { preparation?: { tokensBefore?: number } }).preparation?.tokensBefore ?? 0;
    return {
      compaction: {
        summary:
          `Golden checkpoint [${entry.seq}]: this history was folded into the <golden> system-prompt section ` +
          `(tool calls line-by-line + evidence summary preserved there, full text in the golden store).`,
        firstKeptEntryId,
        tokensBefore,
        usage: undefined,
        details: { readFiles: [], modifiedFiles: [] },
      },
    };
  });

  // Context counter, measured: once the next response lands, its usage is the engine's
  // real prompt count for the purged request — replace the estimate with that number.
  pi.on("message_end", (event, ctx: ExtensionContext) => {
    if (!state.cfg.enabled || !state.lastCkptStatus || state.lastCkptMeasured) return;
    const m = event.message as { role?: string; usage?: { input?: number; cacheRead?: number } };
    if (m.role !== "assistant" || !m.usage) return;
    const promptTok = (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0);
    if (promptTok <= 0) return;
    state.lastCkptMeasured = true;
    state.lastCkptStatus = `${state.lastCkptStatus} · measured ${formatTokens(promptTok)} tok`;
    ctx.ui.setStatus?.("golden", state.lastCkptStatus);
  });

  // request inspector (PI_GOLDEN_DUMP): observe, never mutate
  pi.on("before_provider_request", (event) => {
    dumpRequest("agent", event.payload);
  });

  pi.registerTool({
    name: "commit_decision",
    label: "Commit decision to golden",
    description:
      "Record a durable decision/fact into append-only golden context, mark churn, or discard noise. " +
      "Optionally list toolCallIds whose output is now spent and can be pruned from context. " +
      "Use sparingly — only information that must survive the compaction filter.",
    promptSnippet: "Persist a durable decision or spend tool output into golden context.",
    parameters: CommitParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<never> {
      const kind: DecisionKind = params.decision;
      const entry = await commitEntry(
        kind,
        params.text ?? "",
        Array.isArray(params.spendToolCallIds) ? params.spendToolCallIds : [],
      );
      const spentNote = entry.spend.length ? ` Marked ${entry.spend.length} tool output(s) spent.` : "";
      return {
        content: [{ type: "text", text: `Golden committed [${entry.seq}] ${entry.kind}. Takes effect next turn.${spentNote}` }],
        details: { seq: entry.seq, kind: entry.kind, spend: entry.spend },
      } as never;
    },
  });

  // ---- discrete commands (human-triggerable seam) ----

  pi.registerCommand("golden-status", {
    description: "Show golden-context state (store, config, spent toolCallIds, context usage)",
    handler: async (_args, ctx) => {
      const storePath = resolveStorePath(state.cfg);
      const usage = ctx.getContextUsage();
      report(ctx, "golden-status", formatStatus({
        enabled: state.cfg.enabled,
        storePath,
        entryCount: state.entries.length,
        seq: state.seq,
        spentIds: [...refresh()],
        lastEntry: state.entries[state.entries.length - 1],
        cfg: state.cfg,
        ckptLine: state.lastCkptStatus,
        usageLine: usage
          ? `${usage.tokens ?? "?"}/${usage.contextWindow} (${usage.percent !== null && usage.percent !== undefined ? usage.percent.toFixed(1) + "%" : "n/a"})`
          : undefined,
      }));
    },
  });

  pi.registerCommand("golden-render", {
    description: "Show the exact <golden> section bytes injected into the system prompt",
    handler: async (_args, ctx) => {
      const section = renderGoldenSection(state.entries, state.cfg);
      const body = section
        ? `${Buffer.byteLength(section, "utf8")} bytes (append-only: committed lines never change)\n\n${section}`
        : "(empty — no entries yet)";
      report(ctx, "golden-render", body);
    },
  });

  pi.registerCommand("golden-commit", {
    description: "Commit a golden entry by hand: /golden-commit [record|distill|churn|discard] [spend:id1,id2] <text>",
    handler: async (args, ctx) => {
      const { kind, text, spend } = parseCommitArgs(args);
      if (!text) {
        report(ctx, "golden-commit", "usage: /golden-commit [record|distill|churn|discard] [spend:id1,id2] <text>");
        return;
      }
      const entry = await commitEntry(kind, text, spend);
      const spentNote = entry.spend.length ? ` — ${entry.spend.length} tool output(s) now spent (ejected on next request)` : "";
      ctx.ui.notify(`Golden committed [${entry.seq}] ${entry.kind}${spentNote}`, "info");
    },
  });

  pi.registerCommand("golden-eject", {
    description: "Dry-run: report what would be ejected/stripped/folded from the transcript right now",
    handler: async (_args, ctx) => {
      // Transcript view of the live branch: message entries in order (the `context` hook
      // sees the same messages just before each LLM call; this never modifies anything).
      const entries: SessionEntry[] = ctx.sessionManager.getBranch();
      const messages = entries
        .filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message")
        .map((e) => e.message as never);
      const plan = describeEjection(messages, state.cfg, refresh(), currentCoverage());
      if (plan.items.length === 0) {
        report(ctx, "golden-eject", "nothing to do — no spent toolCallIds outside the protected tail" +
          ` (autoEject=${state.cfg.autoEjectOldToolResults}, tailKeep=${state.cfg.tailKeepToolResults})`);
        return;
      }
      const lines = plan.items.map((it) =>
        `#${it.index} ${it.action} ${it.toolName ?? ""}${it.toolCallId ? " " + it.toolCallId.slice(0, 8) : ""} (~${it.bytes}B)`);
      report(ctx, "golden-eject",
        `would change ${plan.items.length} message(s): ${plan.ejected} result(s) ejected, ` +
        `${plan.reasoningStripped} reasoning block(s) stripped, ${plan.textFolded} text block(s) folded, ~${plan.bytesRemoved}B removed\n` + lines.join("\n"));
    },
  });
}
