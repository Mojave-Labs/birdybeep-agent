import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rootPackage = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
};
const installedCli = JSON.parse(
  readFileSync(join(REPO_ROOT, "node_modules", "@changesets", "cli", "package.json"), "utf8"),
) as { version?: string };
const releaseWorkflow = readFileSync(
  join(REPO_ROOT, ".github", "workflows", "release.yml"),
  "utf8",
);

describe("Changesets release workflow compatibility (gcgp.32)", () => {
  it("installs Changesets CLI v3", () => {
    expect(rootPackage.devDependencies?.["@changesets/cli"]).toMatch(/^\^?3\./);
    expect(rootPackage.engines?.node).toBe(">=22.11.0");
    expect(installedCli.version).toMatch(/^3\./);
  });

  it("uses the v2 action API with an immutable pin", () => {
    const action = /uses:\s*changesets\/action@([0-9a-f]{40})\s+#\s+v(\d+)\./.exec(releaseWorkflow);
    expect(action?.[1]).toHaveLength(40);
    expect(Number(action?.[2])).toBeGreaterThanOrEqual(2);
    expect(releaseWorkflow).toMatch(/^\s+publish-script:\s+pnpm release:ci\s*$/m);
    expect(releaseWorkflow).not.toMatch(/^\s+(?:publish|version):\s+/m);
  });
});
