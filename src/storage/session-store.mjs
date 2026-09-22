/**
 * Session persistence: chat identities, favorites, status and session logs.
 * UI preferences and shared paths live under src/storage; this module keeps the
 * policies that depend on pi's SessionManager next to the session state.
 */
import path from "node:path";
import readline from "node:readline";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AGENT_DIR, SESSIONS_DIR } from "./agent-paths.mjs";
import { jsonFile, mutationQueue } from "./json-store.mjs";
import {
  archivingState,
  isArchivingEnabled,
  markFirstRunArchivingComplete,
} from "./preferences.mjs";

const PERSISTED_SESSION_STATUSES = ["done", "reopened"];
export const SESSION_STATUS_INPUTS = [...PERSISTED_SESSION_STATUSES, "active"];

// ---- favorite chats -------------------------------------------------------
const favoritesStore = jsonFile(path.join(AGENT_DIR, "web-ui-favorites.json"), {
  fallback: () => [],
  revive: (raw) => (Array.isArray(raw) ? raw.filter((entry) => typeof entry === "string") : undefined),
});
let favorites = new Set();
const mutateFavorites = mutationQueue();
async function loadFavorites() {
  favorites = new Set(await favoritesStore.load());
}
export const listFavorites = () => [...favorites];
export const isFavorite = (chatPath) => favorites.has(chatPath);
export function setFavorite(chatPath, favorite) {
  return mutateFavorites(async () => {
    const next = new Set(favorites);
    if (favorite) next.add(chatPath);
    else next.delete(chatPath);
    await favoritesStore.save([...next]);
    favorites = next;
  });
}

// ---- session status: done / reopened -------------------------------------
// Indexed by session file path: a draft chat has no persisted status.
const sessionStatusStore = jsonFile(path.join(AGENT_DIR, "web-ui-status.json"), {
  fallback: () => [],
  revive: (raw) =>
    raw && typeof raw === "object"
      ? Object.entries(raw).filter(([, value]) => PERSISTED_SESSION_STATUSES.includes(value))
      : undefined,
});
let sessionStatus = new Map();
const mutateSessionStatus = mutationQueue();
async function loadSessionStatus() {
  sessionStatus = new Map(await sessionStatusStore.load());
}
export const sessionStatusOf = (chatPath) => sessionStatus.get(chatPath) ?? "active";
export function setSessionStatus(chatPath, status) {
  return mutateSessionStatus(async () => {
    const next = new Map(sessionStatus);
    if (status === "active") next.delete(chatPath);
    else next.set(chatPath, status);
    await sessionStatusStore.save(Object.fromEntries(next));
    sessionStatus = next;
  });
}

// ---- archiving policy -----------------------------------------------------
const ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000;
export function archiveStaleChats(now = Date.now()) {
  return mutateSessionStatus(async () => {
    const sessions = await SessionManager.listAll();
    const next = new Map(sessionStatus);
    let archived = 0;
    for (const session of sessions) {
      if (!session?.path || next.get(session.path) === "done") continue;
      const lastActivity = new Date(session.modified).getTime();
      if (!Number.isFinite(lastActivity) || now - lastActivity < ARCHIVE_AFTER_MS) continue;
      next.set(session.path, "done");
      archived += 1;
    }
    if (archived) {
      await sessionStatusStore.save(Object.fromEntries(next));
      sessionStatus = next;
    }
    return archived;
  });
}

// The completion timestamp is persisted only after the first sweep succeeds.
export async function runFirstRunArchiving() {
  const preference = archivingState();
  if (!preference.enabled || preference.firstRunArchivedAt) return;
  try {
    await archiveStaleChats();
    if (isArchivingEnabled() && !archivingState().firstRunArchivedAt) {
      await markFirstRunArchivingComplete();
    }
  } catch (error) {
    console.error("first-run chat archiving failed:", error?.message ?? error);
  }
}

export async function loadSessionState() {
  await Promise.all([loadFavorites(), loadSessionStatus()]);
}

// ---- session log files ----------------------------------------------------
// Yield one parsed JSON record per line without loading the file in memory.
export async function* readSessionRecords(file) {
  const input = createReadStream(file, "utf8");
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // Skip malformed records while preserving the readable rest of a log.
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

export async function listSessionFiles() {
  const output = [];
  let directories;
  try {
    directories = await readdir(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of directories) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(SESSIONS_DIR, entry.name);
    let files;
    try {
      files = await readdir(directory);
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.endsWith(".jsonl")) output.push(path.join(directory, file));
    }
  }
  return output;
}
