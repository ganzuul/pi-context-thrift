// Resolve pi's install dir without hardcoding a machine path.
// Order: PI_DIR env -> the `pi` executable on PATH (realpath contains the package dir)
//        -> `npm root -g` -> give up with a clear error.
import { execSync } from "node:child_process";
import { realpathSync, existsSync } from "node:fs";
import { join } from "node:path";

const PKG = "node_modules/@earendil-works/pi-coding-agent";

export function resolvePiDir() {
  if (process.env.PI_DIR) return process.env.PI_DIR;
  try {
    const real = realpathSync(execSync("command -v pi", { encoding: "utf8" }).trim());
    const idx = real.indexOf(PKG);
    if (idx !== -1) {
      const dir = real.slice(0, idx + PKG.length);
      if (existsSync(join(dir, "package.json"))) return dir;
    }
  } catch { /* pi not on PATH */ }
  try {
    const dir = join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
    if (existsSync(join(dir, "package.json"))) return dir;
  } catch { /* npm missing */ }
  console.error("error: cannot locate @earendil-works/pi-coding-agent — set PI_DIR=<path to pi install>");
  process.exit(1);
}
