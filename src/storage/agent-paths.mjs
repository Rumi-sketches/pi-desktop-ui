import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";

// The override is deliberately test-only: this directory holds credentials,
// tokens and session logs, so production callers cannot redirect it through an
// environment variable to a location they control.
export const AGENT_DIR =
  (process.env.PI_WEB_UI_TEST === "1" ? process.env.PI_WEB_UI_AGENT_DIR : undefined)
  ?? path.join(os.homedir(), ".pi", "agent");
export const SETTINGS_PATH = path.join(AGENT_DIR, "settings.json");
export const SESSIONS_DIR = path.join(AGENT_DIR, "sessions");

// Normalize and verify that a path exists and is a directory.
export async function resolveDir(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("missing path");
  // These characters are legal in paths but are reinterpreted by the shells
  // used by the terminal integration. Refuse them at the shared boundary.
  if (/["&|^$%'`\n\r]/.test(input)) throw new Error("path contains forbidden characters");
  const resolved = path.resolve(input.trim());
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new Error(`directory not found: ${resolved}`);
  }
  if (!info.isDirectory()) throw new Error(`not a directory: ${resolved}`);
  return resolved;
}

// Normalize and verify that a path exists and is a file.
export async function resolveFile(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("missing path");
  const resolved = path.resolve(input.trim());
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new Error(`file not found: ${resolved}`);
  }
  if (!info.isFile()) throw new Error(`not a file: ${resolved}`);
  return resolved;
}

// Root plus separator prevents a sibling such as "sessions-evil" matching.
export function isInsideDir(filePath, root) {
  const prefix = root + path.sep;
  if (process.platform === "win32") {
    return filePath.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return filePath.startsWith(prefix);
}

// Files under the agent directory may contain secrets and session content and
// must never be exposed by the project diff API.
export function isAgentDirPath(filePath, agentDir = AGENT_DIR) {
  if (typeof filePath !== "string" || filePath.trim() === "") return false;
  return isInsideDir(path.resolve(filePath), agentDir);
}
