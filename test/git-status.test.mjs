import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = readFileSync(new URL("../contexts.mjs", import.meta.url), "utf8");
const gitSource = source.slice(source.indexOf("const gitCache = new Map()")).replaceAll("export async function", "async function");

function fixture() {
  const calls = [];
  const context = vm.createContext({
    execFile(command, args, options, callback) { calls.push({ command, args, options, callback }); },
  });
  vm.runInContext(gitSource, context);
  return { context, calls };
}

test("concurrent Git status requests share one process per directory", async () => {
  const { context, calls } = fixture();
  const requests = Array.from({ length: 300 }, () => context.gitStatus("project"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.windowsHide, true);
  calls[0].callback(null, "## main...origin/main [ahead 2]\n M file.js\n?? new.js\n");
  const statuses = await Promise.all(requests);
  assert.ok(statuses.every((status) => status === statuses[0]));
  assert.equal(statuses[0].branch, "main");
  assert.equal(statuses[0].changed, 2);
  await context.gitStatus("project");
  assert.equal(calls.length, 1, "fresh cache avoids another process");
  const forced = context.gitStatus("project", { force: true });
  assert.equal(calls.length, 2);
  calls[1].callback(null, "## other\n");
  assert.equal((await forced).branch, "other");
});

test("Git failures release in-flight work and do not mix projects", async () => {
  const { context, calls } = fixture();
  const a = context.gitStatus("a");
  const b = context.gitStatus("b");
  assert.equal(calls.length, 2);
  calls[0].callback(new Error("not a repo"));
  calls[1].callback(null, "## main\n");
  assert.equal((await a).repo, false);
  assert.equal((await b).repo, true);
  const retry = context.gitStatus("a", { force: true });
  calls[2].callback(null, "## recovered\n");
  assert.equal((await retry).branch, "recovered");
});

test("sidebar summaries never execute Git", () => {
  const api = readFileSync(new URL("../api-chat.mjs", import.meta.url), "utf8");
  const summary = api.slice(api.indexOf("async function sessionEntry("), api.indexOf("const byNewestFirst"));
  assert.doesNotMatch(summary, /gitStatus\(|gitBranches\(|runGit\(/);
});
