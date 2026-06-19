/**
 * CLI version — single-sourced from package.json at build time (s0o7). `tsup.config.ts`
 * injects the real `@birdybeep/cli` version via the `__CLI_VERSION__` esbuild define, so
 * the shipped binary reports its true version for `--version` and the `cli_version` it
 * sends on `/pair/start` (the mobile approval sheet's machine identity). The `0.0.0`
 * fallback only applies to non-bundled runs (vitest / tsx), where the define is absent.
 */

/** Build-time-replaced global; declared so source typechecks before tsup substitutes it. */
declare const __CLI_VERSION__: string | undefined;

export const CLI_VERSION: string =
  typeof __CLI_VERSION__ === "string" && __CLI_VERSION__.length > 0 ? __CLI_VERSION__ : "0.0.0";
