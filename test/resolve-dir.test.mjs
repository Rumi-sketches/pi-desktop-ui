import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { resolveDir } from "../session-store.mjs";

// A directory whose name carries the metacharacters a shell would reinterpret:
// backtick (PowerShell escape), `$` (PowerShell expansion), `%` (cmd expansion)
// and a single quote (ends a PowerShell quoted string).
const HOSTILE = "a`b$c'd";

test("resolveDir: refuses a directory whose name carries shell metacharacters", async () => {
  await assert.rejects(
    resolveDir(path.join(os.tmpdir(), HOSTILE)),
    /forbidden characters/,
  );
});

test("resolveDir: refuses every character on the blocklist", async () => {
  for (const char of ['"', "&", "|", "^", "$", "%", "'", "`", "\n", "\r"]) {
    await assert.rejects(
      resolveDir(path.join(os.tmpdir(), `dir${char}name`)),
      /forbidden characters/,
      `expected ${JSON.stringify(char)} to be refused`,
    );
  }
});

test("resolveDir: an ordinary existing directory still resolves", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-resolve-dir-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.equal(await resolveDir(` ${dir} `), path.resolve(dir));
});
