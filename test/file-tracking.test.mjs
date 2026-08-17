import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { isAgentDirPath } from "../session-store.mjs";

// A stand-in for ~/.pi/agent: absolute, so the predicate sees the same shape it
// sees in production, without depending on the machine's real home.
const AGENT_DIR = path.join(os.tmpdir(), "pi-agent-fixture");
const inside = (...parts) => path.join(AGENT_DIR, ...parts);

test("isAgentDirPath: files in the agent dir are excluded from tracking", () => {
  assert.equal(isAgentDirPath(inside("auth.json"), AGENT_DIR), true);
  assert.equal(isAgentDirPath(inside("web-ui-network.json"), AGENT_DIR), true);
  assert.equal(isAgentDirPath(inside("sessions", "abc.jsonl"), AGENT_DIR), true);
});

test("isAgentDirPath: a traversal that lands back inside is still excluded", () => {
  assert.equal(isAgentDirPath(inside("sessions", "..", "auth.json"), AGENT_DIR), true);
});

test("isAgentDirPath: paths outside the agent dir stay tracked", () => {
  assert.equal(isAgentDirPath(path.join(os.tmpdir(), "project", "server.mjs"), AGENT_DIR), false);
  // sibling directory sharing the prefix: not inside
  assert.equal(isAgentDirPath(`${AGENT_DIR}-evil${path.sep}auth.json`, AGENT_DIR), false);
  // the directory itself is not a file to track
  assert.equal(isAgentDirPath(AGENT_DIR, AGENT_DIR), false);
});

test("isAgentDirPath: non-paths are not excluded", () => {
  assert.equal(isAgentDirPath("", AGENT_DIR), false);
  assert.equal(isAgentDirPath("   ", AGENT_DIR), false);
  assert.equal(isAgentDirPath(undefined, AGENT_DIR), false);
  assert.equal(isAgentDirPath(null, AGENT_DIR), false);
  assert.equal(isAgentDirPath(42, AGENT_DIR), false);
});
