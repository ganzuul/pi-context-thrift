#!/usr/bin/env node
// replay.mjs — drive a REAL pi process over its JSONL RPC protocol and probe what still
// works after compaction. This is the reproducible experiment for the report
// "when compaction triggers, some of pi's essential features become unresponsive".
//
// Protocol: `pi --mode rpc` reads JSON commands on stdin, emits `{type:"response",id,...}`
// for commands and event objects (`agent_end`, `compaction_start`, `ui_request`, ...) on
// stdout. Every line is archived so a wedged run can be diagnosed after the fact.
//
//   node replay.mjs --session <session.jsonl> --out <dir> [--model mock/tinyclip]
//                   [--prompts N] [--compact-timeout ms] [--step-timeout ms]
//
// Steps (each individually timed out — a wedged step does NOT stop the probe run,
// because "which features stay responsive during the wedge" is exactly the question):
//   state0 -> model -> prompt*N -> compact -> state1 -> cmd(golden-status) ->
//   cmd(golden-eject) -> export -> commands -> state2
//
// Exit code: 0 when compact + export both answered, 1 otherwise.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

// ---- args ----
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const SESSION = arg("session", "");
const OUT = arg("out", "/tmp/pi-replay-out");
const MODEL = arg("model", "mock/tinyclip");
const PROMPTS = Number(arg("prompts", "0"));
const COMPACT_TIMEOUT = Number(arg("compact-timeout", "20000"));
const STEP_TIMEOUT = Number(arg("step-timeout", "15000"));
const SETTLE_MS = Number(arg("settle-ms", "0"));
const GAP_MS = Number(arg("gap-ms", "0"));
if (!SESSION) { console.error("usage: replay.mjs --session <file> [--out dir]"); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const EVENTS_LOG = join(OUT, "events.jsonl");
const REPORT_JSON = join(OUT, "report.json");
writeFileSync(EVENTS_LOG, "", "utf8");

// ---- spawn pi in RPC mode ----
const pi = spawn("pi", ["--mode", "rpc", "--session", SESSION, "--model", MODEL, "--approve", "--offline"], {
  env: { ...process.env },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderrTail = "";
pi.stderr.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-4000); });

// ---- JSONL correlation ----
let nextId = 1;
const pending = new Map(); // id -> {resolve, timer, label}
const eventWaiters = [];   // {test, resolve, timer}
const notices = [];        // extension ui.notify texts (our /golden-* commands report here)

function onLine(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  appendFileSync(EVENTS_LOG, line + "\n", "utf8");
  if (obj.method === "notify") notices.push(String(obj.message ?? ""));
  if (obj.type === "response" && obj.id !== undefined && pending.has(obj.id)) {
    const p = pending.get(obj.id);
    pending.delete(obj.id);
    clearTimeout(p.timer);
    p.resolve(obj);
    return;
  }
  for (let i = eventWaiters.length - 1; i >= 0; i--) {
    if (eventWaiters[i].test(obj)) {
      const w = eventWaiters.splice(i, 1)[0];
      clearTimeout(w.timer);
      w.resolve(obj);
    }
  }
}
createInterface({ input: pi.stdout }).on("line", onLine);

function send(cmd, timeoutMs, label) {
  const id = nextId++;
  const payload = JSON.stringify({ id, ...cmd }) + "\n";
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ id, type: "response", command: cmd.type, success: false, error: `TIMEOUT after ${timeoutMs}ms` });
    }, timeoutMs);
    pending.set(id, { resolve, timer, label });
    pi.stdin.write(payload);
  });
}

function waitEvent(test, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const i = eventWaiters.findIndex((w) => w.resolve === wrapped);
      if (i >= 0) eventWaiters.splice(i, 1);
      resolve(null);
    }, timeoutMs);
    const wrapped = (obj) => resolve(obj);
    eventWaiters.push({ test, resolve: wrapped, timer });
  });
}

// ---- step bookkeeping ----
const steps = [];
function record(step, status, ms, note) {
  steps.push({ step, status, ms, note });
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad(step, 22)} ${pad(status, 8)} ${pad(ms + "ms", 9)} ${note ?? ""}`);
}
async function timed(name, fn, timeoutMs) {
  const t0 = Date.now();
  let status = "ok", note = "";
  try {
    const noteOr = await fn();
    note = noteOr ?? "";
  } catch (e) {
    status = "error"; note = e?.message ?? String(e);
  }
  const ms = Date.now() - t0;
  if (status === "ok" && ms > timeoutMs) { status = "timeout"; note = `exceeded ${timeoutMs}ms`; }
  record(name, status, ms, note);
  return status;
}

// probe helper: runs a command and characterizes the response
function probe(cmd, timeoutMs) {
  return async () => {
    const r = await send(cmd, timeoutMs, cmd.type);
    if (r.error && /TIMEOUT/.test(r.error)) throw new Error(r.error);
    if (r.success === false) throw new Error(r.error ?? "failed");
    return summarize(cmd.type, r.data);
  };
}
function summarize(type, data) {
  if (type === "get_state") return `isStreaming=${data.isStreaming} isCompacting=${data.isCompacting} msgs=${data.messageCount} pending=${data.pendingMessageCount} file=${data.sessionFile ? "yes" : "NO"}`;
  if (type === "compact") return `tokensBefore=${data.tokensBefore} estimatedAfter=${data.estimatedTokensAfter}`;
  if (type === "export_html") return `path=${data.path}`;
  if (type === "get_commands") {
    const names = (data.commands ?? []).map((c) => c.name ?? c).join(",");
    return `commands=[${names}]`;
  }
  return JSON.stringify(data ?? {}).slice(0, 160);
}

// ---- the experiment ----
console.log(`replaying ${SESSION}`);
console.log(`out dir   ${OUT}\n`);

const t0 = Date.now();
await timed("state0", probe({ type: "get_state" }, STEP_TIMEOUT), STEP_TIMEOUT);
await timed("set_model", probe({ type: "set_model", provider: MODEL.split("/")[0], modelId: MODEL.split("/").slice(1).join("/") }, STEP_TIMEOUT), STEP_TIMEOUT);

// Which extension commands exist decides whether the /golden-* probes are meaningful
// (without the extension they fall through to the model as ordinary prompts).
let hasGoldenCommands = false;
await timed("commands", async () => {
  const r = await send({ type: "get_commands" }, STEP_TIMEOUT, "get_commands");
  if (r.success === false) throw new Error(r.error ?? "failed");
  const names = (r.data?.commands ?? []).map((c) => c.name ?? String(c));
  hasGoldenCommands = names.includes("golden-status");
  return `commands=[${names.join(",")}]`;
}, STEP_TIMEOUT);

for (let i = 1; i <= PROMPTS; i++) {
  await timed(`prompt-${i}`, async () => {
    const r = await send({ type: "prompt", message: `replay warmup ${i}` }, STEP_TIMEOUT, "prompt");
    if (r.success === false) throw new Error(r.error ?? "prompt failed");
    const settled = await waitEvent((e) => e.type === "agent_settled", STEP_TIMEOUT);
    return settled ? "agent settled" : "NO agent_settled event";
  }, STEP_TIMEOUT);
  // gap between prompts: let the background checkpoint + prefill finish so the NEXT
  // request can be compared against the prefill's bytes (byte-exactness check)
  if (GAP_MS > 0 && i < PROMPTS) await new Promise((r) => setTimeout(r, GAP_MS));
}

// Let background work (idle checkpointing: evidence summary + prefill) finish before
// probing — the checkpoint is deliberately fire-and-forget from agent_settled.
if (SETTLE_MS > 0) await timed("settle", async () => { await new Promise((r) => setTimeout(r, SETTLE_MS)); return `waited ${SETTLE_MS}ms`; }, STEP_TIMEOUT);

const compactStatus = await timed("compact", probe({ type: "compact" }, COMPACT_TIMEOUT), COMPACT_TIMEOUT);
await timed("state1", probe({ type: "get_state" }, STEP_TIMEOUT), STEP_TIMEOUT);
// The discrete-command seam: extension commands execute even while compaction is in
// flight (pi routes them before the isCompacting queue). If THESE answer while
// `compact` is wedged, the process is alive and only the compaction path is stuck.
for (const cmd of ["/golden-status", "/golden-eject"]) {
  if (!hasGoldenCommands) { record(`cmd ${cmd.slice(1)}`, "skipped", 0, "extension commands not registered"); continue; }
  await timed(`cmd ${cmd.slice(1)}`, async () => {
    const before = notices.length;
    const r = await send({ type: "prompt", message: cmd }, STEP_TIMEOUT, "prompt");
    if (r.success === false) throw new Error(r.error ?? "command failed");
    const said = notices.slice(before).join(" | ").replace(/\s+/g, " ").slice(0, 220);
    return said || "(no notify output)";
  }, STEP_TIMEOUT);
}

const exportStatus = await timed("export", probe({ type: "export_html", outputPath: join(OUT, "replay-export.html") }, STEP_TIMEOUT), STEP_TIMEOUT);
await timed("state2", probe({ type: "get_state" }, STEP_TIMEOUT), STEP_TIMEOUT);

// ---- wrap up ----
try { pi.kill("SIGKILL"); } catch { /* already gone */ }

const report = {
  session: SESSION,
  model: MODEL,
  elapsedMs: Date.now() - t0,
  compact: compactStatus,
  export: exportStatus,
  steps,
};
writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
console.log(`\nreport: ${REPORT_JSON}`);
console.log(`verdict: compact=${compactStatus} export=${exportStatus}`);
process.exit(compactStatus === "ok" && exportStatus === "ok" ? 0 : 1);
