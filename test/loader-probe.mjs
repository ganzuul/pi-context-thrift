// loader-probe.mjs — decisive, model-free test of the DISPUTED claim:
// does pi's REAL loader accept the golden-context extension from a *user* dir?
//
// It calls pi's own discoverAndLoadExtensions (same code path pi uses at startup),
// pointing the agent dir at the sandbox. No TUI, no model call, no npm install.
//
//   node loader-probe.mjs <agentDirWithExtensions>
//
// Exit 0 = golden-context loaded with no error; exit 1 = it did not (errors printed).
import { pathToFileURL } from "node:url";

// pi's install dir: PI_DIR env -> `pi` on PATH -> `npm root -g` (see _pi-dir.mjs)
const { resolvePiDir } = await import("./_pi-dir.mjs");
const PI = resolvePiDir();
const agentDir = process.argv[2] || process.env.PI_CODING_AGENT_DIR || "/tmp/pi-golden-sandbox";

const loader = await import(pathToFileURL(`${PI}/dist/core/extensions/loader.js`).href);

let res;
try {
  // (configuredPaths, cwd, agentDir) — discovers <agentDir>/extensions + <agentDir>/extensions/*/index.ts
  res = await loader.discoverAndLoadExtensions([], process.cwd(), agentDir);
} catch (err) {
  console.log("PROBE THREW:", err && err.stack ? err.stack : String(err));
  process.exit(1);
}

const loaded = (res.extensions || []).map((e) => e.path);
const errors = res.errors || [];
console.log(`agentDir = ${agentDir}`);
console.log(`loaded   = ${loaded.length ? JSON.stringify(loaded) : "(none)"}`);
if (errors.length) {
  console.log(`errors   = ${errors.length}`);
  for (const e of errors) console.log("  -", e.path, "\n    ", e.error);
}
const golden = loaded.find((p) => p.includes("golden-context"));
if (golden && errors.length === 0) {
  console.log("LOADER: PASS — golden-context loaded via pi's real jiti loader (user dir)");
  process.exit(0);
}
console.log(errors.length ? "LOADER: FAIL — extension-load error(s) above" : "LOADER: NOT LOADED — golden-context absent");
process.exit(1);
