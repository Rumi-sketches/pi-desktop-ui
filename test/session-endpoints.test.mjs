// The routes that were once two endpoints switching on a field of the JSON
// body (`POST /api/session` with `action`, `POST /api/archiving` with
// `enabled`/`archiveNow`): one operation, one route, one verb.
//
// These started life as characterization tests of the old shape and were
// carried over one for one, so the coverage is the same: every branch that
// existed then still has its test here, under the route that replaced it.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Same isolation the verify smoke test uses: the server rewrites its state
// files at boot, so it must never see the real ~/.pi/agent of whoever runs the
// suite. Two variables are needed, and neither covers the other:
// PI_WEB_UI_AGENT_DIR moves this project's own stores, PI_CODING_AGENT_DIR
// moves the agent dir of the pi library, where the SessionManager writes the
// session files, and PI_WEB_UI_TEST=1 is what makes the first one honoured at
// all. All are resolved by module-level constants, hence the overrides have to
// land *before* the dynamic import.
let agentDir;
let server;
let origin;
let bootContext;
/** A hand-written session file inside the temporary sessions dir: the only
 *  kind of path an activate route accepts (it must exist and live under
 *  SESSIONS_DIR). */
let sessionFile;
let transcriptFile;

const SKILL_BODY_SENTINEL = "SECRET_SKILL_INSTRUCTION_BODY";
const SKILL_EXPANDED_TEXT = `<skill name="release-check" location="C:/skills/release-check/SKILL.md">\n${SKILL_BODY_SENTINEL}\n</skill>\n\n--strict package-a`;
const IMAGE_BYTES = Buffer.from("persisted-image-fixture");

const SESSION_HEADER = {
  type: "session",
  version: 3,
  id: "019fe65c-8714-7ee3-97a0-18b278f8229a",
  cwd: process.cwd(),
};

before(async () => {
  agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-session-endpoints-"));
  process.env.PI_WEB_UI_TEST = "1";
  process.env.PI_WEB_UI_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const sessionsDir = path.join(agentDir, "sessions", "project");
  await mkdir(sessionsDir, { recursive: true });
  sessionFile = path.join(sessionsDir, "saved.jsonl");
  await writeFile(sessionFile, `${JSON.stringify({ ...SESSION_HEADER, timestamp: new Date().toISOString() })}\n`);
  transcriptFile = path.join(sessionsDir, "transcript.jsonl");
  const timestamp = new Date().toISOString();
  const transcript = [
    { type: "session", version: 3, id: "transcript-fixture", cwd: process.cwd(), timestamp },
    {
      type: "message", id: "skill-user", parentId: null, timestamp,
      message: { role: "user", content: [{ type: "text", text: SKILL_EXPANDED_TEXT }], timestamp },
    },
    {
      type: "message", id: "openai-answer", parentId: "skill-user", timestamp,
      message: {
        role: "assistant", provider: "openai-codex", model: "gpt-fixture", timestamp,
        content: [
          { type: "thinking", thinking: "Inspecting the release." },
          { type: "text", text: "Ready." },
          { type: "toolCall", id: "tool-fixture", name: "read", arguments: { path: "package.json" } },
        ],
        usage: {
          input: 11,
          output: 5,
          cacheRead: 7,
          cacheWrite: 2,
          totalTokens: 25,
          cost: { input: 0.01, output: 0.02, cacheRead: 0.005, cacheWrite: 0.005, total: 0.04 },
        },
      },
    },
    {
      type: "message", id: "tool-result", parentId: "openai-answer", timestamp,
      message: {
        role: "toolResult", toolCallId: "tool-fixture", toolName: "read", isError: false,
        content: [{ type: "text", text: "fixture output" }], timestamp,
      },
    },
    {
      type: "message", id: "image-user", parentId: "tool-result", timestamp,
      message: {
        role: "user",
        content: [{ type: "image", data: IMAGE_BYTES.toString("base64"), mimeType: "image/png" }],
        timestamp,
      },
    },
  ];
  await writeFile(transcriptFile, `${transcript.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  const { startServer } = await import("../server.mjs");
  server = await startServer({ port: 0 });
  origin = server.url.replace(/\/$/, "");
  bootContext = (await import("../contexts.mjs")).getBootContext();
});

after(async () => {
  await server?.stop();
  await rm(agentDir, { recursive: true, force: true });
});

// The request guard rejects an unsafe method without a same-origin Origin
// header, so every call carries one.
async function sendJson(method, pathname, body) {
  const res = await fetch(`${origin}${pathname}`, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

const postJson = (pathname, body) => sendJson("POST", pathname, body);

describe("the agent bootstrap routes", () => {
  test("catalogued prompt files can be created and removed, arbitrary ids cannot", async () => {
    const initial = await getJson("/api/agent-bootstrap");
    assert.equal(initial.status, 200);
    const globalAgents = initial.body.files.find((file) => file.key === "global-agents");
    assert.ok(globalAgents);
    assert.equal(globalAgents.exists, false);

    const saved = await sendJson("PUT", "/api/agent-bootstrap/file", {
      id: globalAgents.id,
      content: "# Global instructions\n\nUse the bootstrap fixture.\n",
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.bootstrap.files.find((file) => file.key === "global-agents").active, true);
    assert.match(await readFile(path.join(agentDir, "AGENTS.md"), "utf8"), /bootstrap fixture/);

    const arbitrary = await sendJson("PUT", "/api/agent-bootstrap/file", { id: "not-catalogued", content: "x" });
    assert.equal(arbitrary.status, 404);
    assert.equal(arbitrary.body.error.code, "resource_not_found");
    const arbitraryOpen = await postJson("/api/agent-bootstrap/file/open", { id: "not-catalogued" });
    assert.equal(arbitraryOpen.status, 404);

    const removed = await sendJson("DELETE", "/api/agent-bootstrap/file", { id: globalAgents.id });
    assert.equal(removed.status, 200);
    assert.equal(existsSync(path.join(agentDir, "AGENTS.md")), false);
  });

  test("the desktop tool selection persists and null restores pi defaults", async () => {
    const custom = await sendJson("PUT", "/api/agent-bootstrap/tools", { tools: ["read"] });
    assert.equal(custom.status, 200);
    assert.equal(custom.body.bootstrap.toolsMode, "custom");
    assert.deepEqual(JSON.parse(await readFile(path.join(agentDir, "web-ui-agent-bootstrap.json"), "utf8")), { tools: ["read"] });

    const reset = await sendJson("PUT", "/api/agent-bootstrap/tools", { tools: null });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.bootstrap.toolsMode, "pi-default");
  });

  test("a file saved outside the UI after draft creation reaches its first prompt", async () => {
    const { createContext, getModelRuntime } = await import("../contexts.mjs");
    const projectDir = path.join(agentDir, "bootstrap-project");
    await mkdir(projectDir, { recursive: true });
    const runtime = getModelRuntime();
    let observedSystemPrompt = "";
    const answer = {
      role: "assistant", provider: "bootstrap-fixture", model: "prompt", api: "bootstrap-fixture",
      content: [{ type: "text", text: "Ready." }], stopReason: "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    runtime.registerProvider("bootstrap-fixture", {
      baseUrl: "http://127.0.0.1:1", apiKey: "fixture", api: "bootstrap-fixture",
      models: [{ id: "prompt", name: "Prompt fixture", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 100 }],
      streamSimple: (_model, context) => {
        observedSystemPrompt = context.systemPrompt;
        return {
          result: async () => answer,
          async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message: answer }; },
        };
      },
    });
    const ctx = await createContext({ cwd: projectDir, mode: "new" });
    await ctx.session.setModel(runtime.getModel("bootstrap-fixture", "prompt"));

    const sentinel = "NOTEPAD_SAVE_REACHED_FIRST_PROMPT";
    await writeFile(path.join(agentDir, "AGENTS.md"), sentinel, "utf8");
    const accepted = await postJson(`/api/prompt?s=${encodeURIComponent(ctx.key)}`, { text: "fixture request" });
    assert.equal(accepted.status, 202);
    for (let attempt = 0; attempt < 100 && !observedSystemPrompt; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(observedSystemPrompt, new RegExp(sentinel));
    await rm(path.join(agentDir, "AGENTS.md"), { force: true });
  });
});

test("live usage includes the just-persisted SDK response without a state refresh", async () => {
  const { createContext, getModelRuntime } = await import("../contexts.mjs");
  const runtime = getModelRuntime();
  const answer = {
    role: "assistant", provider: "review-fixture", model: "metrics", api: "review-fixture",
    content: [{ type: "text", text: "Fixture answer" }], stopReason: "stop", timestamp: Date.now(),
    usage: { input: 11, output: 5, cacheRead: 7, cacheWrite: 2, totalTokens: 25,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.005, cacheWrite: 0.005, total: 0.04 } },
  };
  // Keep the real SDK lifecycle and persistence; only the provider is fake.
  runtime.registerProvider("review-fixture", {
    baseUrl: "http://127.0.0.1:1", apiKey: "fixture", api: "review-fixture",
    models: [{ id: "metrics", name: "Metrics fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 100 }],
    streamSimple: () => ({
      result: async () => answer,
      async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message: answer }; },
    }),
  });
  const ctx = await createContext({ mode: "new" });
  await ctx.session.setModel(runtime.getModel("review-fixture", "metrics"));
  const events = [];
  const client = { write(chunk) {
    if (chunk.startsWith("data: ")) events.push(JSON.parse(chunk.slice(6)));
    return true;
  } };
  ctx.clients.add(client);
  try {
    await ctx.session.prompt("fixture request");
    const usage = events.filter((event) => event.kind === "usage").at(-1);
    assert.equal(usage.metrics.total.tokens, 25, JSON.stringify(events));
    assert.equal(usage.metrics.total.cost, 0.04);
    assert.equal(usage.metrics.byModel["review-fixture/metrics"].tokens, 25);
    assert.equal(usage.metrics.total.tokens, ctx.session.getSessionStats().tokens.total);
  } finally {
    ctx.clients.delete(client);
    runtime.unregisterProvider("review-fixture");
  }
});

async function getJson(pathname) {
  const res = await fetch(`${origin}${pathname}`);
  return { status: res.status, body: await res.json() };
}

// A chat is identified by its session file, so the id travels url-encoded.
const sessionUrl = (id, suffix) => `/api/sessions/${encodeURIComponent(id)}/${suffix}`;

// Every route that puts the tab on a chat answers with this exact shape. The
// key is a session file path, or a synthetic one for a chat with no file yet,
// so only its type is pinned here.
function assertContextPayload(payload) {
  assert.deepEqual(Object.keys(payload).sort(), ["cwd", "key", "ok", "running"]);
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.key, "string");
  assert.ok(payload.key.length > 0, "key must not be empty");
  assert.equal(typeof payload.cwd, "string");
  assert.equal(typeof payload.running, "boolean");
}

// The isolation this file depends on is invisible while it holds: the pi
// library writes its session files lazily, so dropping PI_CODING_AGENT_DIR
// would not turn any assertion below red -- it would just quietly start
// writing into the real ~/.pi/agent of whoever runs the suite. This pins the
// invariant at its source: the dir the library would write to is the
// temporary one. Reaching into dist/ is the only way to ask it, so a package
// that moves the module skips the check instead of failing the suite.
describe("the agent dir the pi library resolves", () => {
  test("is the temporary one, not the real ~/.pi/agent", async (t) => {
    // Resolved at runtime on purpose: the module is not in the package's
    // `exports`, so a literal import would fail the type check.
    const configPath = path.join(
      import.meta.dirname,
      "..",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "config.js",
    );
    if (!existsSync(configPath)) return t.skip("pi-coding-agent no longer exposes dist/config.js");
    const config = await import(pathToFileURL(configPath).href);
    assert.equal(config.ENV_AGENT_DIR, "PI_CODING_AGENT_DIR");
    assert.equal(path.resolve(config.getAgentDir()), path.resolve(agentDir));
  });
});

describe("the session routes", () => {
  test("POST /api/sessions/activate reopens the most recent chat of the folder", async () => {
    const { status, body } = await postJson("/api/sessions/activate");
    assert.equal(status, 200);
    assertContextPayload(body);
  });

  test("POST /api/sessions starts a chat in the folder of the current one", async () => {
    const { status, body } = await postJson("/api/sessions");
    assert.equal(status, 200);
    assertContextPayload(body);
  });

  test("POST /api/sessions/:id/activate loads that chat and answers with its path as key", async () => {
    const { status, body } = await postJson(sessionUrl(sessionFile, "activate"));
    assert.equal(status, 200);
    assertContextPayload(body);
    assert.equal(body.key, sessionFile);
  });

  test("activating an empty id is a 400", async () => {
    const { status, body } = await postJson("/api/sessions//activate");
    assert.equal(status, 400);
    assert.match(body.error, /missing path/);
  });

  test("activating a file outside the sessions dir is a 400", async () => {
    const outside = path.join(process.cwd(), "package.json");
    const { status, body } = await postJson(sessionUrl(outside, "activate"));
    assert.equal(status, 400);
    assert.equal(typeof body.error, "string");
  });

  test("activating with an unknown cwd is a 400", async () => {
    const { status, body } = await postJson(sessionUrl(sessionFile, "activate"), {
      cwd: path.join(agentDir, "no-such-folder"),
    });
    assert.equal(status, 400);
    assert.match(body.error, /directory not found/);
  });

  test("forking without an entryId is a 400", async () => {
    const { status, body } = await postJson(sessionUrl(sessionFile, "fork"));
    assert.equal(status, 400);
    assert.match(body.error, /missing entryId/);
  });

  // useContext falls back to the most recent chat of the default folder when a
  // key does not resolve: the fork route must refuse the id before that point,
  // or it would branch a chat the caller never named.
  test("forking an id that does not resolve is a 400", async () => {
    const missing = path.join(agentDir, "sessions", "project", "no-such-chat.jsonl");
    const { status, body } = await postJson(sessionUrl(missing, "fork"), { entryId: "whatever" });
    assert.equal(status, 400);
    assert.match(body.error, /file not found/);
  });

  test("forking a file outside the sessions dir is a 400", async () => {
    const outside = path.join(process.cwd(), "package.json");
    const { status, body } = await postJson(sessionUrl(outside, "fork"), { entryId: "whatever" });
    assert.equal(status, 400);
    assert.match(body.error, /outside the sessions directory/);
  });

  test("forking a draft chat (no session file yet) is a 400", async () => {
    const { status, body } = await postJson(sessionUrl("draft:/tmp/project", "fork"), { entryId: "whatever" });
    assert.equal(status, 400);
    assert.match(body.error, /no session file yet/);
  });

  test("forking on an unknown entryId is a 400, not a crash", async () => {
    const { status, body } = await postJson(sessionUrl(sessionFile, "fork"), { entryId: "no-such-entry" });
    assert.equal(status, 400);
    assert.equal(typeof body.error, "string");
  });

  // The `action` field is gone, and so is the endpoint that read it: an old
  // client calling it gets a 404, not a chat it did not ask for.
  test("the old POST /api/session is no longer routed", async () => {
    const { status } = await postJson("/api/session", { action: "new" });
    assert.equal(status, 404);
  });
});

describe("the transcript route", () => {
  test("persisted skill instructions stay server-side and arguments are separate", async () => {
    const { status, body } = await getJson(`/api/history?s=${encodeURIComponent(transcriptFile)}`);
    assert.equal(status, 200);
    const skillMessage = body.messages.find((message) => message.role === "user");
    assert.deepEqual(skillMessage.blocks, [{
      type: "skill",
      name: "release-check",
      arguments: "--strict package-a",
    }]);
    assert.equal(skillMessage.text, "/skill:release-check --strict package-a");
    assert.equal(JSON.stringify(body).includes(SKILL_BODY_SENTINEL), false);
    assert.equal(JSON.stringify(body).includes("C:/skills/release-check/SKILL.md"), false);
  });

  test("OpenAI reasoning keeps the normalized order in history", async () => {
    const { status, body } = await getJson(`/api/history?s=${encodeURIComponent(transcriptFile)}`);
    assert.equal(status, 200);
    const answer = body.messages.find((message) => message.role === "assistant");
    assert.equal(answer.provider, "openai-codex");
    assert.deepEqual(answer.blocks.map((block) => block.type), ["thinking", "text", "tool"]);
    assert.equal(answer.blocks[0].text, "Inspecting the release.");
    assert.equal(answer.blocks[2].output, "fixture output");
  });

  test("image-only messages survive history reload without embedding base64", async () => {
    const session = encodeURIComponent(transcriptFile);
    const history = await getJson(`/api/history?s=${session}`);
    assert.equal(history.status, 200);
    const message = history.body.messages.find((item) => item.entryId === "image-user");
    assert.deepEqual(message.blocks, [{ type: "image", mimeType: "image/png", contentIndex: 0 }]);
    assert.equal(JSON.stringify(history.body).includes(IMAGE_BYTES.toString("base64")), false);

    const response = await fetch(`${origin}/api/attachment?s=${session}&entry=image-user&block=0`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), IMAGE_BYTES);
  });

  test("OpenAI streaming reasoning uses the provider-agnostic SSE shape", async () => {
    const { assistantDeltaEvent } = await import("../contexts.mjs");
    const openAiPartial = { provider: "openai-codex", model: "gpt-fixture" };
    assert.deepEqual(assistantDeltaEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "Reasoning", partial: openAiPartial },
    }), { kind: "thinking", delta: "Reasoning" });
    assert.deepEqual(assistantDeltaEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Answer", partial: openAiPartial },
    }), { kind: "text", delta: "Answer" });
  });
});

describe("canonical chat metrics", () => {
  test("a reopened session reports SDK totals including both cache buckets", async () => {
    const { status, body } = await getJson(`/api/state?s=${encodeURIComponent(transcriptFile)}`);
    assert.equal(status, 200);
    assert.deepEqual(body.metrics.total, {
      tokens: 25,
      input: 11,
      output: 5,
      cacheWrite: 2,
      cacheRead: 7,
      cost: 0.04,
      requests: 1,
    });
    assert.deepEqual(body.metrics.byModel["openai-codex/gpt-fixture"], body.metrics.total);
    assert.equal(body.metrics.sessionWork, null);
  });

  test("per-model rows plus Session work equal canonical totals after compaction", async () => {
    const { sessionMetrics } = await import("../contexts.mjs");
    const firstUsage = {
      input: 5, output: 3, cacheRead: 10, cacheWrite: 2,
      cost: { total: 0.1 },
    };
    const secondUsage = {
      input: 4, output: 2, cacheRead: 20, cacheWrite: 1,
      cost: { total: 0.2 },
    };
    let context = { tokens: null, contextWindow: 200000, percent: null };
    let statsCalls = 0;
    let contextCalls = 0;
    const session = {
      getSessionStats() {
        statsCalls += 1;
        return {
          assistantMessages: 2,
          tokens: { input: 20, output: 10, cacheRead: 40, cacheWrite: 5, total: 75 },
          cost: 0.5,
        };
      },
      getContextUsage() {
        contextCalls += 1;
        return context;
      },
      sessionManager: {
        getEntries: () => [
          { type: "message", message: { role: "assistant", provider: "anthropic", model: "claude-fixture", usage: firstUsage } },
          { type: "message", message: { role: "assistant", provider: "openai-codex", model: "gpt-fixture", usage: secondUsage } },
          { type: "compaction", usage: { input: 11, output: 5, cacheRead: 10, cacheWrite: 2, cost: { total: 0.2 } } },
        ],
      },
    };

    const compacted = sessionMetrics(session);
    assert.deepEqual(compacted.context, { tokens: null, contextWindow: 200000, percent: null });
    assert.deepEqual(
      { ...compacted.sessionWork, cost: Number(compacted.sessionWork.cost.toFixed(12)) },
      { tokens: 28, input: 11, output: 5, cacheWrite: 2, cacheRead: 10, cost: 0.2, requests: 0 },
    );
    for (const field of ["tokens", "input", "output", "cacheWrite", "cacheRead", "cost", "requests"]) {
      const rows = Object.values(compacted.byModel).reduce((sum, row) => sum + row[field], 0);
      assert.ok(Math.abs(rows + compacted.sessionWork[field] - compacted.total[field]) < 1e-12, `${field} rows must sum to total`);
    }

    context = { tokens: 10000, contextWindow: 100000, percent: 10 };
    const switched = sessionMetrics(session);
    assert.deepEqual(switched.context, { tokens: 10000, contextWindow: 100000, percent: 10 });
    assert.equal(statsCalls, 2);
    assert.equal(contextCalls, 2);
  });

  test("an empty session keeps zero totals and a real zero-percent context", async () => {
    const { sessionMetrics } = await import("../contexts.mjs");
    const metrics = sessionMetrics({
      getSessionStats: () => ({
        assistantMessages: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      }),
      getContextUsage: () => ({ tokens: 0, contextWindow: 128000, percent: 0 }),
      sessionManager: { getEntries: () => [] },
    });
    assert.deepEqual(metrics.total, {
      tokens: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, requests: 0,
    });
    assert.deepEqual(metrics.byModel, {});
    assert.equal(metrics.sessionWork, null);
    assert.deepEqual(metrics.context, { tokens: 0, contextWindow: 128000, percent: 0 });
  });
});

describe("the cancellable prompt routes", () => {
  test("busy POSTs get distinct ids, state omits base64, and DELETE removes only its id", async () => {
    const key = encodeURIComponent(bootContext.key);
    const imageData = Buffer.from("api-image").toString("base64");
    bootContext.promptStarting = true;
    try {
      const first = await postJson(`/api/prompt?s=${key}`, {
        text: "same",
        type: "steer",
        images: [{ data: imageData, mimeType: "image/png" }],
      });
      const second = await postJson(`/api/prompt?s=${key}`, { text: "same", type: "steer" });
      assert.equal(first.status, 202);
      assert.equal(second.status, 202);
      assert.notEqual(first.body.queued.id, second.body.queued.id);
      assert.equal(JSON.stringify(first.body).includes(imageData), false);

      const state = await getJson(`/api/state?s=${key}`);
      assert.equal(state.status, 200);
      assert.deepEqual(state.body.queuedPrompts.map((item) => item.id), [first.body.queued.id, second.body.queued.id]);
      assert.equal(JSON.stringify(state.body.queuedPrompts).includes(imageData), false);

      const removed = await sendJson(
        "DELETE",
        `/api/queued-prompts/${encodeURIComponent(first.body.queued.id)}?s=${key}`,
      );
      assert.equal(removed.status, 200);
      assert.equal(removed.body.removed.id, first.body.queued.id);
      assert.deepEqual(bootContext.promptQueue.publicItems().map((item) => item.id), [second.body.queued.id]);
    } finally {
      bootContext.promptStarting = false;
      bootContext.promptQueue.clear("test_cleanup");
    }
  });

  test("DELETE distinguishes an unknown id from one already removed", async () => {
    const key = encodeURIComponent(bootContext.key);
    const unknown = await sendJson("DELETE", `/api/queued-prompts/no-such-id?s=${key}`);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, "queued_prompt_not_found");

    bootContext.promptStarting = true;
    try {
      const cancelled = await postJson(`/api/prompt?s=${key}`, { text: "cancelled", type: "followUp" });
      await sendJson("DELETE", `/api/queued-prompts/${encodeURIComponent(cancelled.body.queued.id)}?s=${key}`);
      const cancelledAgain = await sendJson(
        "DELETE",
        `/api/queued-prompts/${encodeURIComponent(cancelled.body.queued.id)}?s=${key}`,
      );
      assert.equal(cancelledAgain.status, 409);
      assert.equal(cancelledAgain.body.error.code, "queued_prompt_removed");
    } finally {
      bootContext.promptStarting = false;
      bootContext.promptQueue.clear("test_cleanup");
    }
  });

  test("POST reports invalid type and the item cap as different causes", async () => {
    const key = encodeURIComponent(bootContext.key);
    bootContext.promptStarting = true;
    try {
      const invalid = await postJson(`/api/prompt?s=${key}`, { text: "x", type: "later" });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error.code, "invalid_queue_type");

      for (let i = 0; i < 20; i++) {
        assert.equal((await postJson(`/api/prompt?s=${key}`, { text: `item ${i}` })).status, 202);
      }
      const full = await postJson(`/api/prompt?s=${key}`, { text: "one too many" });
      assert.equal(full.status, 409);
      assert.equal(full.body.error.code, "queue_item_limit");
    } finally {
      bootContext.promptStarting = false;
      bootContext.promptQueue.clear("test_cleanup");
    }
  });

  test("abort removes app-owned prompts before asking the SDK to stop", async () => {
    const key = encodeURIComponent(bootContext.key);
    bootContext.promptStarting = true;
    try {
      assert.equal((await postJson(`/api/prompt?s=${key}`, { text: "do not run" })).status, 202);
      const aborted = await postJson(`/api/abort?s=${key}`);
      assert.equal(aborted.status, 200);
      assert.deepEqual(bootContext.promptQueue.publicItems(), []);
    } finally {
      bootContext.promptStarting = false;
      bootContext.promptQueue.clear("test_cleanup");
    }
  });
});

describe("the archiving routes", () => {
  test("GET answers the archiving state", async () => {
    const { status, body } = await getJson("/api/archiving");
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ["enabled", "firstRunArchivedAt"]);
    assert.equal(typeof body.enabled, "boolean");
  });

  test("PUT { enabled } toggles the feature and answers the new state", async () => {
    const off = await sendJson("PUT", "/api/archiving", { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.enabled, false);
    assert.deepEqual(Object.keys(off.body).sort(), ["enabled", "firstRunArchivedAt"]);
    assert.equal((await getJson("/api/archiving")).body.enabled, false);

    const on = await sendJson("PUT", "/api/archiving", { enabled: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.enabled, true);
  });

  test("POST /api/archiving/sweep sweeps and adds the count to the state", async () => {
    const { status, body } = await postJson("/api/archiving/sweep");
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ["archived", "enabled", "firstRunArchivedAt"]);
    assert.equal(typeof body.archived, "number");
  });

  // The old endpoint dropped the sweep, silently, when `enabled` came along.
  // Two routes cannot shadow each other: the sweep runs whatever is toggled.
  test("a sweep next to a toggle is no longer swallowed", async () => {
    await sendJson("PUT", "/api/archiving", { enabled: true });
    const { status, body } = await postJson("/api/archiving/sweep");
    assert.equal(status, 200);
    assert.equal(body.enabled, true);
    assert.equal(typeof body.archived, "number");
  });

  test("a PUT with no enabled field is a 400", async () => {
    const { status, body } = await sendJson("PUT", "/api/archiving", {});
    assert.equal(status, 400);
    assert.match(body.error, /enabled must be a boolean/);
  });

  test("a non-boolean enabled is not a toggle: it is a 400", async () => {
    const { status, body } = await sendJson("PUT", "/api/archiving", { enabled: "yes" });
    assert.equal(status, 400);
    assert.match(body.error, /enabled must be a boolean/);
  });
});

// The switch in front of the only feature that spends the user's quota. The
// default is the whole point of it, so it is the first thing asserted.
describe("the title generation routes", () => {
  test("GET answers both independent opt-ins, and they start off", async () => {
    const { status, body } = await getJson("/api/title-generation");
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), [
      "enabled",
      "enabledAt",
      "lunaTitleFallback",
      "lunaTitleFallbackEnabledAt",
    ]);
    assert.equal(body.enabled, false);
    assert.equal(body.enabledAt, null);
    assert.equal(body.lunaTitleFallback, false);
    assert.equal(body.lunaTitleFallbackEnabledAt, null);
  });

  test("Haiku and Luna consent toggle and persist independently", async () => {
    const primary = await sendJson("PUT", "/api/title-generation", { enabled: true });
    assert.equal(primary.status, 200);
    assert.equal(primary.body.enabled, true);
    assert.equal(primary.body.lunaTitleFallback, false);
    assert.equal(typeof primary.body.enabledAt, "string");

    const fallback = await sendJson("PUT", "/api/title-generation", { lunaTitleFallback: true });
    assert.equal(fallback.status, 200);
    assert.equal(fallback.body.enabled, true);
    assert.equal(fallback.body.lunaTitleFallback, true);
    assert.equal(typeof fallback.body.lunaTitleFallbackEnabledAt, "string");

    const off = await sendJson("PUT", "/api/title-generation", { enabled: false });
    assert.equal(off.body.enabled, false);
    assert.equal(off.body.lunaTitleFallback, true);

    const saved = JSON.parse(await readFile(path.join(agentDir, "web-ui-title-generation.json"), "utf8"));
    assert.equal(saved.enabled, false);
    assert.equal(saved.lunaTitleFallback, true);
    assert.equal(/token|credential/i.test(JSON.stringify(saved)), false);
  });

  test("POST /backfill answers the full state and queues nothing while Haiku is off", async () => {
    const { status, body } = await postJson("/api/title-generation/backfill");
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), [
      "enabled",
      "enabledAt",
      "lunaTitleFallback",
      "lunaTitleFallbackEnabledAt",
      "queued",
    ]);
    assert.equal(body.queued, 0);
  });

  test("non-boolean or missing opt-ins are rejected", async () => {
    const primary = await sendJson("PUT", "/api/title-generation", { enabled: "yes" });
    assert.equal(primary.status, 400);
    assert.match(primary.body.error, /enabled must be a boolean/);

    const fallback = await sendJson("PUT", "/api/title-generation", { lunaTitleFallback: "yes" });
    assert.equal(fallback.status, 400);
    assert.match(fallback.body.error, /lunaTitleFallback must be a boolean/);

    const missing = await sendJson("PUT", "/api/title-generation", {});
    assert.equal(missing.status, 400);
  });
});

describe("the OpenAI usage opt-in", () => {
  test("starts off, persists independently, and never stores an OAuth token", async () => {
    const initial = await getJson("/api/usage/config");
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body.openai, { enabled: false, configured: false });

    const enabled = await postJson("/api/usage/config", { provider: "openai-codex", enabled: true });
    assert.equal(enabled.status, 200);
    assert.deepEqual(enabled.body.status.openai, { enabled: true, configured: false });

    const saved = await readFile(path.join(agentDir, "web-ui-openai-usage.json"), "utf8");
    assert.deepEqual(JSON.parse(saved), { enabled: true });
    assert.equal(/token|account/i.test(saved), false);

    const disabled = await postJson("/api/usage/config", { provider: "openai-codex", enabled: false });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.status.openai.enabled, false);
  });

  test("rejects a missing boolean instead of treating it as consent", async () => {
    const { status, body } = await postJson("/api/usage/config", { provider: "openai-codex" });
    assert.equal(status, 400);
    assert.equal(body.error.code, "invalid_enabled");
  });
});

describe("the usage credentials route", () => {
  test("DELETE /api/usage/credentials/:provider reports the state of both providers", async () => {
    const { status, body } = await sendJson("DELETE", "/api/usage/credentials/kimi");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.status.kimi.configured, false);
  });

  test("an unknown provider in the path is a 400", async () => {
    const { status, body } = await sendJson("DELETE", "/api/usage/credentials/openai");
    assert.equal(status, 400);
    assert.match(body.error, /unknown provider/);
  });
});
