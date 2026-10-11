// Stub for "@earendil-works/pi-coding-agent" used ONLY by the isolated offline test.
// It provides just the two runtime values golden-context.ts imports; type-only imports are
// erased by jiti so they need no stub. getAgentDir is pointed at a temp dir by the runner
// via PI_GOLDEN_TEST_AGENTDIR so tests never touch the user's real ~/.pi/agent.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let cached;
export function getAgentDir() {
  if (process.env.PI_GOLDEN_TEST_AGENTDIR) return process.env.PI_GOLDEN_TEST_AGENTDIR;
  if (!cached) cached = mkdtempSync(join(tmpdir(), "pi-golden-test-"));
  return cached;
}

// Real pi uses a per-path mutex; tests are single-threaded, so a simple passthrough is fine.
export async function withFileMutationQueue(_path, fn) {
  return fn();
}

// The adapter builds its live message list through pi's compaction-aware helper; the stub
// flattens message entries (tests carry no compaction entries).
export function buildSessionContext(entries) {
  return {
    messages: (entries ?? [])
      .filter((e) => e && e.type === "message" && e.message)
      .map((e) => e.message),
  };
}
