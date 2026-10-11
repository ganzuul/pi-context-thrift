// mock-backend.mjs — a dependency-free OpenAI-compatible backend for testing pi + golden-context
// with NO GPU and NO shared llama-swap model.
//
// It exists to answer two questions that were impossible to answer on the live stack:
//   1. Does pi really offer our `commit_decision` tool, and does the extension load in real pi?
//   2. Does pi's own small-context-window / compaction behavior hang — independent of any plugin?
//
// It mimics beellama/Strata accounting honestly: prompt_tokens is derived from the actual
// serialized payload, and cached_tokens = the previous turn's prompt_tokens (automatic prefix
// cache reuse over a stable leading prefix), so pi's usage-backed compaction math sees real numbers.
//
//   node mock-backend.mjs [--port 18099] [--turns-before-toolcall 1] [--hang-at-tokens N]
//
// Env:
//   MOCK_LOG      file to append one JSON line per request (default /tmp/pi-mock-requests.jsonl)
//   MOCK_HANG_AT  if set and prompt_tokens > it, the server NEVER finishes the response
//                 (simulates an engine with no free KV: reproduces the "1 token + length" stall)
//   MOCK_TOOLCALL turn index (1-based) at which the model emits a commit_decision tool call; -1 = never
//
// Every request is dumped with: tools[] names, prompt_tokens, cached_tokens, and a leading-byte
// hash so prefix stability across turns can be diffed (Gate A on genuine pi payloads).
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const PORT = Number(arg("port", 18099));
const LOG = process.env.MOCK_LOG || "/tmp/pi-mock-requests.jsonl";
const HANG_AT = process.env.MOCK_HANG_AT ? Number(process.env.MOCK_HANG_AT) : null;
const TOOLCALL_TURN = Number(arg("toolcall", 2));
// MOCK_FULL=1 dumps each request's complete body (system prompt text, tools[], messages[]) so the
// Gate-A prefix-stability question can be diffed byte-wise on genuine pi payloads.
const FULL = process.env.MOCK_FULL ? (process.env.MOCK_FULL_LOG || "/tmp/pi-mock-full.jsonl") : null;
if (FULL) writeFileSync(FULL, "", "utf8");
// --loopcalls K: emit a trivial `bash` tool call for the first K turns so pi's agent loop keeps
// going and the context actually grows toward pi's compaction threshold (GPU-free repro of the
// small-window path). After K turns the model returns a normal text reply, ending the loop.
const LOOPCALLS = Number(arg("loopcalls", 0));
const BIGCH = Number(arg("bigoutput", 30000));
const bashCall = (n) => JSON.stringify({ command: `python3 -c "print('x'*${BIGCH})"  # round ${n}` });

writeFileSync(LOG, "", "utf8");
let turn = 0;
let lastPromptTokens = 0;

// ~4 chars/token heuristic; good enough to make pi's compaction thresholds behave like real usage.
const estTokens = (s) => Math.ceil(String(s).length / 4);

const FILLER = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ".repeat(40);

function sse(res, str) {
  res.write(`data: ${str}\n\n`);
}

function chunk(obj) {
  return JSON.stringify({
    id: `chatcmpl-mock-${turn}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "tinyclip",
    ...obj,
  });
}

const server = createServer((req, res) => {
  const url = req.url || "/";
  if (req.method === "GET" && (url.startsWith("/v1/models") || url === "/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [{ id: "tinyclip", object: "model", owned_by: "mock", status: { value: "loaded" } }],
    }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(404).end("nope");
    return;
  }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    let j;
    try {
      j = JSON.parse(body || "{}");
    } catch {
      res.writeHead(400).end("bad json");
      return;
    }
    turn += 1;
    const messages = Array.isArray(j.messages) ? j.messages : [];
    // The compaction SUMMARIZATION request is a separate call shape (pi's summarizer
    // system prompt + a single <conversation> blob). pi serializes system prompts as
    // role "developer" on this API, so match on content, not on role.
    // MOCK_HANG_SUMMARY=1 stalls exactly that request -> reproduces the
    // "compaction in flight forever" wedge without touching normal agent turns.
    const wire = JSON.stringify(messages);
    const isSummary = /context summarization assistant|<previous-summary>|<conversation>/.test(wire);
    const isEvidence = /empirical evidence against the assistant's thinking trace/.test(wire);
    // The "leading prefix" pi sends: system message + tool definitions, in wire order.
    const prefix = JSON.stringify(messages[0] ?? "") + JSON.stringify(j.tools ?? []);
    const promptTokens = estTokens(JSON.stringify(messages)) + estTokens(JSON.stringify(j.tools ?? []));
    const rec = {
      turn,
      stream: j.stream,
      max_tokens: j.max_tokens ?? j.max_completion_tokens ?? null,
      model: j.model,
      summary: isSummary,
      evidence: isEvidence,
      tools: (j.tools || []).map((t) => t.function?.name ?? t.name).sort(),
      msgCount: messages.length,
      roles: messages.map((m) => m.role).join(","),
      prompt_tokens: promptTokens,
      cached_tokens: lastPromptTokens,
      prefixBytes: Buffer.byteLength(prefix),
      // Count golden-context ejection handles ON THE WIRE: proves the `context` hook actually
      // rewrote spent tool results before pi serialized the request (0 = nothing was ejected).
      handles: JSON.stringify(messages).split("[golden]").length - 1,
      prefixHash: createHash("sha256").update(prefix).digest("hex").slice(0, 16),
      fullHash: createHash("sha256").update(JSON.stringify(messages) + JSON.stringify(j.tools ?? [])).digest("hex").slice(0, 16),
    };
    appendFileSync(LOG, JSON.stringify(rec) + "\n", "utf8");
    if (FULL) appendFileSync(FULL, JSON.stringify({ turn, body: j }) + "\n", "utf8");
    lastPromptTokens = promptTokens;

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    // Deliberate stall: an engine that has no room left never emits finish_reason.
    if (HANG_AT !== null && promptTokens > HANG_AT) {
      sse(res, chunk({ choices: [{ index: 0, delta: { reasoning_content: "The" }, finish_reason: null }] }));
      return; // never end the response -> client hangs
    }

    // Targeted stall: the compaction summary request never completes (MOCK_HANG_SUMMARY=1).
    // pi's `compact()` awaits this call with no timeout -> isCompacting stays true forever.
    if (process.env.MOCK_HANG_SUMMARY && isSummary) {
      sse(res, chunk({ choices: [{ index: 0, delta: { content: "The conversation history before this point" }, finish_reason: null }] }));
      return; // never end the response -> compaction wedges in flight
    }

    // golden-context's evidence-summary call (idle checkpointing). Answer like the real
    // spec: a SHORT summary (target ~128 tok, cap 512), separate from the FILLER replies.
    if (isEvidence) {
      const text = "MOCK-EVIDENCE: tool outputs confirm the stated plan; no contradictions with the thinking trace. Durable facts: build passes; tests green.";
      sse(res, chunk({ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "weighing outputs vs claims" }, finish_reason: null }] }));
      sse(res, chunk({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }));
      sse(res, chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
      sse(res, chunk({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: estTokens(text), total_tokens: promptTokens + estTokens(text), prompt_tokens_details: { cached_tokens: rec.cached_tokens } } }));
      sse(res, "[DONE]");
      res.end();
      return;
    }

    // Honest truncation: an engine asked for ~1 token can only emit ~1 token, and reports
    // finish_reason "length" — which is exactly the last entry of the real hung pi session
    // (out=1, thinking "The", stopReason=length). Without this, the mock would hide the spiral.
    if (rec.max_tokens !== null && rec.max_tokens <= 8) {
      sse(res, chunk({ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "The" }, finish_reason: null }] }));
      sse(res, chunk({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }));
      sse(res, chunk({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1, prompt_tokens_details: { cached_tokens: rec.cached_tokens } } }));
      sse(res, "[DONE]");
      res.end();
      return;
    }

    // Declared first: `wantsBash` defers to it (a commit turn must not be consumed by the loop).
    const wantsTool = TOOLCALL_TURN > 0 && turn === TOOLCALL_TURN && rec.tools.includes("commit_decision");
    const wantsBash = !wantsTool && LOOPCALLS > 0 && turn <= LOOPCALLS && rec.tools.includes("bash");
    if (wantsBash) {
      sse(res, chunk({ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: `planning round ${turn}.` }, finish_reason: null }] }));
      sse(res, chunk({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: `call_mock_bash_${turn}`, type: "function", function: { name: "bash", arguments: bashCall(turn) } }] },
          finish_reason: null,
        }],
      }));
      sse(res, chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
      sse(res, chunk({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 18, total_tokens: promptTokens + 18, prompt_tokens_details: { cached_tokens: rec.cached_tokens } } }));
      sse(res, "[DONE]");
      res.end();
      return;
    }

    if (wantsTool) {
      // Spend the most recent real tool call id in the transcript, so golden-context's `context`
      // hook has something to actually eject on the NEXT request (the DISTILL path).
      const ids = [];
      for (const m of messages) {
        if (m?.role === "assistant" && Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) if (tc?.id) ids.push(tc.id);
        }
      }
      sse(res, chunk({ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "I should commit a decision." }, finish_reason: null }] }));
      const args = JSON.stringify({
        decision: "distill",
        text: "Mock hindsight line for offline verification of DISTILL ejection.",
        spendToolCallIds: ids,
      });
      sse(res, chunk({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name: "commit_decision", arguments: args } }] },
          finish_reason: null,
        }],
      }));
      sse(res, chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
      sse(res, chunk({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 42, total_tokens: promptTokens + 42, prompt_tokens_details: { cached_tokens: rec.cached_tokens } } }));
      sse(res, "[DONE]");
      res.end();
      return;
    }

    const text = `mock reply #${turn}. ${FILLER}`;
    sse(res, chunk({ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: `thinking ${turn}.` }, finish_reason: null }] }));
    sse(res, chunk({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }));
    sse(res, chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
    sse(res, chunk({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: estTokens(text), total_tokens: promptTokens + estTokens(text), prompt_tokens_details: { cached_tokens: rec.cached_tokens } } }));
    sse(res, "[DONE]");
    res.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock backend on http://127.0.0.1:${PORT}/v1  (log=${LOG}, hangAt=${HANG_AT}, toolcallTurn=${TOOLCALL_TURN})`);
});
