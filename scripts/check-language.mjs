#!/usr/bin/env node
// The wording gates, kept apart from the rest of the verification so the two
// tripwires live where they can be read: the shipped sources must be in English
// and must spell the product name exactly one way.
// Run on its own with `node scripts/check-language.mjs`, or as the "language"
// and "naming" steps of `npm run verify`, which imports the two checks below.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "backup",
  ".idea",
  ".sslayer",
  "PRDs",
  ".memory",
  ".reviews",
]);
// The UI ships in English only. This is a hand-written denylist of known
// Italian words -- the ones the translation commit left behind -- kept as a
// tripwire against their return: it catches these words, not Italian in
// general. Documents (.md) and the excluded dirs above are allowed to be in
// Italian.
const TRANSLATED_EXTENSIONS = [".mjs", ".js", ".html", ".css"];
const ITALIAN_BLOCKLIST = [
  "troncat\\w*",
  "scadut\\w*",
  "riconnession\\w*",
  "richiesta",
  "totale",
  "completata",
  "esecuzione",
  "caratteri",
  "misura",
  "aggiornalo",
  // the sidebar's own leftovers: date buckets and the placeholder of a chat
  // with no title, which lived in index.html until the page was split up
  "oggi",
  "ieri",
  "ultimi",
  "giorni",
  "vuota",
];
const ITALIAN_RE = new RegExp(`\\b(?:${ITALIAN_BLOCKLIST.join("|")})\\b`, "i");
// The product has exactly one name, and it lives in product.mjs. `pi-web-ui`
// was the previous one: this is a tripwire against its return, same mechanism
// as the blocklist above.
// The *persisted* names are deliberately out of its reach and must never be
// renamed: the `web-ui-*.json` stores, the `pi_web_ui_access` cookie and the
// PI_WEB_UI_AGENT_DIR / PI_WEB_UI_TEST env vars are written on disk and live in
// existing installations. None of them spells the name the hyphenated way, so
// the pattern below leaves them alone by construction.
const OLD_PRODUCT_NAME_RE = /pi-web-ui/i;

/**
 * Walks the project, skipping IGNORED_DIRS, and returns every file whose name
 * `matches`. Shared with verify.mjs, which walks the same tree for the syntax
 * check: one definition of what "the project's files" means.
 *
 * @param {string} dir
 * @param {(name: string) => boolean} matches
 * @returns {Promise<string[]>}
 */
export async function collectFiles(dir, matches) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      files.push(...(await collectFiles(full, matches)));
    } else if (matches(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

// Reads every translated source file once and reports the lines matching `re`
// as `path:line: text`. This file is skipped: it holds the patterns themselves.
async function scanSources(re) {
  const files = await collectFiles(ROOT, (name) =>
    TRANSLATED_EXTENSIONS.some((ext) => name.endsWith(ext)),
  );
  const failures = [];
  const self = fileURLToPath(import.meta.url);
  for (const file of files) {
    if (file === self) continue;
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    lines.forEach((line, i) => {
      if (re.test(line)) {
        failures.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  return { failures, scanned: files.length };
}

// Scans the shipped sources -- user-visible strings and comments alike -- for
// the known Italian words of ITALIAN_BLOCKLIST. It is a denylist, not a proof
// that no Italian is left: a word outside the list goes through unnoticed.
// Reports every offending line, so one run is enough to fix them all.
export async function checkNoItalianStrings() {
  const { failures, scanned } = await scanSources(ITALIAN_RE);
  if (failures.length > 0) {
    throw new Error(`Italian text in ${failures.length} line(s):\n${failures.join("\n")}`);
  }
  return scanned;
}

// The other tripwire: the retired product name, anywhere in the sources.
export async function checkOneProductName() {
  const { failures, scanned } = await scanSources(OLD_PRODUCT_NAME_RE);
  if (failures.length > 0) {
    throw new Error(
      `the retired product name in ${failures.length} line(s) — import PRODUCT_ID / ` +
        `PRODUCT_NAME from product.mjs instead:\n${failures.join("\n")}`,
    );
  }
  return scanned;
}

// Standalone entry point. `npm run verify` imports the checks instead, so this
// runs only when the file is the process' own script.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const scanned = await checkNoItalianStrings();
    console.log(`✓ language: no known Italian words in ${scanned} source file(s)`);
    const named = await checkOneProductName();
    console.log(`✓ naming: no retired product name in ${named} source file(s)`);
  } catch (err) {
    console.error(`✗ check-language failed: ${err.message}`);
    process.exit(1);
  }
}
