import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";

const legacy = {
  "web-ui-agent-bootstrap.json": { tools: ["read", "read", " write "] },
  "web-ui-archiving.json": { enabled: false, firstRunArchivedAt: "2026-01-02T03:04:05.000Z" },
  "web-ui-title-generation.json": {
    enabled: true,
    enabledAt: "2026-02-03T04:05:06.000Z",
    lunaTitleFallback: false,
    lunaTitleFallbackEnabledAt: "2026-02-04T04:05:06.000Z",
  },
  "web-ui-openai-usage.json": { enabled: false },
  "web-ui-full-search.json": { enabled: true },
  "web-ui-recent-cwds.json": ["C:/one", "C:/two"],
};
const preferenceFiles = Object.keys(legacy);
let agentDir;
let preferences;
let contentsBeforeImport;

before(async () => {
  agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-preferences-"));
  for (const [name, value] of Object.entries(legacy)) {
    await writeFile(path.join(agentDir, name), JSON.stringify(value));
  }
  contentsBeforeImport = await Promise.all(
    preferenceFiles.map((name) => readFile(path.join(agentDir, name), "utf8")),
  );
  process.env.PI_WEB_UI_TEST = "1";
  process.env.PI_WEB_UI_AGENT_DIR = agentDir;
  preferences = await import("../src/storage/preferences.mjs");
});

after(() => rm(agentDir, { recursive: true, force: true }));

test("preferences import is inert and legacy files load without migration", async () => {
  assert.deepEqual((await readdir(agentDir)).sort(), [...preferenceFiles].sort());
  assert.deepEqual(
    await Promise.all(preferenceFiles.map((name) => readFile(path.join(agentDir, name), "utf8"))),
    contentsBeforeImport,
  );

  await preferences.loadPreferences();
  assert.deepEqual(preferences.agentBootstrapState(), { tools: ["read", "write"] });
  assert.deepEqual(preferences.archivingState(), legacy["web-ui-archiving.json"]);
  assert.deepEqual(preferences.titleGenerationState(), legacy["web-ui-title-generation.json"]);
  assert.deepEqual(preferences.openAIUsageState(), { enabled: false });
  assert.deepEqual(preferences.fullSearchState(), { enabled: true });
  assert.deepEqual(preferences.recentCwdList(), ["C:/one", "C:/two"]);
});

test("independent consents preserve each other's state and timestamps", async () => {
  const enabledAt = preferences.titleGenerationState().enabledAt;
  await preferences.setLunaTitleFallbackEnabled(true);
  const titleState = preferences.titleGenerationState();
  assert.equal(titleState.enabled, true);
  assert.equal(titleState.enabledAt, enabledAt);
  assert.equal(titleState.lunaTitleFallback, true);
  assert.equal(typeof titleState.lunaTitleFallbackEnabledAt, "string");

  await preferences.setOpenAIUsageEnabled(true);
  assert.deepEqual(preferences.openAIUsageState(), { enabled: true });
  assert.deepEqual(preferences.titleGenerationState(), titleState);
});

test("missing preference files restore each store's own defaults", async () => {
  await Promise.all(preferenceFiles.map((name) => rm(path.join(agentDir, name), { force: true })));
  await preferences.loadPreferences();

  assert.deepEqual(preferences.agentBootstrapState(), { tools: null });
  assert.deepEqual(preferences.archivingState(), { enabled: true, firstRunArchivedAt: null });
  assert.deepEqual(preferences.titleGenerationState(), {
    enabled: false,
    enabledAt: null,
    lunaTitleFallback: false,
    lunaTitleFallbackEnabledAt: null,
  });
  assert.deepEqual(preferences.openAIUsageState(), { enabled: false });
  assert.deepEqual(preferences.fullSearchState(), { enabled: false });
  assert.deepEqual(preferences.recentCwdList(), []);
});

test("settings schema still resolves the installed SDK documentation", async () => {
  const schema = await preferences.settingsSchema();
  assert.ok(schema.length > 0);
  assert.ok(schema.some((section) => section.items.length > 0));
});
