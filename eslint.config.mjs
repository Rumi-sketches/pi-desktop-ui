// Minimal lint gate: ESLint recommended rules only, on the server-side sources
// and on the browser source of the page (public/app.js).
// Deliberately no stylistic rules and no formatter — see CONTRIBUTING.md.
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/", "backup/", "docs/", "PRDs/", ".memory/", ".reviews/"],
  },
  // Kept as its own entry: merging it with the block below would let that
  // block's `rules` key replace the whole recommended set instead of
  // overriding two rules of it.
  { ...js.configs.recommended, files: ["**/*.mjs", "**/*.cjs", "public/*.js"] },
  {
    files: ["**/*.mjs", "public/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      // Empty catch blocks are a deliberate pattern here (best-effort cleanup);
      // every other empty block stays an error.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // `_`-prefixed bindings are the codebase convention for "declared on
      // purpose, not used" (see electron/main.mjs).
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  { files: ["**/*.mjs"], languageOptions: { globals: { ...globals.node } } },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
  },
  // public/app.js is the only browser source: it runs in the page, next to the
  // vendored libraries. Those are reached through the `win` view of the global
  // object, never as bare identifiers, so no extra global is declared here.
  {
    files: ["public/*.js"],
    languageOptions: { globals: { ...globals.browser } },
  },
];
