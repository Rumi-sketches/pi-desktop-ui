// Minimal lint gate: ESLint recommended rules only, on the server-side sources.
// Deliberately no stylistic rules and no formatter — see CONTRIBUTING.md.
import js from "@eslint/js";

export default [
  {
    ignores: ["node_modules/", "backup/", "public/", "docs/", "PRDs/", ".memory/", ".reviews/"],
  },
  {
    ...js.configs.recommended,
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        Buffer: "readonly",
        AbortController: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        crypto: "readonly",
        structuredClone: "readonly",
      },
    },
    rules: {
      // Pre-existing patterns in the codebase; the gate enforces the rest of
      // the recommended set without forcing a rewrite (see the PRD guardrail).
      "no-empty": "off",
      "no-useless-escape": "off",
    },
  },
];
