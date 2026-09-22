import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gitBranches, gitStatus, switchGitBranch } from "../src/project/git.mjs";

function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

async function temporaryDirectory(t, name) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `pi desktop git ${name} `));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function repository(t, name) {
  const directory = await temporaryDirectory(t, name);
  await runGit(directory, ["init", "--initial-branch=main"]);
  await runGit(directory, ["config", "user.name", "Git fixture"]);
  await runGit(directory, ["config", "user.email", "git-fixture@example.invalid"]);
  await writeFile(path.join(directory, "staged.txt"), "initial\n");
  await writeFile(path.join(directory, "unstaged.txt"), "initial\n");
  await runGit(directory, ["add", "staged.txt", "unstaged.txt"]);
  await runGit(directory, ["commit", "-m", "initial fixture"]);
  return directory;
}

test("the Git module imports without the agent runtime and contexts no longer executes Git", async () => {
  const [moduleSource, contextSource] = await Promise.all([
    readFile(new URL("../src/project/git.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/chat/contexts.mjs", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(moduleSource, /contexts\.mjs|pi-coding-agent/);
  assert.doesNotMatch(contextSource, /execFile\("git"|function runGit|gitStatus\(|gitBranches\(|switchGitBranch\(/);
});

test("a directory that is not a repository reports repo false", async (t) => {
  const directory = await temporaryDirectory(t, "not a repository");
  assert.deepEqual(await gitStatus(directory, { force: true }), { repo: false });
  await assert.rejects(gitBranches(directory));
});

test("status handles paths with spaces, dirty files, caching and concurrent callers", async (t) => {
  const directory = await repository(t, "dirty repository");
  await appendFile(path.join(directory, "unstaged.txt"), "changed\n");
  await appendFile(path.join(directory, "staged.txt"), "changed\n");
  await runGit(directory, ["add", "staged.txt"]);
  await writeFile(path.join(directory, "untracked.txt"), "new\n");

  const requests = Array.from({ length: 300 }, () => gitStatus(directory, { force: true }));
  const statuses = await Promise.all(requests);
  assert.ok(statuses.every((status) => status === statuses[0]), "concurrent callers share one parsed result");
  assert.deepEqual(statuses[0], {
    repo: true,
    branch: "main",
    ahead: 0,
    behind: 0,
    staged: 1,
    unstaged: 1,
    untracked: 1,
    changed: 3,
  });
  assert.equal(await gitStatus(directory), statuses[0], "a fresh cached status keeps the same result");
});

test("branches are sorted, a valid switch succeeds and invalid input is rejected", async (t) => {
  const directory = await repository(t, "branch repository");
  await runGit(directory, ["branch", "zeta"]);
  await runGit(directory, ["branch", "alpha"]);

  assert.deepEqual(await gitBranches(directory), ["alpha", "main", "zeta"]);
  assert.equal((await switchGitBranch(directory, "alpha")).branch, "alpha");

  const marker = path.join(directory, "shell-input-ran");
  await assert.rejects(
    switchGitBranch(directory, `main;touch ${marker}`),
    /branch does not exist in this repository/,
  );
  assert.equal(existsSync(marker), false);
  assert.equal((await gitStatus(directory, { force: true })).branch, "alpha");
});

test("sidebar summaries never execute Git", async () => {
  const api = await readFile(new URL("../src/chat/api-chat.mjs", import.meta.url), "utf8");
  const summary = api.slice(api.indexOf("async function sessionEntry("), api.indexOf("const byNewestFirst"));
  assert.doesNotMatch(summary, /gitStatus\(|gitBranches\(|runGit\(/);
});
