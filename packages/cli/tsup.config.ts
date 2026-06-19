/**
 * Single-sources the CLI version from package.json at build time (s0o7): the
 * shipped binary reports the REAL `@birdybeep/cli` version it was built at, so
 * `--version` and the `cli_version` sent on `/pair/start` (→ the mobile approval
 * sheet's machine identity) are accurate — never a hardcoded placeholder. When
 * Changesets bumps package.json, the next build picks it up automatically.
 *
 * The version is injected via esbuild `define` as the global `__CLI_VERSION__`,
 * which `src/version.ts` reads (with a "0.0.0" dev/test fallback). Reading
 * package.json here — in the build script, not in `src/` — keeps it outside the
 * compiler `rootDir`, so `tsc` typecheck + `.dts` generation stay clean.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsup";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as { version: string };

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Compile-time replacement: every bare `__CLI_VERSION__` becomes the literal.
  define: { __CLI_VERSION__: JSON.stringify(pkg.version) },
});
