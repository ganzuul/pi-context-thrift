// Offline test for the golden-context extension WITHOUT loading pi.
// Uses jiti from pi's node_modules; aliases the pi package to a stub and typebox to real.
// Run: node golden-context/test/run.mjs

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// pi's install dir: PI_DIR env -> `pi` on PATH -> `npm root -g` (see _pi-dir.mjs)
const { resolvePiDir } = await import("./_pi-dir.mjs");
const PI_DIR = resolvePiDir();
const jitiRequire = require(join(PI_DIR, "node_modules/jiti"));
const jiti = jitiRequire(join(__dirname, "run.mjs"), {
  interopDefault: true,
  cache: false,
  alias: {
    "@earendil-works/pi-coding-agent": join(__dirname, "_pi-stub.mjs"),
    typebox: join(PI_DIR, "node_modules/typebox/build/index.mjs"),
  },
});

// isolated agent dir for the store file
const AGENT = mkdtempSync(join(tmpdir(), "pi-golden-test-"));
process.env.PI_GOLDEN_TEST_AGENTDIR = AGENT;

const core = jiti(join(__dirname, "..", "golden-core.ts"));

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("ok  -", name); }
  else { fail++; console.log("FAIL -", name); }
}

// ---- KV-anchored sizing (findings §14: sizing from chat history re-fires compaction) ----
{
  const sys = "S".repeat(400);
  const oldBig = [{ role: "toolResult", timestamp: 1, content: [{ type: "text", text: "x".repeat(400000) }] }];
  const anchor = { tokens: 5000, ts: 900000, systemChars: Buffer.byteLength(sys) };
  check("no anchor -> full history estimate (cold start)", core.estimateContextSize(sys, oldBig, undefined) >= 100000);
  check("anchor ignores already-measured history", core.estimateContextSize(sys, oldBig, anchor) === 5000);
  const grown = [...oldBig, { role: "user", content: [{ type: "text", text: "new".repeat(400) }], timestamp: 900001 }];
  const s2 = core.estimateContextSize(sys, grown, anchor);
  check("anchor adds only growth since the measurement", s2 > 5000 && s2 < 5000 + 1500);
  check("system-prompt growth counts toward the size", core.estimateContextSize(sys + "GROWTH".repeat(100), oldBig, anchor) > 5000);
}

// ---- parseConfig ----
const d = core.parseConfig({});
check("defaults conservative (no auto-eject)", d.autoEjectOldToolResults === false && d.tailKeepToolResults === 4);
check("takeover defaults on (pi's compaction replaced)", d.takeoverCompaction === true && d.contextFullPct === 80);
check("contextFullPct clamps to sane range", core.parseConfig({ contextFullPct: 5 }).contextFullPct === 10 && core.parseConfig({ contextFullPct: 500 }).contextFullPct === 99);
check("parseConfig never throws on garbage", (() => { try { core.parseConfig("x"); core.parseConfig(null); core.parseConfig(3); return true; } catch { return false; } })());
check("parseConfig override", core.parseConfig({ tailKeepToolResults: 2, autoEjectOldToolResults: true }).tailKeepToolResults === 2);

// ---- renderGoldenSection: append-only strict-prefix (THE core invariant) ----
const cfg = core.parseConfig({});
const e0 = { seq: 0, ts: 1, kind: "record", text: "use --ctx-size 48000 to free VRAM", spend: [] };
const e1 = { seq: 1, ts: 2, kind: "record", text: "experts 0..41 stay in RAM", spend: [] };
const r0 = core.renderGoldenSection([e0], cfg);
const r01 = core.renderGoldenSection([e0, e1], cfg);
check("empty entries -> empty section", core.renderGoldenSection([], cfg) === "");
check("render([e0]) is a STRICT PREFIX of render([e0,e1])", r01.startsWith(r0) && r01.length > r0.length);
check("no trailing newline (so growth only appends)", !/\n$/.test(r0));
check("discard entries never rendered", core.renderGoldenSection([e0, { seq: 9, ts: 3, kind: "discard", text: "noise", spend: [] }], cfg) === r0);
check("ts not present in rendered bytes", !r0.includes(String(e0.ts)));

// ---- collectSpentIds ----
const spent = core.collectSpentIds([e0, { seq: 2, ts: 9, kind: "record", text: "t", spend: ["callA", "callB"] }]);
check("collectSpentIds gathers spend ids", spent.has("callA") && spent.has("callB"));

// ---- ejection helpers ----
function bigTool(id, bytes = 5000, extra = {}) {
  return { role: "toolResult", toolCallId: id, toolName: "read", isError: false, timestamp: 1,
           content: [{ type: "text", text: "x".repeat(bytes) }], ...extra };
}

const msgs = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
  bigTool("id0"),
  { role: "assistant", content: [{ type: "text", text: "ok" }] },
  bigTool("id1"),
  bigTool("id2"),
];

// 1) default config (auto off, no spent) -> NOTHING ejected
let res = core.applyEjection(msgs, core.parseConfig({}), new Set());
check("conservative default ejects nothing", res.ejected === 0 && res.messages === msgs);

// 2) explicit spend of id0 -> only id0 collapsed, others untouched; pairing preserved
res = core.applyEjection(msgs, core.parseConfig({ tailKeepToolResults: 0 }), new Set(["id0"]));
const out0 = res.messages[1];
check("spent id0 collapsed to a handle", out0 !== msgs[1] && out0.content[0].text.startsWith("[golden]"));
check("spent id0 preserves role/toolCallId/toolName/isError", out0.role === "toolResult" && out0.toolCallId === "id0" && out0.toolName === "read" && out0.isError === false);
check("unspent id1/id2 untouched", res.messages[3] === msgs[3] && res.messages[4] === msgs[4]);
check("ejection never DELETES a message (count stable)", res.messages.length === msgs.length);
check("bytesRemoved > 0", res.bytesRemoved > 0);

// 3) auto-eject with tailKeep protects the last N; only old+large outside tail are pruned
const auto = core.parseConfig({ autoEjectOldToolResults: true, tailKeepToolResults: 1, minResultBytesToEject: 1024 });
res = core.applyEjection(msgs, auto, new Set());
check("auto-eject protects last tailKeep (id2 kept)", res.messages[4] === msgs[4]);
check("auto-eject prunes an older large result (id0)", res.messages[1] !== msgs[1] && res.messages[1].content[0].text.startsWith("[golden]"));

// 4) image-bearing toolResult is never auto-ejected (conservative)
const imgMsgs = [ bigTool("im", 5000, { content: [{ type: "text", text: "y".repeat(5000) }, { type: "image", data: "AAA" }] }) ];
res = core.applyEjection(imgMsgs, core.parseConfig({ autoEjectOldToolResults: true, tailKeepToolResults: 0, minResultBytesToEject: 10 }), new Set());
check("auto-eject skips image results", res.messages[0] === imgMsgs[0] && res.ejected === 0);

// 4b) ABSOLUTE tail protection: explicit spend cannot eject a result still within tailKeep
const tailMsgs = [ bigTool("a"), bigTool("b") ];
res = core.applyEjection(tailMsgs, core.parseConfig({ tailKeepToolResults: 4 }), new Set(["a"]));
check("absolute tail: explicit spend of an in-tail result is NOT ejected", res.ejected === 0 && res.messages === tailMsgs);
// ...but with tailKeep=0 the same explicit spend DOES prune it (model override only past the tail)
res = core.applyEjection(tailMsgs, core.parseConfig({ tailKeepToolResults: 0 }), new Set(["a"]));
check("tailKeep=0 allows explicit spend to eject", res.ejected === 1 && res.messages[0].content[0].text.startsWith("[golden]"));

// 5) disabled master switch -> untouched
res = core.applyEjection(msgs, core.parseConfig({ enabled: false }), new Set(["id0"]));
check("disabled cfg ejects nothing even when spent", res.messages === msgs && res.ejected === 0);

// 6) DISTILL rule: spending a call strips its reasoning block from the issuing assistant turn
const assistantTurn = { role: "assistant", content: [
  { type: "thinking", thinking: "the build needs -O3, let me set it" },
  { type: "text", text: "compiling" },
  { type: "toolCall", id: "cD", name: "read", arguments: { path: "/f" } } ] };
const toolOut = { role: "toolResult", toolCallId: "cD", toolName: "read", isError: false,
  timestamp: 1, content: [{ type: "text", text: "b".repeat(3000) }] };
const supersede = { role: "assistant", content: [{ type: "toolCall", id: "cE", name: "read", arguments: { path: "/g" } }] };
const distillMsgs = [assistantTurn, toolOut, supersede];
let dr = core.applyEjection(distillMsgs, core.parseConfig({ tailKeepToolResults: 0 }), new Set(["cD"]));
check("distill strips reasoning from the spent assistant turn (keeps text+toolCall)",
  dr.reasoningStripped === 1 && dr.messages[0].content.every((b) => b.type !== "thinking") &&
  dr.messages[0].content.some((b) => b.type === "toolCall" && b.id === "cD") &&
  dr.messages[0].content.some((b) => b.type === "text"));
check("distill collapses the spent tool result", dr.messages[1].content[0].text.startsWith("[golden]"));
check("distill leaves the superseding next call (cE) untouched", dr.messages[2] === distillMsgs[2]);
// stripThinkingOnSpend=false -> reasoning preserved even when output collapsed
dr = core.applyEjection(distillMsgs, core.parseConfig({ tailKeepToolResults: 0, stripThinkingOnSpend: false }), new Set(["cD"]));
check("stripThinkingOnSpend=false keeps reasoning", dr.reasoningStripped === 0 && dr.messages[0].content.some((b) => b.type === "thinking") && dr.ejected === 1);
// ABSOLUTE tail also protects reasoning: cD within last tailKeep -> nothing touched
dr = core.applyEjection(distillMsgs, core.parseConfig({ tailKeepToolResults: 1 }), new Set(["cD"]));
check("absolute tail protects reasoning + output together", dr.reasoningStripped === 0 && dr.ejected === 0 && dr.messages === distillMsgs);
// distill kind is parseable + renders
check("parseGoldenLine accepts distill kind", core.parseGoldenLine(JSON.stringify({ seq: 0, kind: "distill", text: "h", spend: [] }))?.kind === "distill");

// ---- parseCommitArgs (the /golden-commit grammar) ----
check("parseCommitArgs defaults to record", (() => { const r = core.parseCommitArgs("lower the ctx"); return r.kind === "record" && r.text === "lower the ctx" && r.spend.length === 0; })());
check("parseCommitArgs parses explicit kind", (() => { const r = core.parseCommitArgs("distill hindsight line"); return r.kind === "distill" && r.text === "hindsight line"; })());
check("parseCommitArgs parses spend ids", (() => { const r = core.parseCommitArgs("distill spend:callA,callB the text"); return r.kind === "distill" && r.text === "the text" && r.spend.join(",") === "callA,callB"; })());
check("parseCommitArgs spend without kind still works", (() => { const r = core.parseCommitArgs("spend:callA plain"); return r.kind === "record" && r.text === "plain" && r.spend.join(",") === "callA"; })());
check("parseCommitArgs handles empty args", (() => { const r = core.parseCommitArgs("  "); return r.kind === "record" && r.text === "" && r.spend.length === 0; })());

// ---- describeEjection (dry-run == real run invariant) ----
{
  const plan = core.describeEjection(msgs, core.parseConfig({ tailKeepToolResults: 0 }), new Set(["id0"]));
  check("describeEjection reports the ejected result", plan.items.length === 1 && plan.items[0].action === "eject-result" && plan.items[0].toolCallId === "id0");
  check("describeEjection counts agree with applyEjection", plan.ejected === 1 && plan.bytesRemoved > 0);
  const dplan = core.describeEjection(distillMsgs, core.parseConfig({ tailKeepToolResults: 0 }), new Set(["cD"]));
  check("describeEjection reports BOTH distill actions", dplan.items.length === 2 &&
    dplan.items.some((i) => i.action === "strip-thinking") && dplan.items.some((i) => i.action === "eject-result"));
  check("describeEjection never mutates the input", msgs[1].content[0].text.length === 5000 && distillMsgs[0].content.some((b) => b.type === "thinking"));
  check("describeEjection empty plan when nothing to do", core.describeEjection(msgs, core.parseConfig({}), new Set()).items.length === 0);
}

// ---- formatStatus ----
{
  const s = core.formatStatus({ enabled: true, storePath: "/x/golden.jsonl", entryCount: 2, seq: 2, spentIds: ["callA"], lastEntry: e1, cfg, usageLine: "1000/24000 (4.2%)" });
  check("formatStatus lists store + spent + usage", s.includes("/x/golden.jsonl") && s.includes("callA") && s.includes("1000/24000") && s.includes("[1]"));
}

// ---- idle checkpointing: collect/plan/build ----
{
  const ck = core.parseConfig({});
  const turn = [
    { role: "user", content: [{ type: "text", text: "build the project" }], timestamp: 100 },
    { role: "assistant", content: [
      { type: "thinking", thinking: "let me run make and see" },
      { type: "toolCall", id: "t1", name: "bash", arguments: { command: "make -j8" } } ], timestamp: 101 },
    { role: "toolResult", toolCallId: "t1", toolName: "bash", isError: false, timestamp: 102,
      content: [{ type: "text", text: "BUILD OK\n".repeat(20) }] },
    { role: "assistant", content: [
      { type: "thinking", thinking: "it worked" },
      { type: "text", text: "Build succeeded." } ], timestamp: 103 },
  ];
  const plan = core.collectCheckpoint(turn, Number.NEGATIVE_INFINITY, ck);
  check("collect: keepTextTs = final reply ts (stays verbatim)", plan.keepTextTs === 103);
  check("collect: coveredTs excludes the live reply", plan.coveredTs === 102 && plan.purgeThroughTs === 103);
  check("collect: tool call ids + line-by-line call lines", plan.toolCallIds.join(",") === "t1" && plan.callLines.length === 1 && /^- bash: /.test(plan.callLines[0]));
  check("collect: user texts kept, keep-reply NOT folded yet", plan.userTexts.length === 1 && plan.replyTexts.length === 0);
  check("collect: evidence input carries outputs + thinking", plan.evidenceInput.includes("[tool-output]") && plan.evidenceInput.includes("[thinking]"));
  const text = core.buildCheckpointText(plan, "make -j8 built cleanly (20 warnings elided).");
  check("build: user text, then calls, then [evidence]", text.indexOf("[user]") < text.indexOf("- bash:") && text.indexOf("- bash:") < text.indexOf("[evidence]"));
  check("build: evidence summary appended verbatim", text.endsWith("[evidence] make -j8 built cleanly (20 warnings elided)."));
  check("evidence prompt states target + cap", /about 128 tokens/.test(core.buildEvidencePrompt(plan, ck)) && /hard cap 512/.test(core.buildEvidencePrompt(plan, ck)));

  // second checkpoint folds the previous reply (the "checkpoint grows" semantics)
  const turn2 = [
    ...turn,
    { role: "user", content: [{ type: "text", text: "now test it" }], timestamp: 200 },
    { role: "assistant", content: [{ type: "text", text: "All 51 tests pass." }], timestamp: 201 },
  ];
  const plan2 = core.collectCheckpoint(turn2, plan.coveredTs, ck);
  check("collect: next range starts after previous coveredTs", plan2.userTexts.length === 1 && plan2.userTexts[0].text === "now test it");
  check("collect: previous reply folds into the next checkpoint", plan2.replyTexts.length === 1 && plan2.replyTexts[0].text === "Build succeeded.");
  check("collect: keep moves to the new reply", plan2.keepTextTs === 201 && plan2.coveredTs === 200);

  // call line truncation
  const big = [{ role: "assistant", content: [{ type: "toolCall", id: "t9", name: "write", arguments: { path: "/f", content: "z".repeat(500) } }], timestamp: 5 }];
  const p3 = core.collectCheckpoint(big, Number.NEGATIVE_INFINITY, core.parseConfig({ callLineMaxChars: 40 }));
  check("collect: call lines honor callLineMaxChars", p3.callLines[0].length <= 40 && p3.callLines[0].endsWith("…"));

  // round-trip with coverage fields
  const e = { seq: 3, ts: 9, kind: "checkpoint", text: "t", spend: ["a"], coveredTs: 102, keepTs: 103 };
  const rt = core.parseGoldenLine(core.entryToJsonLine(e));
  check("checkpoint entry round-trips coveredTs/keepTs", rt?.coveredTs === 102 && rt?.keepTs === 103 && rt?.kind === "checkpoint");
  const cov = rt ? core.coverageFromEntry(rt, core.parseConfig({})) : undefined;
  check("coverageFromEntry: throughTs = keepTs (purge incl. reply thinking)", cov?.throughTs === 103 && cov?.keepTextTs === 103);
  check("coverageFromEntry: non-checkpoint entries yield none", core.coverageFromEntry(e1, core.parseConfig({})) === undefined);

  // checkpoint lines render in golden and keep the strict-prefix invariant
  const base = core.renderGoldenSection([e0], ck);
  const withCk = core.renderGoldenSection([e0, { ...e, text: core.buildCheckpointText(plan, "ev") }], ck);
  check("checkpoint entries render append-only (strict prefix)", withCk.startsWith(base) && withCk.length > base.length);

  // prefill splice: byte-exact warm system prompt
  check("splice: first checkpoint appends the wrapped section",
    core.spliceGoldenSection("BASE", "", withCk) === `BASE\n\n<golden>\n${withCk}\n</golden>`);
  check("splice: growth splices before the closing tag",
    core.spliceGoldenSection(`BASE\n\n<golden>\n${base}\n</golden>`, base, withCk) === `BASE\n\n<golden>\n${withCk}\n</golden>`);
  check("splice: refuses when the prefix invariant broke", core.spliceGoldenSection("BASE\n\n<golden>\nOTHER\n</golden>", base, withCk) === null);
  check("splice: refuses when golden is not the last section", core.spliceGoldenSection(`BASE\n<golden>\n${base}\n</golden>\nTAIL`, base, withCk) === null);
  check("splice: empty render -> null", core.spliceGoldenSection("BASE", "", "") === null);

  // LLM projection mirrors pi's convertToLlm (byte-exact prefill depends on it)
  const proj = core.toLlmMessages([
    { role: "compactionSummary", summary: "S", timestamp: 5 },
    { role: "bashExecution", command: "ls", output: "ok", exitCode: 0, timestamp: 6 },
    { role: "custom", content: "hello", timestamp: 7 },
    { role: "user", content: [{ type: "text", text: "plain" }], timestamp: 8 },
    { role: "weird-future-role", timestamp: 9 },
  ]);
  check("toLlm: compactionSummary -> user with pi's exact wrapping",
    proj[0].role === "user" && proj[0].content[0].text === core.COMPACTION_SUMMARY_PREFIX + "S" + core.COMPACTION_SUMMARY_SUFFIX);
  check("toLlm: bashExecution/custom -> user", proj[1].role === "user" && /Ran `ls`/.test(proj[1].content[0].text) && proj[2].role === "user");
  check("toLlm: standard roles pass through, unknown dropped", proj[3].role === "user" && proj.length === 4);

  // context counter helpers
  check("formatTokens formats token counts", core.formatTokens(1234) === "1.2k" && core.formatTokens(999) === "999");
  {
    const full = [{ role: "toolResult", toolCallId: "x", toolName: "t", isError: false, timestamp: 1, content: [{ type: "text", text: "z".repeat(4000) }] }];
    const hollow = core.applyEjection(full, core.parseConfig({ tailKeepToolResults: 0 }), new Set(["x"]));
    const pre = core.estimateContextChars("S", full);
    const post = core.estimateContextChars("S", hollow.messages);
    check("estimateContextChars shrinks with the purge (counter math)", pre - post > 3000);
  }
}

// ---- coverage-aware purge (the checkpoint's purge channel) ----
{
  const cfgC = core.parseConfig({ tailKeepToolResults: 4, hollowCoveredText: true });
  const msgsC = [
    { role: "user", content: [{ type: "text", text: "build the project" }], timestamp: 100 },
    { role: "assistant", content: [
      { type: "thinking", thinking: "run make" },
      { type: "toolCall", id: "t1", name: "bash", arguments: { command: "make" } } ], timestamp: 101 },
    { role: "toolResult", toolCallId: "t1", toolName: "bash", isError: false, timestamp: 102,
      content: [{ type: "text", text: "x".repeat(3000) }] },
    { role: "assistant", content: [
      { type: "thinking", thinking: "worked" },
      { type: "text", text: "Build succeeded." } ], timestamp: 103 },
    { role: "user", content: [{ type: "text", text: "thanks" }], timestamp: 200 },
  ];
  const coverage = { throughTs: 103, keepTextTs: 103, hollowText: true, foldLabel: "folded into checkpoint [0]" };
  const r = core.applyEjection(msgsC, cfgC, new Set(), coverage);
  check("coverage purges covered toolResult DESPITE tail protection", r.ejected === 1 && r.messages[2].content[0].text.startsWith("[golden]"));
  check("coverage strips ALL covered thinking (incl. keep reply)", r.reasoningStripped === 2 &&
    r.messages[1].content.every((b) => b.type !== "thinking") && r.messages[3].content.every((b) => b.type !== "thinking"));
  check("coverage folds covered user text into a handle", r.messages[0].content[0].text.startsWith("[golden] user text folded into checkpoint [0]"));
  check("keep reply text stays verbatim", r.messages[3].content.some((b) => b.type === "text" && b.text === "Build succeeded."));
  check("post-coverage messages untouched", r.messages[4] === msgsC[4]);
  check("coverage never deletes (count stable)", r.messages.length === msgsC.length && r.textFolded === 1);
  // hollowCoveredText=false keeps text, still purges outputs+thinking
  const r2 = core.applyEjection(msgsC, core.parseConfig({ hollowCoveredText: false }), new Set(), coverage);
  check("hollowCoveredText=false keeps text but purges outputs/thinking", r2.textFolded === 0 && r2.ejected === 1 && r2.reasoningStripped === 2);
  // describeEjection classifies folds
  const planDry = core.describeEjection(msgsC, cfgC, new Set(), coverage);
  check("dry-run classifies fold-text + eject-result + strip", planDry.items.some((i) => i.action === "fold-text") && planDry.items.some((i) => i.action === "eject-result"));
}

// ---- store scoping (the bug: one global store leaked every project's golden into new dirs) ----
{
  const s = core.parseConfig({});
  check("default scope is cwd (fresh context per directory)", s.scope === "cwd");
  check("scope:global / scope:git honored",
    core.parseConfig({ scope: "global" }).scope === "global" && core.parseConfig({ scope: "git" }).scope === "git");
  check("invalid scope falls back to cwd", core.parseConfig({ scope: "nonsense" }).scope === "cwd");

  // must match pi's OWN per-directory session naming, not an invention of ours
  check("encodeCwdScope: posix path", core.encodeCwdScope("/srv/users/dev/projects/alpha") === "--srv-users-dev-projects-alpha--");
  check("encodeCwdScope: strips leading slash, maps : and \\ to -",
    core.encodeCwdScope("/C:/Users/me/proj") === "--C--Users-me-proj--");

  const dirs = new Set(["/repo/.git", "/repo/sub/other"]);
  check("findGitRoot: nearest ancestor with .git", core.findGitRoot("/repo/sub/pkg", (p) => dirs.has(p)) === "/repo");
  check("findGitRoot: worktree/submodule (.git FILE)", core.findGitRoot("/repo/x", (p) => p === "/repo/.git") === "/repo");
  check("findGitRoot: null outside a repo", core.findGitRoot("/a/b", () => false) === null);

  check("scopeKeyFor: global -> null (historic single store)",
    core.scopeKeyFor({ scope: "global" }, "/x/y", null) === null);
  check("scopeKeyFor: git uses the repo root",
    core.scopeKeyFor({ scope: "git" }, "/repo/sub", "/repo") === "--repo--");
  check("scopeKeyFor: git degrades to cwd when not a repo",
    core.scopeKeyFor({ scope: "git" }, "/loose/dir", null) === "--loose-dir--");
  check("scopeKeyFor: cwd ignores the git root",
    core.scopeKeyFor({ scope: "cwd" }, "/repo/sub", "/repo") === "--repo-sub--");
}

// Deterministic launch dir for the adapter tests: the store is scoped per directory, so this
// fixture cwd decides where the adapter reads/writes golden.jsonl.
const FIXTURE_CWD = "/golden-fixture-project";
const STORE = join(AGENT, "golden-context", core.encodeCwdScope(FIXTURE_CWD), "golden.jsonl");

// ---- ADAPTER end-to-end via the stubbed pi surface ----
const adapter = jiti(join(__dirname, "..", "golden-context.ts"));
const handlers = {};
const registeredTools = {};
const registeredCommands = {};
const fakePi = {
  on(evt, h) { (handlers[evt] ||= []).push(h); },
  registerTool(t) { registeredTools[t.name] = t; },
  registerCommand(name, opts) { registeredCommands[name] = opts; },
};
adapter.default ? adapter.default(fakePi) : adapter(fakePi);

check("adapter registers commit_decision tool", !!registeredTools.commit_decision);
check("adapter wires the 4 discrete commands", ["golden-status", "golden-render", "golden-commit", "golden-eject"].every((n) => typeof registeredCommands[n]?.handler === "function"));
check("adapter wired session_start/before_agent_start/context", !!handlers.session_start && !!handlers.before_agent_start && !!handlers.context);

// drive session_start (fresh store), commit via tool, then assert golden section + spend
(async () => {
  await handlers.session_start[0]({}, { cwd: FIXTURE_CWD });
  const toolRes = await registeredTools.commit_decision.execute("tc1", { decision: "record", text: "lower ctx to free VRAM", spendToolCallIds: ["id9"] }, undefined, undefined, { cwd: process.cwd() });
  check("commit returns confirmation text", typeof toolRes.content?.[0]?.text === "string" && /Golden committed/.test(toolRes.content[0].text));

  const event = { systemPromptOptions: { sections: {} } };
  handlers.before_agent_start[0](event);
  const sec = event.systemPromptOptions.sections.golden;
  check("before_agent_start injects a golden section", typeof sec === "string" && sec.includes("lower ctx to free VRAM"));

  // ABSOLUTE tail protection: with default tailKeepToolResults=4 and only two toolResults,
  // BOTH are within the protected tail, so even an explicit spend of id9 is NOT pruned and the
  // context handler leaves the list untouched (returns undefined). Ejection only past the tail.
  const recent = { role: "toolResult", toolCallId: "idFRESH", toolName: "bash", isError: false, timestamp: 2,
                   content: [{ type: "text", text: "w".repeat(5000) }] };
  const ev2 = { messages: [ { role: "toolResult", toolCallId: "id9", toolName: "read", isError: false, timestamp: 1,
                              content: [{ type: "text", text: "z".repeat(5000) }] }, recent ] };
  // IN-FLIGHT compaction trigger needs a ctx; existing tests pass {} (no model -> no trigger)
  const r = await handlers.context[0](ev2, {});
  check("absolute tail: in-tail explicit spend NOT pruned (returns undefined)", r === undefined);
  check("store file was written durably", (() => { try { const { existsSync, readFileSync } = require("node:fs"); return existsSync(STORE) && /lower ctx to free VRAM/.test(readFileSync(STORE, "utf8")); } catch { return false; } })());

  // ---- discrete commands through a fake command context ----
  const notices = [], widgets = [];
  const fakeCtx = {
    ui: {
      notify(msg) { notices.push(String(msg)); },
      setWidget(key, lines) { widgets.push({ key, lines }); },
    },
    sessionManager: { getBranch: () => [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { type: "message", message: bigTool("cmdA", 4000) },
      { type: "message", message: bigTool("cmdB", 4000) },
    ] },
    getContextUsage: () => ({ tokens: 1234, contextWindow: 24000, percent: 5.1 }),
  };

  await registeredCommands["golden-status"].handler("", fakeCtx);
  check("/golden-status reports store + usage", notices.some((n) => /golden-context: enabled/.test(n) && /1234\/24000/.test(n)));

  await registeredCommands["golden-render"].handler("", fakeCtx);
  check("/golden-render shows the section bytes", notices.some((n) => /bytes/.test(n) && /lower ctx to free VRAM/.test(n)));

  const beforeSeq = (await registeredCommands["golden-commit"].handler("distill spend:cmdA hindsight from the old session", fakeCtx), true);
  check("/golden-commit appends + notifies", beforeSeq && notices.some((n) => /Golden committed \[\d+\] distill/.test(n) && /1 tool output/.test(n)));
  {
    const { readFileSync } = require("node:fs");
    const lines = readFileSync(STORE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const last = lines[lines.length - 1];
    check("/golden-commit persisted kind+spend", last.kind === "distill" && last.spend.includes("cmdA") && /hindsight from the old session/.test(last.text));
  }

  // after the commit, cmdA is spent: the dry run must now plan its ejection (cmdA sits
  // outside tailKeep=4? both cmdA/cmdB are within the last 4 toolResults => protected).
  await registeredCommands["golden-eject"].handler("", fakeCtx);
  check("/golden-eject honors tail protection (nothing to do yet)", notices.some((n) => /nothing to do/.test(n)));

  // with tailKeep=0 the same dry run plans the ejection of the spent result
  const { writeFileSync } = require("node:fs");
  writeFileSync(join(AGENT, "golden-context", "config.json"), JSON.stringify({ tailKeepToolResults: 0 }));
  await handlers.session_start[0]({}, { cwd: FIXTURE_CWD }); // reload config from disk
  notices.length = 0;
  await registeredCommands["golden-eject"].handler("", fakeCtx);
  check("/golden-eject plans ejection past the tail", notices.some((n) => /would change 1 message/.test(n) && /eject-result .*cmdA/.test(n)));

  // ---- idle checkpointing through agent_settled (background, model call stubbed) ----
  const { readFileSync } = require("node:fs");
  const storePath = STORE;
  // the run prompt must be self-consistent: its golden section = the render of what is
  // actually in the store at before_agent_start time (the splice verifies exactly this)
  const preLines = readFileSync(storePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const preRender = core.renderGoldenSection(preLines.map((l) => ({ ...l, spend: l.spend ?? [] })), core.parseConfig({}));
  const fakeRunPrompt = `BASE-PROMPT\n<golden>\n${preRender}\n</golden>`;
  const streamCalls = [];
  const statusCalls = [];
  const ckCtx = {
    ui: { setStatus(k, t) { statusCalls.push(String(t ?? "")); }, notify(m) { notices.push(String(m)); }, setWidget() {} },
    model: { id: "tinyclip", provider: "mock" },
    thinkingLevel: "low",
    isIdle: () => true,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
      streamSimple: (model, context, options) => {
        streamCalls.push({ model, context, options });
        return { result: async () => ({ content: [
          { type: "thinking", thinking: "SECRET-THINKING-MUST-NOT-PERSIST" },
          { type: "text", text: "make -j8 succeeded; evidence confirms the plan." } ] }) };
      },
    },
    getSystemPrompt: () => "BASE-PROMPT\n<golden>\nOLD-SECTION\n</golden>",
    sessionManager: { getBranch: () => [
      { type: "message", message: { role: "system", content: "", toolsAdded: [{ name: "bash", description: "d", parameters: {} }], timestamp: 1 } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "build the project" }], timestamp: 100 } },
      { type: "message", message: { role: "assistant", content: [
        { type: "thinking", thinking: "run make" },
        { type: "toolCall", id: "tCK1", name: "bash", arguments: { command: "make -j8" } } ], timestamp: 101 } },
      { type: "message", message: { role: "toolResult", toolCallId: "tCK1", toolName: "bash", isError: false, timestamp: 102,
        content: [{ type: "text", text: "BUILD OK" }] } },
      { type: "message", message: { role: "assistant", stopReason: "stop", content: [
        { type: "thinking", thinking: "done" },
        { type: "text", text: "Build succeeded." } ], timestamp: 103 } },
    ] },
  };
  // before_agent_start captures the run prompt for the prefill splice
  handlers.before_agent_start[0]({ systemPromptOptions: { sections: {} }, get systemPrompt() { return fakeRunPrompt; } });
  handlers.agent_settled[0]({}, ckCtx);
  // fire-and-forget: poll the store until the checkpoint lands
  let ckEntry = null;
  for (let i = 0; i < 50 && !ckEntry; i++) {
    await new Promise((r) => setTimeout(r, 20));
    try {
      const lines = readFileSync(storePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      ckEntry = lines.find((l) => l.kind === "checkpoint") ?? null;
    } catch { /* not yet */ }
  }
  check("agent_settled commits a checkpoint entry", !!ckEntry);
  check("checkpoint lists calls + [evidence] summary", /- bash: /.test(ckEntry?.text ?? "") && /\[evidence\] make -j8 succeeded/.test(ckEntry?.text ?? ""));
  check("checkpoint preserves the covered user text", /\[user\] build the project/.test(ckEntry?.text ?? ""));
  check("checkpoint keeps only the summary reply (no thinking)", !/SECRET-THINKING-MUST-NOT-PERSIST/.test(ckEntry?.text ?? ""));
  check("checkpoint records spend + coverage bounds", (ckEntry?.spend ?? []).includes("tCK1") && ckEntry?.coveredTs === 102 && ckEntry?.keepTs === 103);
  await new Promise((r) => setTimeout(r, 100)); // counter is set right after the store append resolves
  check("context counter set after checkpoint (est A→B tok)", statusCalls.some((s) => /ckpt \[\d+\] · est [\d.]+k?→[\d.]+k? tok/.test(s)));
  handlers.message_end[0]({ type: "message_end", message: { role: "assistant", usage: { input: 6100, cacheRead: 200 } } }, ckCtx);
  check("measured prompt size replaces the estimate on next usage", statusCalls.some((s) => /measured 6\.3k tok/.test(s)));
  const statusBeforeDup = statusCalls.filter((s) => /measured/.test(s)).length;
  handlers.message_end[0]({ type: "message_end", message: { role: "assistant", usage: { input: 9, cacheRead: 0 } } }, ckCtx);
  check("measured update happens once per checkpoint", statusCalls.filter((s) => /measured/.test(s)).length === statusBeforeDup);
  check("summary call was capped and used the evidence prompt",
    streamCalls.length === 2 && streamCalls[0].options.maxTokens === 512 && streamCalls[0].options.reasoning === "low" &&
    /Turn evidence/.test(streamCalls[0].context.messages[0].content[0].text));
  check("prefill ran (max_tokens=1) with tools + spliced golden",
    streamCalls[1].options.maxTokens === 1 && streamCalls[1].context.messages[0].toolsAdded?.[0]?.name === "bash" &&
    streamCalls[1].context.messages[0].content.startsWith(`BASE-PROMPT\n<golden>\n${preRender}\n`) &&
    streamCalls[1].context.messages[0].content.includes("checkpoint"));

  // gating: no tool calls in the covered range + policy with-tools -> silent skip
  await new Promise((r) => setTimeout(r, 150)); // let the background run fully finish (incl. prefill)
  const before = streamCalls.length;
  handlers.agent_settled[0]({}, { ...ckCtx, sessionManager: { getBranch: () => [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 500 } },
    { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hello" }], timestamp: 501 } },
  ] } });
  await new Promise((r) => setTimeout(r, 60));
  check("policy with-tools skips pure-text turns", streamCalls.length === before);

  // serialization: session_before_compact waits for an in-flight checkpoint commit
  let slowResolve;
  const slowCalls = [];
  const slowCtx = {
    ...ckCtx,
    ui: { setStatus() {}, notify() {}, setWidget() {} },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
      streamSimple: (model, context, options) => {
        slowCalls.push({ context, options });
        // first call = the evidence summary (held open); later calls (prefill) resolve fast
        if (slowCalls.length === 1) {
          return { result: () => new Promise((resolve) => { slowResolve = () => resolve({ content: [{ type: "text", text: "slow evidence summary" }] }); }) };
        }
        return { result: async () => ({ content: [{ type: "text", text: "warm" }] }) };
      },
    },
    sessionManager: { getBranch: () => [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: 900 } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tSLOW", name: "bash", arguments: { command: "x" } }], timestamp: 901 } },
      { type: "message", message: { role: "toolResult", toolCallId: "tSLOW", toolName: "bash", isError: false, timestamp: 902, content: [{ type: "text", text: "out" }] } },
      { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }], timestamp: 903 } },
    ] },
  };
  handlers.agent_settled[0]({}, slowCtx);
  await new Promise((r) => setTimeout(r, 30)); // let the slow evidence call start
  let compactProceeded = false;
  const compactWait = handlers.session_before_compact[0]({ type: "session_before_compact" }, slowCtx).then(() => { compactProceeded = true; });
  await new Promise((r) => setTimeout(r, 60));
  check("session_before_compact blocks while a checkpoint is in flight", compactProceeded === false);
  slowResolve();
  await compactWait;
  check("session_before_compact proceeds after the checkpoint commit", compactProceeded === true);

  // request inspector: PI_GOLDEN_DUMP records the wire payload without mutating it
  process.env.PI_GOLDEN_DUMP = join(AGENT, "golden-context", "requests.jsonl");
  const dumpPayload = { model: "mock/tinyclip", messages: [{ role: "system", content: "S" }] };
  const hookResult = handlers.before_provider_request[0]({ type: "before_provider_request", payload: dumpPayload });
  check("before_provider_request returns undefined (no mutation)", hookResult === undefined);
  await new Promise((r) => setTimeout(r, 50));
  delete process.env.PI_GOLDEN_DUMP;
  check("PI_GOLDEN_DUMP records the exact payload", (() => {
    try {
      const lines = readFileSync(join(AGENT, "golden-context", "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      return lines.some((l) => l.source === "agent" && JSON.stringify(l.payload) === JSON.stringify(dumpPayload));
    } catch { return false; }
  })());
  check("no dump without PI_GOLDEN_DUMP", (() => {
    const before = (() => { try { return readFileSync(join(AGENT, "golden-context", "requests.jsonl"), "utf8"); } catch { return ""; } })();
    handlers.before_provider_request[0]({ type: "before_provider_request", payload: { x: 1 } });
    return before === (() => { try { return readFileSync(join(AGENT, "golden-context", "requests.jsonl"), "utf8"); } catch { return ""; } })();
  })());

  // ---- takeover: session_before_compact returns OUR compaction (pi's summarizer stays idle) ----
  const takeCalls = [];
  const branchEntries = [
    { id: "e1", type: "message", message: { role: "user", content: [{ type: "text", text: "build it" }], timestamp: 2000 } },
    { id: "e2", type: "message", message: { role: "assistant", content: [
      { type: "thinking", thinking: "run make" },
      { type: "toolCall", id: "tT1", name: "bash", arguments: { command: "make" } } ], timestamp: 2001 } },
    { id: "e3", type: "message", message: { role: "toolResult", toolCallId: "tT1", toolName: "bash", isError: false, timestamp: 2002,
      content: [{ type: "text", text: "BUILD OK ".repeat(100) }] } },
    { id: "e4", type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }], timestamp: 2003 } },
  ];
  const takeCtx = {
    ...ckCtx,
    ui: { setStatus() {}, notify() {}, setWidget() {} },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
      streamSimple: (model, context, options) => {
        takeCalls.push({ context, options });
        return { result: async () => ({ content: [{ type: "text", text: "make succeeded (evidence)." }] }) };
      },
    },
    sessionManager: { getBranch: () => branchEntries },
  };
  const takeover = await handlers.session_before_compact[0]({
    type: "session_before_compact",
    branchEntries,
    preparation: { tokensBefore: 1234 },
  }, takeCtx);
  check("takeover returns a compaction result (pi's summarizer never called)",
    !!takeover?.compaction && takeCalls.length === 1 && takeover.compaction.tokensBefore === 1234);
  check("takeover summary points at golden, keeps only the live reply",
    /golden checkpoint \[\d+\]/i.test(takeover.compaction.summary) && takeover.compaction.firstKeptEntryId === "e4");
  check("evidence call is time-bounded (anti-wedge)", takeCalls[0].options.timeoutMs === 20000 && takeCalls[0].options.maxTokens === 512);
  // nothing new since that commit -> cancel instead of summarizing empty history
  const takeover2 = await handlers.session_before_compact[0]({ type: "session_before_compact", branchEntries, preparation: {} }, takeCtx);
  check("takeover cancels when nothing new is foldable", takeover2?.cancel === true && takeCalls.length === 1);

  // ---- in-flight context-full trigger: folds BEFORE the request goes out ----
  const inflightCtx = {
    ...takeCtx,
    model: { id: "tinyclip", provider: "mock", contextWindow: 1000 },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
      streamSimple: (model, context, options) => ({ result: async () => ({ content: [{ type: "text", text: "in-flight evidence" }] }) }),
    },
    sessionManager: { getBranch: () => branchEntries },
  };
  const bigMsgs = [
    { role: "user", content: [{ type: "text", text: "go" }], timestamp: 3000 },
    { role: "assistant", content: [
      { type: "thinking", thinking: "t".repeat(2000) },
      { type: "toolCall", id: "tF1", name: "bash", arguments: { command: "x" } } ], timestamp: 3001 },
    { role: "toolResult", toolCallId: "tF1", toolName: "bash", isError: false, timestamp: 3002, content: [{ type: "text", text: "y".repeat(4000) }] },
    { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "tF2", name: "bash", arguments: { command: "z" } }], timestamp: 3003 },
  ];
  const beforeInflight = (() => { try { return readFileSync(storePath, "utf8").trim().split("\n").length; } catch { return 0; } })();
  // KV-anchored triggers: seed the anchor as "measured near-full" so the in-flight
  // decision comes from the measured prompt (findings §14), not raw-history chars/4.
  handlers.message_end[0]({ type: "message_end", message: { role: "assistant", timestamp: 2500, usage: { input: 900, cacheRead: 0, cacheWrite: 0 } } }, inflightCtx);
  const evResult = await handlers.context[0]({ type: "context", messages: bigMsgs }, inflightCtx);
  await new Promise((r) => setTimeout(r, 80));
  const afterInflight = readFileSync(storePath, "utf8").trim().split("\n").length;
  check("in-flight trigger commits a checkpoint mid-run (toolUse turn OK)", afterInflight === beforeInflight + 1);
  check("in-flight trigger purges THIS request (handles on the wire)",
    evResult?.messages?.some((m) => m.role === "toolResult" && String(m.content?.[0]?.text).startsWith("[golden]")) === true);
  // under the threshold -> no trigger, and the fallback fire-and-forget never fires from here
  const quietCtx = { ...inflightCtx, model: { id: "tinyclip", provider: "mock", contextWindow: 100000 } };
  const beforeQuiet = readFileSync(storePath, "utf8").trim().split("\n").length;
  await handlers.context[0]({ type: "context", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 4000 }] }, quietCtx);
  await new Promise((r) => setTimeout(r, 60));
  check("no in-flight trigger below contextFullPct", readFileSync(storePath, "utf8").trim().split("\n").length === beforeQuiet);

  // ---- findings §14: triggers size from the KV-anchored measurement, not chat history ----
  const storeLines = () => readFileSync(storePath, "utf8").trim().split("\n").length;

  // low anchor: measured prompt = 5000 tokens at ts 900000
  handlers.message_end[0]({ type: "message_end", message: { role: "assistant", timestamp: 900000, usage: { input: 4000, cacheRead: 1000, cacheWrite: 0 } } }, takeCtx);

  const gateCtx = { ...takeCtx, model: { id: "tinyclip", provider: "mock", contextWindow: 100000 } };
  // fresh foldable material (ts > current floor 3003, savings > 512) — without the gate,
  // a threshold trigger here would COMMIT; with the gate it must cancel untouched.
  const freshEntries = [
    { id: "f1", type: "message", message: { role: "user", content: [{ type: "text", text: "again" }], timestamp: 5000 } },
    { id: "f2", type: "message", message: { role: "assistant", content: [
      { type: "thinking", thinking: "t".repeat(1000) },
      { type: "toolCall", id: "tG1", name: "bash", arguments: { command: "x" } } ], timestamp: 5001 } },
    { id: "f3", type: "message", message: { role: "toolResult", toolCallId: "tG1", toolName: "bash", isError: false, timestamp: 5002,
      content: [{ type: "text", text: "RESULT ".repeat(200) }] } },
    { id: "f4", type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done again." }], timestamp: 5003 } },
  ];

  const nCallsBeforeThreshold = takeCalls.length;
  const nStoreBeforeThreshold = storeLines();
  const thr = await handlers.session_before_compact[0]({
    type: "session_before_compact", reason: "threshold", branchEntries: freshEntries, preparation: { tokensBefore: 90000 },
  }, gateCtx);
  await new Promise((r) => setTimeout(r, 60));
  check("pi threshold trigger is CANCELLED when KV-anchored size is low (no evidence call)",
    thr?.cancel === true && takeCalls.length === nCallsBeforeThreshold && storeLines() === nStoreBeforeThreshold);

  // manual /compact must still run even below the threshold (real user intent)
  const man = await handlers.session_before_compact[0]({
    type: "session_before_compact", reason: "manual", branchEntries: freshEntries, preparation: { tokensBefore: 90000 },
  }, gateCtx);
  check("manual /compact proceeds below the threshold (force)",
    !!man?.compaction && takeCalls.length === nCallsBeforeThreshold + 1 && man.compaction.firstKeptEntryId === "f4");

  // same KV anchor: raw history blows past the window (the old chars/4 bug) — must NOT fold
  const nStoreBeforeSupp = storeLines();
  const nCallsBeforeSupp = takeCalls.length;
  const supp = await handlers.context[0]({ type: "context", messages: [
    { role: "toolResult", toolCallId: "old1", toolName: "bash", isError: false, timestamp: 500000, content: [{ type: "text", text: "z".repeat(400000) }] },
    { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 900001 },
  ] }, gateCtx);
  await new Promise((r) => setTimeout(r, 60));
  check("in-flight suppressed: 400k chars of already-measured history is not \"full\"",
    supp === undefined && storeLines() === nStoreBeforeSupp && takeCalls.length === nCallsBeforeSupp);

  // high anchor (measured 85k of a 100k window) -> in-flight must fold
  handlers.message_end[0]({ type: "message_end", message: { role: "assistant", timestamp: 960000, usage: { input: 85000, cacheRead: 0, cacheWrite: 0 } } }, gateCtx);
  const nStoreBeforeHot = storeLines();
  const hot = await handlers.context[0]({ type: "context", messages: [
    { role: "user", content: [{ type: "text", text: "go" }], timestamp: 960001 },
    { role: "assistant", content: [
      { type: "thinking", thinking: "h".repeat(600) },
      { type: "toolCall", id: "tH1", name: "bash", arguments: { command: "q" } } ], timestamp: 960002 },
    { role: "toolResult", toolCallId: "tH1", toolName: "bash", isError: false, timestamp: 960003, content: [{ type: "text", text: "OUT ".repeat(400) }] },
    { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "tH2", name: "bash", arguments: { command: "w" } }], timestamp: 960004 },
  ] }, gateCtx);
  await new Promise((r) => setTimeout(r, 60));
  check("in-flight fires when the MEASURED prompt is actually near-full",
    storeLines() === nStoreBeforeHot + 1 && hot?.messages?.some((m) => m.role === "toolResult" && String(m.content?.[0]?.text).startsWith("[golden]")) === true);

  // ---- SCOPE ISOLATION (the reported bug): another directory must start with a FRESH golden ----
  {
    const { existsSync, readFileSync } = require("node:fs");
    const OTHER_CWD = "/golden-other-project";
    const OTHER_STORE = join(AGENT, "golden-context", core.encodeCwdScope(OTHER_CWD), "golden.jsonl");
    const fixtureLinesBefore = storeLines();

    await handlers.session_start[0]({}, { cwd: OTHER_CWD });
    const evFresh = { systemPromptOptions: { sections: {} } };
    handlers.before_agent_start[0](evFresh, { cwd: OTHER_CWD });
    check("new directory renders NO golden from the other project",
      !String(evFresh.systemPromptOptions.sections.golden ?? "").includes("lower ctx to free VRAM"));

    await registeredTools.commit_decision.execute(
      "tcOTHER", { decision: "record", text: "UNIQUE-OTHER-PROJECT-DECISION", spendToolCallIds: [] },
      undefined, undefined, { cwd: OTHER_CWD });
    check("commit in the other scope writes ONLY its own store",
      existsSync(OTHER_STORE) && readFileSync(OTHER_STORE, "utf8").includes("UNIQUE-OTHER-PROJECT-DECISION"));
    check("the original scope's store is untouched by the other project",
      storeLines() === fixtureLinesBefore && !readFileSync(storePath, "utf8").includes("UNIQUE-OTHER-PROJECT-DECISION"));
    check("scoped stores are siblings under the agent dir, each in its own scope dir",
      OTHER_STORE !== storePath
        && OTHER_STORE.startsWith(join(AGENT, "golden-context") + "/")
        && OTHER_STORE.includes(core.encodeCwdScope(OTHER_CWD))
        && storePath.includes(core.encodeCwdScope(FIXTURE_CWD)));

    await handlers.session_start[0]({}, { cwd: FIXTURE_CWD });
    const evBack = { systemPromptOptions: { sections: {} } };
    handlers.before_agent_start[0](evBack, { cwd: FIXTURE_CWD });
    check("returning to the original directory restores ITS golden",
      String(evBack.systemPromptOptions.sections.golden ?? "").includes("lower ctx to free VRAM"));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
