import { execFile } from "node:child_process";

// Read-only Git commands for the selected project. Cache completed results
// briefly and share in-flight status checks across callers.
const gitCache = new Map(); // cwd -> { at, data }
const gitPending = new Map();

function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    // Without windowsHide, each Git refresh briefly opens a console window.
    execFile("git", args, { cwd, timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

export async function gitStatus(cwd, { force = false } = {}) {
  if (gitPending.has(cwd)) return gitPending.get(cwd);
  const pending = readGitStatus(cwd, force);
  gitPending.set(cwd, pending);
  try {
    return await pending;
  } finally {
    if (gitPending.get(cwd) === pending) gitPending.delete(cwd);
  }
}

async function readGitStatus(cwd, force) {
  const hit = gitCache.get(cwd);
  if (!force && hit && Date.now() - hit.at < 5000) return hit.data;
  let data;
  try {
    // porcelain v1 + branch: first line is "## branch...upstream [ahead N, behind M]"
    const status = await runGit(cwd, ["status", "--porcelain=v1", "--branch"]);
    const lines = status.split("\n").filter(Boolean);
    const head = lines.shift() ?? "";
    const branch = head.includes("No commits yet on ")
      ? head.split("No commits yet on ")[1].trim()
      : head.replace(/^##\s+/, "").replace(/\.\.\..*$/, "").replace(/\s*\[.*$/, "") || "HEAD";
    let ahead = 0;
    let behind = 0;
    const ab = head.match(/\[ahead (\d+)(?:, behind (\d+))?\]|\[behind (\d+)\]/);
    if (ab) {
      ahead = Number(ab[1] ?? 0);
      behind = Number(ab[2] ?? ab[3] ?? 0);
    }
    let staged = 0;
    let unstaged = 0;
    let untracked = 0;
    for (const line of lines) {
      const x = line[0];
      const y = line[1];
      if (x === "?" && y === "?") {
        untracked++;
        continue;
      }
      if (x && x !== " ") staged++;
      if (y && y !== " ") unstaged++;
    }
    data = {
      repo: true,
      branch,
      ahead,
      behind,
      staged,
      unstaged,
      untracked,
      changed: staged + unstaged + untracked,
    };
  } catch {
    data = { repo: false }; // not a repo (or git missing): the chip hides
  }
  gitCache.set(cwd, { at: Date.now(), data });
  return data;
}

export async function gitBranches(cwd) {
  const output = await runGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return output.split("\n").map((branch) => branch.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

export async function switchGitBranch(cwd, branch) {
  const branches = await gitBranches(cwd);
  if (!branches.includes(branch)) throw new Error("branch does not exist in this repository");
  await gitPending.get(cwd);
  await runGit(cwd, ["switch", branch]);
  gitCache.delete(cwd);
  return gitStatus(cwd);
}
