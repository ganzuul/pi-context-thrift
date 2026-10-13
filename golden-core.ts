/**
 * golden-core.ts — pure, pi-independent logic for the golden-context extension.
 *
 * Testable without loading `pi`: no value imports from @earendil-works/* (only structural
 * types), so jiti/node run this file in isolation. golden-context.ts is the ONLY place that
 * touches the real pi runtime.
 *
 * Design (user-confirmed 2026-10-10): append-only, model-committed golden prefix + the
 * DISTILL rule. When the model spends a tool call (its output was extracted into a later
 * action), eject BOTH the bulky tool result AND that call's reasoning, keeping a distilled
 * "hindsight" (the commit text) in golden. The ejection unit is a *turn triple*, supersession
 * is semantic (a later input already encodes what was needed), not size/recency.
 *
 * Payoff: a byte-stable leading prefix so beellama's prompt cache reuses KV, and slow-growing
 * `used` context (more turns before pi's prefix-busting rewrite-compaction). This is NOT a
 * runtime VRAM effect — the KV pool is fixed by --ctx-size (see findings doc §8).
 *
 * Hard constraint: NEVER delete a message. pi's transformMessages injects synthetic
 * "No result provided" results for orphaned tool calls, so we collapse a toolResult's *content*
 * in place (keeps the assistant tool_call <-> toolResult pairing valid).
 */

// ---- structural message types (mirror the real pi-ai / pi-agent-core shapes) ----
// Only fields we read are typed; kept loose so tests pass plain objects.

export interface TextContent { type: "text"; text: string; [k: string]: unknown; }
export interface ImageContent { type: "image"; data?: string; mimeType?: string; [k: string]: unknown; }
export type Content = TextContent | ImageContent;
// assistant content blocks (real pi-ai): text | thinking | toolCall — kept permissive
export interface ThinkingContent { type: "thinking"; thinking?: string; thinkingSignature?: string; redacted?: boolean; [k: string]: unknown; }
export interface ToolCallBlock { type: "toolCall"; id: string; name?: string; arguments?: unknown; [k: string]: unknown; }
export type AssistantBlock = TextContent | ThinkingContent | ToolCallBlock | { type: string; [k: string]: unknown };

export interface ToolResultLike {
  role: "toolResult"; toolCallId: string; toolName: string; content: Content[];
  isError: boolean; timestamp: number; [k: string]: unknown;
}
export interface AssistantLike { role: "assistant"; content?: AssistantBlock[]; [k: string]: unknown; }
export interface AnyMessage { role: string; content?: unknown; [k: string]: unknown; }

// block discriminators actually used by pi-ai
const REASONING_TYPES = new Set(["thinking", "reasoning", "redacted_thinking"]);
const TOOLCALL_TYPES = new Set(["toolCall", "tool_call", "functionCall", "function_call"]);

// ---- config ----

/** What a golden store is scoped to. See `scopeKeyFor` for the resolution rules. */
export type StoreScope = "cwd" | "git" | "global";

export interface GoldenConfig {
  /** master switch; when false the adapter is a no-op. */
  enabled: boolean;
  /** IDLE CHECKPOINTING: run "our compaction" automatically after the agent hands the
   *  session back to the user (agent_settled). Each run appends one checkpoint entry to
   *  golden and purges the covered range on the next request. */
  autoCheckpoint: boolean;
  /** IN-FLIGHT compaction: when the estimated request exceeds this % of the model's
   *  context window, checkpoint right inside the `context` hook (mid-run) instead of
   *  waiting for idle — "our own compatible solution for when context is full". */
  contextFullPct: number;
  /** Take over pi's compaction entry points (session_before_compact): `/compact` and any
   *  pi trigger produce OUR golden-based compaction instead of pi's rewrite+summarizer.
   *  Set false to A/B against pi's built-in behavior (the wedge repro needs this). */
  takeoverCompaction: boolean;
  /** "with-tools": only checkpoint turns that ran at least one tool call (the evidence
   *  summary has nothing to chew on otherwise). "always": every idle turn. */
  checkpointPolicy: "with-tools" | "always";
  /** cap on the evidence-summary REPLY (the model may think beyond it; only the reply is kept). */
  summaryMaxTokens: number;
  /** soft target for the evidence summary, stated in the summary prompt. */
  summaryTargetTokens: number;
  /** per-tool-call line budget in the checkpoint's line-by-line call list. */
  callLineMaxChars: number;
  /** hollow covered user/assistant TEXT into handles too (the text is preserved verbatim
   *  inside the checkpoint entry, so this is lossless and stops replies accumulating). */
  hollowCoveredText: boolean;
  /** best-effort warm prefill of the post-checkpoint prefix while the user reads. */
  prefillAfterCheckpoint: boolean;
  /** number of most-recent toolResults kept verbatim (ABSOLUTE — never ejected, never thinking-stripped). */
  tailKeepToolResults: number;
  /** when true, eject old+large toolResults even without an explicit commit (content only, never thinking). */
  autoEjectOldToolResults: boolean;
  /** minimum text byte size below which a toolResult is never considered for auto-eject. */
  minResultBytesToEject: number;
  /** DISTILL: on an explicit spend, also strip that call's reasoning block from the assistant
   *  message (keeps its text + the toolCall). Auto-eject never strips reasoning. */
  stripThinkingOnSpend: boolean;
  /** cap on the rendered golden section (bytes) so a runaway log cannot blow the prefix. */
  maxGoldenSectionBytes: number;
  /** What the store is scoped to. "cwd" = the directory pi was launched in (a new project starts
   *  with a FRESH golden instead of inheriting another project's decisions); "git" = nearest
   *  ancestor with a .git, so subdirs of one repo share memory; "global" = the historic single
   *  machine-wide store. The scope key nests inside goldenStoreRel's own directory. */
  scope: StoreScope;
  /** store file, resolved relative to the agent dir by the adapter. */
  goldenStoreRel: string;
  /** handle template; placeholders {toolName} {id} {bytes} */
  handleTemplate: string;
}

export const DEFAULT_CONFIG: GoldenConfig = {
  enabled: true,
  autoCheckpoint: true,
  contextFullPct: 80,
  takeoverCompaction: true,
  checkpointPolicy: "with-tools",
  summaryMaxTokens: 512,
  summaryTargetTokens: 128,
  callLineMaxChars: 160,
  hollowCoveredText: true,
  prefillAfterCheckpoint: true,
  tailKeepToolResults: 4,
  autoEjectOldToolResults: false,   // aggressive auto-ejection is OPT-IN
  minResultBytesToEject: 2048,
  stripThinkingOnSpend: true,       // the DISTILL rule is the point; conservative elsewhere
  maxGoldenSectionBytes: 16_000,
  scope: "cwd",                    // a new directory must NOT inherit another project's golden
  goldenStoreRel: "golden-context/golden.jsonl",
  handleTemplate: "[golden] {toolName} #{id} ejected ({bytes}B) — consumed into later work",
};

function num(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

/** Merge raw config (from JSON/env) over defaults. Never throws on bad input. */
export function parseConfig(raw: unknown): GoldenConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_CONFIG.enabled,
    autoCheckpoint: typeof o.autoCheckpoint === "boolean" ? o.autoCheckpoint : DEFAULT_CONFIG.autoCheckpoint,
    contextFullPct: Math.min(99, Math.max(10, Math.floor(num(o.contextFullPct, DEFAULT_CONFIG.contextFullPct)))),
    takeoverCompaction: typeof o.takeoverCompaction === "boolean" ? o.takeoverCompaction : DEFAULT_CONFIG.takeoverCompaction,
    checkpointPolicy: o.checkpointPolicy === "always" || o.checkpointPolicy === "with-tools"
      ? o.checkpointPolicy : DEFAULT_CONFIG.checkpointPolicy,
    summaryMaxTokens: Math.max(16, Math.floor(num(o.summaryMaxTokens, DEFAULT_CONFIG.summaryMaxTokens))),
    summaryTargetTokens: Math.max(1, Math.floor(num(o.summaryTargetTokens, DEFAULT_CONFIG.summaryTargetTokens))),
    callLineMaxChars: Math.max(24, Math.floor(num(o.callLineMaxChars, DEFAULT_CONFIG.callLineMaxChars))),
    hollowCoveredText: typeof o.hollowCoveredText === "boolean" ? o.hollowCoveredText : DEFAULT_CONFIG.hollowCoveredText,
    prefillAfterCheckpoint: typeof o.prefillAfterCheckpoint === "boolean" ? o.prefillAfterCheckpoint : DEFAULT_CONFIG.prefillAfterCheckpoint,
    tailKeepToolResults: Math.max(0, Math.floor(num(o.tailKeepToolResults, DEFAULT_CONFIG.tailKeepToolResults))),
    autoEjectOldToolResults: typeof o.autoEjectOldToolResults === "boolean" ? o.autoEjectOldToolResults : DEFAULT_CONFIG.autoEjectOldToolResults,
    minResultBytesToEject: Math.max(0, Math.floor(num(o.minResultBytesToEject, DEFAULT_CONFIG.minResultBytesToEject))),
    stripThinkingOnSpend: typeof o.stripThinkingOnSpend === "boolean" ? o.stripThinkingOnSpend : DEFAULT_CONFIG.stripThinkingOnSpend,
    maxGoldenSectionBytes: Math.max(0, Math.floor(num(o.maxGoldenSectionBytes, DEFAULT_CONFIG.maxGoldenSectionBytes))),
    scope: o.scope === "cwd" || o.scope === "git" || o.scope === "global"
      ? o.scope : DEFAULT_CONFIG.scope,
    goldenStoreRel: typeof o.goldenStoreRel === "string" && o.goldenStoreRel ? o.goldenStoreRel : DEFAULT_CONFIG.goldenStoreRel,
    handleTemplate: typeof o.handleTemplate === "string" && o.handleTemplate ? o.handleTemplate : DEFAULT_CONFIG.handleTemplate,
  };
}

// ---- store scoping (pure: the fs probe is injected by the adapter) ----

/**
 * Scope key for a directory — byte-identical to pi's own per-directory session naming
 * (`--${abs.replace(/^[/\\]/,"").replace(/[/\\:]/g,"-")}--`, pi session-manager.js:248) so a
 * store can be read against `sessions/--<same key>--/`. pi does not export this helper, so it is
 * copied deliberately; `test/run.mjs` pins it against pi's real, on-disk directory names.
 */
export function encodeCwdScope(absPath: string): string {
  return `--${absPath.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Nearest ancestor containing `.git` — as a dir OR a file, since worktrees/submodules use the
 * file form. `exists` is injected to keep this pure/testable. Returns null outside any repo.
 */
export function findGitRoot(startAbs: string, exists: (p: string) => boolean): string | null {
  let dir = startAbs.replace(/\/+$/, "") || "/";
  for (;;) {
    if (exists(`${dir}/.git`)) return dir;
    if (dir === "/") return null;
    const parent = dir.replace(/\/[^/]+$/, "");
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The directory segment a store lives under, or null for the historic single machine-wide store.
 * "git" degrades to "cwd" when the launch dir is not inside a repo — an un-repoed directory has
 * no better key than itself.
 */
export function scopeKeyFor(
  cfg: Pick<GoldenConfig, "scope">,
  cwd: string,
  gitRoot: string | null,
): string | null {
  if (cfg.scope === "global") return null;
  if (cfg.scope === "git" && gitRoot) return encodeCwdScope(gitRoot);
  return encodeCwdScope(cwd);
}

// ---- golden store records ----

export type DecisionKind = "record" | "distill" | "churn" | "discard" | "checkpoint";
const KINDS: DecisionKind[] = ["record", "distill", "churn", "discard", "checkpoint"];

/** One immutable, append-only golden record. `seq` is the append index (monotonic). */
export interface GoldenEntry {
  seq: number;
  ts: number; // audit only — deliberately NOT rendered into the prompt (volatile)
  kind: DecisionKind;
  text: string; // for distill: the "hindsight"; for record: the durable decision
  spend: string[]; // toolCallIds the model declared spent by this commit (may be empty)
  /** checkpoint only: timestamp of the last message this checkpoint PURGED. The next
   *  checkpoint covers messages after it (the still-live final reply is excluded here and
   *  folded into the next checkpoint instead). */
  coveredTs?: number;
  /** checkpoint only: timestamp of the live final reply (text kept verbatim at the tail
   *  bottom, its thinking purged). Equals the purge-range end. */
  keepTs?: number;
}

/** Stable serialization for the JSONL audit line (fixed key order; deterministic). */
export function entryToJsonLine(e: GoldenEntry): string {
  const ordered: Record<string, unknown> = { seq: e.seq, ts: e.ts, kind: e.kind, text: e.text, spend: [...e.spend].sort() };
  if (e.coveredTs !== undefined) ordered.coveredTs = e.coveredTs;
  if (e.keepTs !== undefined) ordered.keepTs = e.keepTs;
  return JSON.stringify(ordered);
}

export function parseGoldenLine(line: string): GoldenEntry | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const o = JSON.parse(t) as Record<string, unknown>;
    if (typeof o.seq !== "number" || typeof o.text !== "string") return null;
    const kind: DecisionKind = KINDS.includes(o.kind as DecisionKind) ? (o.kind as DecisionKind) : "record";
    return {
      seq: o.seq, ts: num(o.ts, 0), kind, text: o.text,
      spend: Array.isArray(o.spend) ? o.spend.filter((x): x is string => typeof x === "string") : [],
      ...(typeof o.coveredTs === "number" ? { coveredTs: o.coveredTs } : {}),
      ...(typeof o.keepTs === "number" ? { keepTs: o.keepTs } : {}),
    };
  } catch { return null; }
}

/** Coverage a checkpoint entry applies to every later request (the purge channel). */
export function coverageFromEntry(e: GoldenEntry, cfg: Pick<GoldenConfig, "hollowCoveredText">): CheckpointCoverage | undefined {
  if (e.kind !== "checkpoint") return undefined;
  const throughTs = e.keepTs ?? e.coveredTs;
  if (throughTs === undefined) return undefined;
  return {
    throughTs,
    keepTextTs: e.keepTs,
    hollowText: cfg.hollowCoveredText,
    foldLabel: `folded into checkpoint [${e.seq}]`,
  };
}

/**
 * Render the golden block that becomes a *system-prompt section* (`sections.golden`).
 *
 * pi XML-wraps the section in <golden>...</golden> itself (see SystemMessage.sections), so
 * this value must NOT add its own wrapper.
 *
 * Prefix-stability contract (what Gate A hinges on): CONSTANT preamble + entry lines joined by
 * "\n", NO trailing newline. So `render(E)` is a STRICT string prefix of `render(E+[new])` —
 * committed golden bytes stay byte-identical, so beellama reuses KV for the whole golden block
 * and only prefills the newly appended decision.
 *
 * Only `seq`/`kind`/`text` are emitted (never `ts`). `discard` never enters the prompt;
 * `record`/`distill`/`churn` render as lines. NOTE: hitting the byte cap drops the OLDEST line,
 * which BREAKS the strict prefix (an emergency cache-bust) — acceptable but deliberate; if long
 * sessions exceed it, rotate/archive golden instead.
 */
/** Canonical render of one golden entry line. Used by the section render AND the prefill
 *  splice (both must produce identical bytes or the warm cache misses). */
export function formatEntryLine(e: GoldenEntry): string {
  return `- [${e.seq}] (${e.kind}) ${e.text}`;
}

export function renderGoldenSection(entries: GoldenEntry[], cfg: Pick<GoldenConfig, "maxGoldenSectionBytes">): string {
  const promptEntries = entries.filter((e) => e.kind !== "discard");
  if (promptEntries.length === 0) return "";
  const lines = promptEntries.map(formatEntryLine);
  while (Buffer.byteLength(lines.join("\n"), "utf8") > cfg.maxGoldenSectionBytes && lines.length > 1) {
    lines.shift();
  }
  const preamble =
    "Durable decisions extracted from earlier turns; authoritative for what is already decided. " +
    "Do not re-derive or restate them. The working set is the live message tail.\n";
  return preamble + lines.join("\n");
}

/** Set of toolCallIds declared spent across all golden entries. */
export function collectSpentIds(entries: GoldenEntry[]): Set<string> {
  const s = new Set<string>();
  for (const e of entries) for (const id of e.spend) s.add(id);
  return s;
}

// ---- discrete-command helpers (pure; exercised by /golden-* commands) ----

/**
 * Parse `/golden-commit [kind] [spend:id1,id2] <text>` arguments.
 * - `kind` is optional and defaults to "record"; when the first word is not a known
 *   kind, the whole args string is the text (so `record` never has to be typed).
 * - `spend:` (optional, after the kind) marks toolCallIds spent — the same effect the
 *   model gets via `commit_decision.spendToolCallIds`. This is what actually triggers
 *   ejection on the next request, and lets a human drive the DISTILL path by hand.
 */
export function parseCommitArgs(args: string): { kind: DecisionKind; text: string; spend: string[] } {
  let t = args.trim();
  let kind: DecisionKind = "record";
  const sp = t.indexOf(" ");
  const head = sp === -1 ? t : t.slice(0, sp);
  if (KINDS.includes(head as DecisionKind)) {
    kind = head as DecisionKind;
    t = sp === -1 ? "" : t.slice(sp + 1).trim();
  }
  const spend: string[] = [];
  const spendMatch = /^spend:([^\s]+)\s*/.exec(t);
  if (spendMatch) {
    for (const id of spendMatch[1].split(",")) if (id) spend.push(id);
    t = t.slice(spendMatch[0].length);
  }
  return { kind, text: t, spend };
}

/** One planned mutation for the `/golden-eject` dry-run report. */
export interface EjectionPlanItem {
  index: number;          // position in the message list
  role: string;
  action: "eject-result" | "strip-thinking" | "fold-text";
  toolCallId?: string;
  toolName?: string;
  bytes: number;          // approximate bytes that would be removed
}

export interface EjectionPlan {
  items: EjectionPlanItem[];
  ejected: number;
  reasoningStripped: number;
  bytesRemoved: number;
  textFolded: number;
}

/**
 * Dry-run of applyEjection: reports exactly which messages WOULD change, without
 * touching them. Implemented as run-then-diff on object identity (applyEjection
 * reuses every untouched message object), so the report can never disagree with
 * the real `context`-hook behavior.
 */
export function describeEjection(
  messages: AnyMessage[],
  cfg: GoldenConfig,
  spentIds: Set<string>,
  coverage?: CheckpointCoverage,
): EjectionPlan {
  const res = applyEjection(messages, cfg, spentIds, coverage);
  const items: EjectionPlanItem[] = [];
  const textSig = (m: AnyMessage): string =>
    (Array.isArray(m.content) ? (m.content as Content[]) : [])
      .filter((c) => c && c.type === "text").map((c) => (c as TextContent).text).join("\u0000");
  for (let i = 0; i < messages.length && i < res.messages.length; i++) {
    const before = messages[i], after = res.messages[i];
    if (before === after) continue;
    const m = before as unknown as ToolResultLike & AssistantLike;
    const folded = before.role !== "toolResult" && textSig(before) !== textSig(after);
    items.push({
      index: i,
      role: before.role,
      action: before.role === "toolResult" ? "eject-result" : folded ? "fold-text" : "strip-thinking",
      toolCallId: typeof m.toolCallId === "string" ? m.toolCallId : toolCallIdsOf(before)[0],
      toolName: typeof m.toolName === "string" ? m.toolName : undefined,
      bytes: folded || before.role === "toolResult" ? textBytes(before) : reasoningBytes(before),
    });
  }
  return { items, ejected: res.ejected, reasoningStripped: res.reasoningStripped, bytesRemoved: res.bytesRemoved, textFolded: res.textFolded };
}

/** Inputs for the `/golden-status` report (assembled by the adapter). */
export interface StatusData {
  enabled: boolean;
  storePath: string;
  entryCount: number;
  seq: number;
  spentIds: string[];
  lastEntry?: GoldenEntry | undefined;
  cfg: GoldenConfig;
  ckptLine?: string | undefined;
  usageLine?: string | undefined;
}

/** Pure text report for `/golden-status`. */
export function formatStatus(d: StatusData): string {
  const lines: string[] = [];
  lines.push(`golden-context: ${d.enabled ? "enabled" : "DISABLED"}`);
  lines.push(`store: ${d.storePath} (${d.entryCount} entries, next seq ${d.seq})`);
  if (d.ckptLine) lines.push(`context counter: ${d.ckptLine}`);
  lines.push(`ejection: tailKeepToolResults=${d.cfg.tailKeepToolResults} autoEject=${d.cfg.autoEjectOldToolResults} ` +
    `minResultBytes=${d.cfg.minResultBytesToEject} stripThinkingOnSpend=${d.cfg.stripThinkingOnSpend}`);
  lines.push(`golden section cap: ${d.cfg.maxGoldenSectionBytes}B`);
  lines.push(`spent toolCallIds: ${d.spentIds.length}${d.spentIds.length ? " (" + d.spentIds.map((s) => s.slice(0, 8)).join(", ") + ")" : ""}`);
  if (d.lastEntry) {
    const t = d.lastEntry.text.length > 100 ? d.lastEntry.text.slice(0, 100) + "…" : d.lastEntry.text;
    lines.push(`last entry: [${d.lastEntry.seq}] (${d.lastEntry.kind}) ${t}`);
  }
  if (d.usageLine) lines.push(`context usage: ${d.usageLine}`);
  return lines.join("\n");
}

// ---- ejection (DISTILL rule) ----

function textBytes(m: { content?: unknown }): number {
  let n = 0;
  const arr = Array.isArray(m.content) ? (m.content as Content[]) : [];
  for (const c of arr) if (c && c.type === "text" && typeof c.text === "string") n += Buffer.byteLength(c.text, "utf8");
  return n;
}
function reasoningBytes(m: { content?: unknown }): number {
  let n = 0;
  const arr = Array.isArray(m.content) ? (m.content as AssistantBlock[]) : [];
  for (const b of arr) if (b && REASONING_TYPES.has(b.type) && typeof (b as ThinkingContent).thinking === "string")
    n += Buffer.byteLength((b as ThinkingContent).thinking as string, "utf8");
  return n;
}
function hasImage(m: { content?: unknown }): boolean {
  const arr = Array.isArray(m.content) ? (m.content as Content[]) : [];
  return arr.some((c) => c && c.type === "image");
}
/** tool-call ids an assistant message emitted (to match a spend back to its reasoning block). */
function toolCallIdsOf(m: { content?: unknown }): string[] {
  const arr = Array.isArray(m.content) ? (m.content as AssistantBlock[]) : [];
  return arr
    .filter((b) => b && TOOLCALL_TYPES.has(b.type))
    .map((b) => (b as ToolCallBlock).id)
    .filter((x): x is string => typeof x === "string");
}
function formatHandle(m: ToolResultLike, cfg: GoldenConfig): string {
  return cfg.handleTemplate
    .replaceAll("{toolName}", m.toolName)
    .replaceAll("{id}", m.toolCallId.slice(0, 8))
    .replaceAll("{bytes}", String(textBytes(m)));
}

export interface EjectionResult {
  messages: AnyMessage[];
  ejected: number;          // toolResults collapsed to a handle
  reasoningStripped: number; // assistant turns had ThinkingContent removed (DISTILL)
  bytesRemoved: number;     // approx text+reasoning bytes removed
  textFolded: number;       // covered user/assistant text collapsed into checkpoint handles
}

/**
 * Checkpoint coverage: the range an idle checkpoint purges. Everything at/below
 * `throughTs` is spent work — tool outputs collapse to handles and ALL thinking is
 * stripped ("thinking and tool outputs are purged"). Covered user/assistant TEXT folds
 * into a handle too when `hollowText` (the text is preserved verbatim inside the
 * checkpoint entry, so folding is lossless), except the message at `keepTextTs` — the
 * final reply to the user, which stays verbatim at the tail bottom until the NEXT
 * checkpoint folds it.
 */
export interface CheckpointCoverage {
  throughTs: number;
  keepTextTs?: number | undefined;
  hollowText: boolean;
  /** handle text for folded messages, e.g. "folded into checkpoint [7]". */
  foldLabel: string;
}

/**
 * Apply the ejection policy to a message list.
 *
 * Tail protection is ABSOLUTE for un-covered messages: the last `cfg.tailKeepToolResults`
 * toolResults — and the assistant turns that issued those same (protected) call ids — are
 * never touched; even an explicit spend cannot prune the still-active working set.
 * Checkpoint coverage overrides that: the checkpointed turn is done being worked on, so
 * its outputs are purged regardless of recency.
 *
 * - toolResult: collapse text content to a handle (keep image parts + role/toolCallId/toolName/
 *   isError/timestamp for valid pairing) when covered, OR when NOT protected AND ( id ∈ spentIds
 *   OR (autoEjectOldToolResults AND text >= minResultBytesToEject AND no image) ).
 * - assistant (DISTILL): when cfg.stripThinkingOnSpend AND the message emitted a call whose id is
 *   in spentIds AND not protected, strip its reasoning blocks (drop `type:"thinking"`), keeping
 *   text + toolCall. Covered messages always get reasoning stripped. The NEXT turn's toolCall
 *   (the superseding input) is never modified.
 * - covered text folding (user + assistant, `hollowText`): text blocks collapse to one handle,
 *   except the `keepTextTs` message. Images and toolCall blocks always survive.
 *
 * Never deletes a message; only swaps content / removes reasoning blocks in place.
 */
export function applyEjection(
  messages: AnyMessage[],
  cfg: GoldenConfig,
  spentIds: Set<string>,
  coverage?: CheckpointCoverage,
): EjectionResult {
  if (!cfg.enabled) return { messages, ejected: 0, reasoningStripped: 0, bytesRemoved: 0, textFolded: 0 };

  // protected ids = last tailKeep toolResults' call ids (absolute).
  const toolResultIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) if (messages[i].role === "toolResult") toolResultIdx.push(i);
  const protectedIds = new Set<string>();
  const keepFrom = Math.max(0, toolResultIdx.length - cfg.tailKeepToolResults);
  for (let i = keepFrom; i < toolResultIdx.length; i++) {
    const m = messages[toolResultIdx[i]] as unknown as ToolResultLike;
    if (typeof m.toolCallId === "string") protectedIds.add(m.toolCallId);
  }

  // effective timestamps (carry forward over messages missing one) decide coverage.
  const covered: boolean[] = [];
  let carryTs = 0;
  for (const msg of messages) {
    const ts = typeof msg.timestamp === "number" ? msg.timestamp : carryTs;
    if (typeof msg.timestamp === "number") carryTs = ts;
    covered.push(coverage !== undefined && ts <= coverage.throughTs);
  }
  const isKeep = (i: number): boolean => {
    if (coverage?.keepTextTs === undefined) return false;
    const ts = messages[i].timestamp;
    return typeof ts === "number" && ts === coverage.keepTextTs;
  };

  let ejected = 0, reasoningStripped = 0, bytesRemoved = 0, textFolded = 0, changed = false;
  const out: AnyMessage[] = messages.map((msg, i) => {
    const isCovered = covered[i];

    if (msg.role === "toolResult") {
      const m = msg as unknown as ToolResultLike;
      const id = typeof m.toolCallId === "string" ? m.toolCallId : "";
      const explicit = spentIds.has(id);
      const auto = cfg.autoEjectOldToolResults && !hasImage(m) && textBytes(m) >= cfg.minResultBytesToEject;
      if (!isCovered && !explicit && !auto) return msg;
      if (!isCovered && protectedIds.has(id)) return msg; // in-tail: verbatim-protected, absolute
      const keepImages = (Array.isArray(m.content) ? (m.content as Content[]) : []).filter((c) => c && c.type === "image");
      bytesRemoved += textBytes(m);
      changed = true; ejected += 1;
      return { ...m, content: [{ type: "text", text: formatHandle(m, cfg) }, ...keepImages] as Content[] };
    }

    if (msg.role === "assistant") {
      const m = msg as unknown as AssistantLike;
      const emitted = toolCallIdsOf(m);
      const spendHere = emitted.some((id) => spentIds.has(id) && !protectedIds.has(id));
      const blocks = Array.isArray(m.content) ? m.content : [];
      let outBlocks = blocks;

      // DISTILL: strip reasoning on explicit spend, or always within checkpoint coverage.
      if (isCovered || (cfg.stripThinkingOnSpend && spendHere)) {
        const kept = outBlocks.filter((b) => !(b && REASONING_TYPES.has(b.type)));
        if (kept.length !== outBlocks.length) {
          bytesRemoved += reasoningBytes(m);
          changed = true; reasoningStripped += 1;
          outBlocks = kept;
        }
      }

      // fold covered text into a checkpoint handle (the reply at keepTextTs stays verbatim)
      if (coverage?.hollowText && cfg.hollowCoveredText && isCovered && !isKeep(i)) {
        const texts = outBlocks.filter((b) => b && b.type === "text") as TextContent[];
        if (texts.length > 0) {
          const keep = outBlocks.filter((b) => !(b && b.type === "text"));
          bytesRemoved += textBytes(m);
          changed = true; textFolded += 1;
          outBlocks = [{ type: "text", text: `[golden] assistant text ${coverage.foldLabel}` }, ...keep];
        }
      }

      return outBlocks === blocks ? msg : { ...m, content: outBlocks };
    }

    if (msg.role === "user" && coverage?.hollowText && cfg.hollowCoveredText && isCovered && !isKeep(i)) {
      const arr = Array.isArray(msg.content) ? (msg.content as Content[]) : [];
      const texts = arr.filter((c) => c && c.type === "text") as TextContent[];
      if (texts.length > 0) {
        const keep = arr.filter((c) => !(c && c.type === "text"));
        bytesRemoved += textBytes(msg);
        changed = true; textFolded += 1;
        return { ...msg, content: [{ type: "text", text: `[golden] user text ${coverage.foldLabel}` }, ...keep] };
      }
    }

    return msg;
  });

  return { messages: changed ? out : messages, ejected, reasoningStripped, bytesRemoved, textFolded };
}

// ---- idle checkpointing ("our compaction") — the model-independent turn compressor ----
//
// Design (user spec, 2026-10-11): after the agent hands the session back to the user,
// a background pass (1) asks the model for a SHORT evidence summary — tool-call outputs
// weighed against the thinking trace, ≤ summaryMaxTokens, target summaryTargetTokens,
// thinking allowed but only the reply is kept — then (2) commits one append-only
// checkpoint entry (tool calls line-by-line, then the summary, then the covered
// user/reply texts) to the golden store, and (3) the covered range is purged on the
// next request via the coverage-aware applyEjection. Checkpoints accumulate: the
// checkpoint stream IS the golden context.

/** System prompt for the evidence-summary call. */
export const EVIDENCE_SYSTEM_PROMPT =
  "You summarize completed agent turns for a long-running coding session. " +
  "Weigh the tool-call OUTPUTS as empirical evidence against the assistant's thinking trace: " +
  "note what the evidence confirms, what it contradicts, and the durable facts learned. " +
  "Do not narrate the process and do not re-derive anything the evidence settles. " +
  "Reply with the summary only — no preamble, no headings.";

/** Hard cap on serialized evidence input (chars); middle-truncated beyond it. */
export const EVIDENCE_INPUT_MAX_CHARS = 48_000;

/**
 * Rough "what the model sees" size in chars (text + reasoning + tool-call args + a small
 * per-message overhead) — divided by 4 this matches the mock harness's chars/token
 * heuristic. Used for the post-checkpoint context counter; always labeled "est".
 */
export function estimateContextChars(system: string, messages: AnyMessage[]): number {
  let n = Buffer.byteLength(system ?? "", "utf8") + 8;
  for (const m of messages) {
    n += 8;
    n += textBytes(m) + reasoningBytes(m);
    for (const b of (Array.isArray(m.content) ? (m.content as AssistantBlock[]) : [])) {
      if (b && TOOLCALL_TYPES.has(b.type)) {
        try { n += Buffer.byteLength(JSON.stringify((b as ToolCallBlock).arguments ?? ""), "utf8"); }
        catch { n += 64; }
      }
    }
  }
  return n;
}

/**
 * ENGINE-MEASURED anchor for "how full is the context": the prompt tokens that actually
 * sat in the KV cache for the last response (provider usage: input + cacheRead +
 * cacheWrite), plus the rendered system-prompt size at that point. Compaction triggers
 * must size from this instead of re-counting the raw chat window: the session store
 * intentionally keeps full message bodies that never reach the wire after a purge, and
 * pi's own threshold check falls back to chars/4 history estimates (or stale
 * pre-compaction usage) — both overestimate badly and re-trigger compaction when the
 * context is nowhere near full (findings §14).
 */
export interface KvAnchor {
  /** measured prompt tokens of the request that produced the anchor response */
  tokens: number;
  /** timestamp of that assistant message */
  ts: number;
  /** utf8 bytes of the rendered system prompt at anchor time */
  systemChars: number;
}

/**
 * KV-anchored context size in tokens: the anchor + chars/4 of ONLY what was added since
 * (messages dated after the anchor + system-prompt growth). Never re-counts history that
 * was already measured. Falls back to the full history estimate before the first
 * measured response (cold start).
 */
export function estimateContextSize(system: string, messages: AnyMessage[], anchor: KvAnchor | undefined): number {
  if (!anchor) return Math.ceil(estimateContextChars(system, messages) / 4);
  let delta = Math.max(0, Buffer.byteLength(system ?? "", "utf8") - anchor.systemChars);
  for (const m of messages) {
    const ts = typeof m.timestamp === "number" ? m.timestamp : 0;
    if (ts > anchor.ts) delta += estimateContextChars("", [m]) - 8;
  }
  return anchor.tokens + Math.ceil(delta / 4);
}

/** 1234 -> "1.2k"; token-count formatting for counters. */
export function formatTokens(tok: number): string {
  const t = Math.max(0, Math.round(tok));
  return t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);
}

export interface CheckpointPiece { ts: number; text: string; }

export interface CheckpointPlan {
  /** last message ts this checkpoint purges (excludes the live reply) — next coverage floor */
  coveredTs: number;
  /** purge range end: INCLUDES the live reply (its thinking is purged, its text kept) */
  purgeThroughTs: number;
  /** the final reply to the user — stays verbatim at the tail bottom until the NEXT checkpoint */
  keepTextTs: number | undefined;
  toolCallIds: string[];
  callLines: string[];
  userTexts: CheckpointPiece[];
  replyTexts: CheckpointPiece[];
  evidenceInput: string;
  /** raw covered messages (including the keep message) for purge/snapshot use */
  coveredMessages: AnyMessage[];
  stats: { calls: number; thinkingBytes: number; outputBytes: number; textBytes: number };
}

function oneLine(v: unknown): string {
  let s: string;
  try { s = typeof v === "string" ? v : JSON.stringify(v); } catch { s = String(v); }
  return s.replace(/\s+/g, " ").trim();
}

function clampMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 24) / 2);
  return `${s.slice(0, half)}\n…[${s.length - 2 * half} chars elided]…\n${s.slice(s.length - half)}`;
}

/**
 * Plan one idle checkpoint over the messages newer than `coveredFromTs` (the previous
 * checkpoint's coveredTs, or -Infinity for the first one — which folds the whole
 * existing history, as intended for a resumed old session).
 *
 * The KEEP split: the last assistant message carrying text is the reply the user is
 * reading. It is excluded from the coveredTs boundary (so the NEXT checkpoint folds it)
 * but included in the purge range (its thinking is purged; its text stays verbatim).
 */
export function collectCheckpoint(
  messages: AnyMessage[],
  coveredFromTs: number,
  cfg: Pick<GoldenConfig, "callLineMaxChars">,
): CheckpointPlan {
  const inRange: { msg: AnyMessage; ts: number }[] = [];
  let carryTs = 0;
  for (const msg of messages) {
    const raw = msg.timestamp;
    const ts = typeof raw === "number" ? raw : carryTs;
    if (typeof raw === "number") carryTs = ts;
    if (ts > coveredFromTs) inRange.push({ msg, ts });
  }

  let keepIdx = -1;
  for (let i = inRange.length - 1; i >= 0; i--) {
    const m = inRange[i].msg;
    if (m.role === "assistant" && textBytes(m) > 0) { keepIdx = i; break; }
  }

  const toolCallIds: string[] = [];
  const callLines: string[] = [];
  const userTexts: CheckpointPiece[] = [];
  const replyTexts: CheckpointPiece[] = [];
  let thinkingBytes = 0, outputBytes = 0, textBytesTotal = 0;
  let maxAllTs = -Infinity, maxPurgedTs = -Infinity;

  for (let i = 0; i < inRange.length; i++) {
    const { msg, ts } = inRange[i];
    maxAllTs = Math.max(maxAllTs, ts);
    if (i !== keepIdx) maxPurgedTs = Math.max(maxPurgedTs, ts);
    const texts = (Array.isArray(msg.content) ? (msg.content as Content[]) : []).filter((c) => c && c.type === "text") as TextContent[];

    if (msg.role === "user" || (msg.role as string) === "compactionSummary") {
      for (const t of texts) { userTexts.push({ ts, text: t.text }); textBytesTotal += Buffer.byteLength(t.text, "utf8"); }
    } else if (msg.role === "assistant") {
      const m = msg as unknown as AssistantLike;
      thinkingBytes += reasoningBytes(m);
      for (const t of texts) {
        if (i !== keepIdx) replyTexts.push({ ts, text: t.text }); // the keep reply stays live; folded next checkpoint
        textBytesTotal += Buffer.byteLength(t.text, "utf8");
      }
      for (const id of toolCallIdsOf(m)) toolCallIds.push(id);
      for (const b of (Array.isArray(m.content) ? m.content : [])) {
        if (b && TOOLCALL_TYPES.has(b.type)) {
          const call = b as ToolCallBlock;
          const line = `- ${call.name ?? "tool"}: ${oneLine(call.arguments)}`;
          callLines.push(line.length > cfg.callLineMaxChars ? line.slice(0, cfg.callLineMaxChars - 1) + "…" : line);
        }
      }
    } else if (msg.role === "toolResult") {
      outputBytes += textBytes(msg);
    }
  }

  // the keep message's text is NOT folded into this checkpoint (it stays live at the tail)
  const keepPiece = keepIdx >= 0 ? inRange[keepIdx] : undefined;
  return {
    coveredTs: Number.isFinite(maxPurgedTs) ? maxPurgedTs : (Number.isFinite(maxAllTs) ? maxAllTs : coveredFromTs),
    purgeThroughTs: Number.isFinite(maxAllTs) ? maxAllTs : coveredFromTs,
    keepTextTs: keepPiece?.ts,
    toolCallIds,
    callLines,
    userTexts,
    replyTexts,
    evidenceInput: serializeEvidenceInput(inRange.map((x) => x.msg)),
    coveredMessages: inRange.map((x) => x.msg),
    stats: { calls: callLines.length, thinkingBytes, outputBytes, textBytes: textBytesTotal },
  };
}

/** Serialize the covered turn for the evidence-summary call (thinking + outputs included). */
export function serializeEvidenceInput(messages: AnyMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const arr = Array.isArray(msg.content) ? (msg.content as (Content | ThinkingContent | ToolCallBlock)[]) : [];
    for (const b of arr) {
      if (!b) continue;
      if (b.type === "text") parts.push(`[${msg.role}] ${(b as TextContent).text}`);
      else if (REASONING_TYPES.has(b.type)) parts.push(`[thinking] ${(b as ThinkingContent).thinking ?? ""}`);
      else if (TOOLCALL_TYPES.has(b.type)) {
        const call = b as ToolCallBlock;
        parts.push(`[tool-call] ${call.name ?? "tool"} ${oneLine(call.arguments)}`);
      }
    }
    if (msg.role === "toolResult") {
      for (const c of (Array.isArray(msg.content) ? (msg.content as Content[]) : [])) {
        if (c && c.type === "text") parts.push(`[tool-output] ${c.text}`);
      }
    }
  }
  return clampMiddle(parts.join("\n"), EVIDENCE_INPUT_MAX_CHARS);
}

/**
 * Canonical checkpoint text (deterministic, append-only once committed):
 * covered user/reply texts preserved verbatim, then the tool calls line-by-line, then the
 * evidence summary — "the tool calls are listed line-by-line followed by the summary".
 */
export function buildCheckpointText(plan: CheckpointPlan, evidence: string): string {
  const lines: string[] = [];
  for (const p of plan.userTexts) lines.push(`[user] ${p.text}`);
  for (const p of plan.replyTexts) lines.push(`[reply] ${p.text}`);
  lines.push(...plan.callLines);
  lines.push(`[evidence] ${evidence.trim()}`);
  return lines.join("\n");
}

/** Prompt text for the evidence-summary call (the model may think; only the reply is kept). */
export function buildEvidencePrompt(plan: CheckpointPlan, cfg: Pick<GoldenConfig, "summaryTargetTokens" | "summaryMaxTokens">): string {
  return (
    `Turn evidence (tool-call outputs vs. the thinking trace):\n\n${plan.evidenceInput}\n\n` +
    `Summarize as specified. Aim for about ${cfg.summaryTargetTokens} tokens; hard cap ${cfg.summaryMaxTokens}.`
  );
}

/**
 * Splice a grown golden render into the run's rendered system prompt for the warm
 * prefill — byte-exact against what the next real request will send.
 *
 * - first checkpoint (`oldRender` empty): the run prompt had NO golden section yet; pi
 *   joins system-prompt sections with "\n\n", so append the whole wrapped section.
 * - growth: custom sections render LAST, so the new render must extend the old as a
 *   strict prefix and splices in before the closing tag.
 * Returns null when byte-exactness cannot be guaranteed (caller skips the prefill).
 */
export function spliceGoldenSection(runPrompt: string, oldRender: string, newRender: string): string | null {
  if (!newRender) return null;
  const suffix = "\n</golden>";
  if (!oldRender) return `${runPrompt}\n\n<golden>\n${newRender}\n</golden>`;
  // the run prompt must end with exactly the old render + closing tag (golden last AND
  // content identical), and the new render must extend the old as a strict prefix
  const tail = oldRender + suffix;
  if (!runPrompt.endsWith(tail) || !newRender.startsWith(oldRender)) return null;
  return runPrompt.slice(0, -tail.length) + newRender + suffix;
}

/**
 * Resolve the current tool loadout from the transcript's system messages, mirroring
 * pi-ai's getCurrentTools (toolsAdded in order, toolsRemoved deletes). The warm prefill
 * must send the same `tools` as the next real request or the prefix cache cannot hit —
 * extension tools like commit_decision are only added by a LATER system message patch.
 */
export function resolveToolLoadout(messages: AnyMessage[]): unknown[] {
  const tools = new Map<string, unknown>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    const m = message as unknown as { toolsAdded?: { name?: string }[]; toolsRemoved?: { name?: string }[] };
    for (const tool of m.toolsRemoved ?? []) if (tool?.name) tools.delete(tool.name);
    for (const tool of m.toolsAdded ?? []) if (tool?.name) tools.set(tool.name, tool);
  }
  return [...tools.values()];
}

// ---- LLM message projection (mirrors pi's core/messages.js convertToLlm) ----
// The package's `exports` map blocks importing it from an extension, and the warm prefill
// must serialize EXACTLY what the next real request sends — including how pi folds its
// custom transcript roles (compactionSummary/bashExecution/custom/branchSummary) into
// user messages. Copied verbatim; if pi changes these strings the prefill silently
// degrades to a cache miss (safe), so keep them in sync when updating pi.

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;
export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;
export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

function bashExecutionToText(m: Record<string, unknown>): string {
  let text = `Ran \`${m.command ?? ""}\`\n`;
  if (m.output) text += `\`\`\`\n${m.output}\n\`\`\``;
  else text += "(no output)";
  if (m.cancelled) text += "\n\n(command cancelled)";
  else if (m.exitCode !== null && m.exitCode !== undefined && m.exitCode !== 0) text += `\n\nCommand exited with code ${m.exitCode}`;
  if (m.truncated && m.fullOutputPath) text += `\n\n[Output truncated. Full output: ${m.fullOutputPath}]`;
  return text;
}

/** Project transcript messages onto the provider's LLM message shapes (never throws). */
export function toLlmMessages(messages: AnyMessage[]): AnyMessage[] {
  const out: AnyMessage[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "bashExecution": {
        const x = m as unknown as Record<string, unknown>;
        if (x.excludeFromContext) continue;
        out.push({ role: "user", content: [{ type: "text", text: bashExecutionToText(x) }], timestamp: x.timestamp } as AnyMessage);
        continue;
      }
      case "custom": {
        const x = m as unknown as { content?: unknown; timestamp?: number };
        const content = typeof x.content === "string" ? [{ type: "text", text: x.content }] : (x.content ?? []);
        out.push({ role: "user", content, timestamp: x.timestamp } as AnyMessage);
        continue;
      }
      case "branchSummary": {
        const x = m as unknown as { summary?: string; timestamp?: number };
        out.push({ role: "user", content: [{ type: "text", text: BRANCH_SUMMARY_PREFIX + (x.summary ?? "") + BRANCH_SUMMARY_SUFFIX }], timestamp: x.timestamp } as AnyMessage);
        continue;
      }
      case "compactionSummary": {
        const x = m as unknown as { summary?: string; timestamp?: number };
        out.push({ role: "user", content: [{ type: "text", text: COMPACTION_SUMMARY_PREFIX + (x.summary ?? "") + COMPACTION_SUMMARY_SUFFIX }], timestamp: x.timestamp } as AnyMessage);
        continue;
      }
      case "system":
      case "user":
      case "assistant":
      case "toolResult":
        out.push(m);
        continue;
      default:
        continue; // unknown roles are dropped, like pi's exhaustive default
    }
  }
  return out;
}
