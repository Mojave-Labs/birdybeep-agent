/**
 * @birdybeep/cli — library entry. Re-exports the side-effect-free CLI API so the
 * package ships a real `.d.ts` and is importable for testing/embedding. The
 * executable lives in `bin.ts` (the only module with a shebang + `process` side
 * effects); keeping it separate stops the shebang from leaking into this entry's
 * type declarations.
 */
export * from "./cli.js";
