// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tseslint from "typescript-eslint";

/**
 * Shared ESLint flat config for every birdybeep-agent workspace.
 *
 * It is a FACTORY because typed linting needs to know which workspace a file
 * belongs to: each workspace's `eslint.config.js` calls this with its own
 * `import.meta.dirname` so `projectService` resolves that package's tsconfig.
 *
 * Layering: base JS rules → typescript-eslint type-checked rules (incl.
 * no-floating-promises, which matters for the non-blocking hook path) + import
 * sorting on TS sources → type-aware linting disabled on plain JS config files
 * → eslint-config-prettier last so Prettier owns formatting and the two never
 * fight. Mirrors the private product repo's @birdybeep/config eslint.base.
 *
 * @param {string} tsconfigRootDir Absolute dir of the consuming workspace.
 */
export default function birdybeepConfig(tsconfigRootDir) {
  return defineConfig(
    { ignores: ["**/dist/**", "**/.turbo/**", "**/node_modules/**"] },
    {
      files: ["**/*.{ts,tsx}"],
      extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: {
          // `allowDefaultProject` lets typed linting cover root-level TS config files
          // (e.g. `tsup.config.ts`) that intentionally sit outside `src` / the package
          // tsconfig `include`. No `**` allowed; the file must not also be in a tsconfig.
          projectService: { allowDefaultProject: ["*.config.ts"] },
          tsconfigRootDir,
        },
      },
      plugins: {
        "simple-import-sort": simpleImportSort,
      },
      rules: {
        "simple-import-sort/imports": "error",
        "simple-import-sort/exports": "error",
      },
    },
    {
      // Plain JS (eslint/prettier config files, etc.) — no type information.
      files: ["**/*.{js,cjs,mjs}"],
      extends: [js.configs.recommended, tseslint.configs.disableTypeChecked],
    },
    // Must be last: disables every stylistic rule that would conflict with Prettier.
    eslintConfigPrettier,
  );
}
