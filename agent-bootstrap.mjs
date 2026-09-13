/**
 * The files and tool preferences that shape a pi session before its first
 * prompt. Paths sent by the browser are never trusted: every mutation/open
 * resolves an opaque id against a freshly discovered, server-owned catalog.
 */
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { AGENT_DIR } from "./session-store.mjs";

const MAX_EDIT_BYTES = 512 * 1024;
const ORIGINALS_DIR = path.join(AGENT_DIR, "web-ui-agent-bootstrap-originals");

export class AgentBootstrapError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const normalizedPath = (file) => {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
const resourceId = (file) => createHash("sha256").update(normalizedPath(file)).digest("hex").slice(0, 20);

function targetFiles(cwd) {
  return [
    { key: "global-agents", label: "Global AGENTS.md", scope: "global", kinds: ["context"], path: path.join(AGENT_DIR, "AGENTS.md") },
    { key: "global-system", label: "Global SYSTEM.md", scope: "global", kinds: ["system"], path: path.join(AGENT_DIR, "SYSTEM.md") },
    { key: "global-append", label: "Global APPEND_SYSTEM.md", scope: "global", kinds: ["append"], path: path.join(AGENT_DIR, "APPEND_SYSTEM.md") },
    { key: "project-agents", label: "Project AGENTS.md", scope: "project", kinds: ["context"], path: path.join(cwd, "AGENTS.md") },
    { key: "project-system", label: "Project SYSTEM.md", scope: "project", kinds: ["system"], path: path.join(cwd, ".pi", "SYSTEM.md") },
    { key: "project-append", label: "Project APPEND_SYSTEM.md", scope: "project", kinds: ["append"], path: path.join(cwd, ".pi", "APPEND_SYSTEM.md") },
  ].map((target, order) => ({ ...target, order }));
}

function inferredScope(file, cwd) {
  if (typeof file !== "string" || !file) return "inherited";
  const target = normalizedPath(file);
  const agentRoot = normalizedPath(AGENT_DIR) + path.sep;
  const projectRoot = normalizedPath(cwd) + path.sep;
  if (target.startsWith(agentRoot)) return "global";
  if (target.startsWith(projectRoot)) return "project";
  return "inherited";
}

function loaderScope(scope, file, cwd) {
  if (scope === "user") return "global";
  if (scope === "project") return "project";
  return inferredScope(file, cwd);
}

function addResource(catalog, file, kind, options = {}) {
  if (typeof file !== "string" || !file || file.startsWith("<")) return;
  const resolved = path.resolve(file);
  const key = normalizedPath(resolved);
  const previous = catalog.get(key);
  if (previous) {
    if (!previous.kinds.includes(kind)) previous.kinds.push(kind);
    if (options.active) previous.active = true;
    if (options.target) Object.assign(previous, options);
    return;
  }
  catalog.set(key, {
    id: resourceId(resolved),
    key: options.key ?? null,
    label: options.label ?? path.basename(resolved),
    path: resolved,
    scope: options.scope ?? "inherited",
    kinds: [kind],
    target: Boolean(options.target),
    active: Boolean(options.active),
    order: options.order ?? null,
  });
}

function resourceCatalog(session, cwd) {
  const loader = session.resourceLoader;
  const catalog = new Map();
  for (const target of targetFiles(cwd)) {
    addResource(catalog, target.path, target.kinds[0], { ...target, target: true });
  }
  for (const file of loader.getAgentsFiles().agentsFiles) {
    addResource(catalog, file.path, "context", { active: true, scope: inferredScope(file.path, cwd) });
  }
  const system = loader.getSystemPromptSource()?.path;
  if (system) addResource(catalog, system, "system", { active: true, scope: inferredScope(system, cwd) });
  for (const source of loader.getAppendSystemPromptSources()) {
    addResource(catalog, source.path, "append", { active: true, scope: inferredScope(source.path, cwd) });
  }
  for (const prompt of loader.getPrompts().prompts) {
    const file = prompt.sourceInfo?.path ?? prompt.filePath;
    addResource(catalog, file, "prompt", { active: true, scope: loaderScope(prompt.sourceInfo?.scope, file, cwd) });
  }
  for (const skill of loader.getSkills().skills) {
    const file = skill.sourceInfo?.path ?? skill.filePath;
    addResource(catalog, file, "skill", { active: true, scope: loaderScope(skill.sourceInfo?.scope, file, cwd) });
  }
  for (const extension of loader.getExtensions().extensions ?? []) {
    addResource(catalog, extension.path, "extension", {
      active: true,
      scope: loaderScope(extension.sourceInfo?.scope, extension.path, cwd),
    });
  }
  return catalog;
}

function projectContextSection(contextFiles) {
  if (!contextFiles?.length) return "";
  let section = "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
  for (const file of contextFiles) {
    section += `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
  }
  return `${section}</project_context>\n`;
}

function removeSuffix(value, suffix) {
  return suffix && value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
}

// Pi exposes the final generated prompt, but not the built-in prompt template
// as a standalone public value. Peel off the deterministic sections that Pi
// appends so a missing SYSTEM.md can start with the real built-in source rather
// than an empty editor. If Pi changes the shape, fall back to the exact prompt
// instead of showing a blank form.
function defaultSystemPromptSource(session, cwd) {
  const options = session._baseSystemPromptOptions;
  let prompt = session._baseSystemPrompt || session.systemPrompt || "";
  if (!options || options.customPrompt) return options?.customPrompt ?? prompt;
  prompt = removeSuffix(prompt, `\nCurrent working directory: ${cwd.replace(/\\/g, "/")}`);
  if (options.selectedTools?.includes("read") && options.skills?.length) {
    prompt = removeSuffix(prompt, formatSkillsForPrompt(options.skills));
  }
  prompt = removeSuffix(prompt, projectContextSection(options.contextFiles));
  if (options.appendSystemPrompt) prompt = removeSuffix(prompt, `\n\n${options.appendSystemPrompt}`);
  return prompt;
}

function originalPath(resource) {
  return path.join(ORIGINALS_DIR, `${resource.id}.json`);
}

async function readOriginal(resource) {
  try {
    const original = JSON.parse(await readFile(originalPath(resource), "utf8"));
    if (original?.version !== 1 || normalizedPath(original.path) !== normalizedPath(resource.path)) return null;
    if (typeof original.existed !== "boolean") return null;
    if (original.existed && typeof original.content !== "string") return null;
    return original;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function rememberOriginal(resource) {
  if (await readOriginal(resource)) return;
  let content = null;
  let existed = false;
  try {
    content = await readFile(resource.path, "utf8");
    existed = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(ORIGINALS_DIR, { recursive: true });
  const snapshot = JSON.stringify({ version: 1, path: resource.path, existed, content });
  try {
    await writeFile(originalPath(resource), snapshot, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

const canEditInline = (resource) => resource.kinds.some((kind) => ["context", "system", "append", "prompt"].includes(kind));

async function describeResource(resource) {
  let linkInfo = null;
  let info = null;
  try {
    linkInfo = await lstat(resource.path);
    info = linkInfo.isSymbolicLink() ? await stat(resource.path) : linkInfo;
  } catch {}
  const symlink = Boolean(linkInfo?.isSymbolicLink());
  const exists = Boolean(info?.isFile());
  const editable = canEditInline(resource);
  const tooLarge = Boolean(exists && editable && info.size > MAX_EDIT_BYTES);
  let content = null;
  if (exists && editable && !tooLarge) content = await readFile(resource.path, "utf8");
  const original = editable && !symlink ? await readOriginal(resource) : null;
  return { ...resource, exists, symlink, editable, tooLarge, content, canReset: Boolean(original) };
}

export async function agentBootstrapFiles(session, cwd) {
  const described = await Promise.all([...resourceCatalog(session, cwd).values()].map(describeResource));
  const globalSystem = described.find((file) => file.key === "global-system");
  if (globalSystem && !globalSystem.exists) {
    globalSystem.content = defaultSystemPromptSource(session, cwd);
    globalSystem.prefilled = true;
  }
  return described.sort((a, b) => {
    if (a.target !== b.target) return a.target ? -1 : 1;
    if (a.target && b.target) return (a.order ?? 0) - (b.order ?? 0);
    if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
    return a.path.localeCompare(b.path);
  });
}

export async function resolveAgentBootstrapFile(session, cwd, id) {
  if (typeof id !== "string" || !id) {
    throw new AgentBootstrapError(400, "missing_resource", "missing resource id");
  }
  const resource = [...resourceCatalog(session, cwd).values()].find((item) => item.id === id);
  if (!resource) throw new AgentBootstrapError(404, "resource_not_found", "resource is not part of this agent context");
  return describeResource(resource);
}

async function rejectSymlink(file) {
  try {
    if ((await lstat(file)).isSymbolicLink()) {
      throw new AgentBootstrapError(400, "symlink_not_editable", "symbolic-link resources cannot be edited here");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function saveAgentBootstrapFile(session, cwd, id, content) {
  if (typeof content !== "string") throw new AgentBootstrapError(400, "invalid_content", "content must be text");
  if (Buffer.byteLength(content, "utf8") > MAX_EDIT_BYTES) {
    throw new AgentBootstrapError(413, "content_too_large", "agent input files are limited to 512 KiB");
  }
  const resource = await resolveAgentBootstrapFile(session, cwd, id);
  if (!resource.editable) throw new AgentBootstrapError(400, "resource_read_only", "this resource is read-only in the settings editor");
  await rejectSymlink(resource.path);
  await rememberOriginal(resource);
  await mkdir(path.dirname(resource.path), { recursive: true });
  const temporary = `${resource.path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, resource.path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return resource.path;
}

export async function deleteAgentBootstrapFile(session, cwd, id) {
  const resource = await resolveAgentBootstrapFile(session, cwd, id);
  if (!resource.editable) throw new AgentBootstrapError(400, "resource_read_only", "this resource cannot be removed here");
  await rejectSymlink(resource.path);
  await rememberOriginal(resource);
  await rm(resource.path, { force: true });
  return resource.path;
}

export async function resetAgentBootstrapFile(session, cwd, id) {
  const resource = await resolveAgentBootstrapFile(session, cwd, id);
  if (!resource.editable) throw new AgentBootstrapError(400, "resource_read_only", "this resource cannot be restored here");
  await rejectSymlink(resource.path);
  const original = await readOriginal(resource);
  if (!original) return { path: resource.path, restored: false };
  if (!original.existed) {
    await rm(resource.path, { force: true });
  } else {
    await mkdir(path.dirname(resource.path), { recursive: true });
    const temporary = `${resource.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, original.content, "utf8");
      await rename(temporary, resource.path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
  return { path: resource.path, restored: true };
}

export function effectiveAgentPrompt(session) {
  return session._baseSystemPrompt || session.systemPrompt || "";
}
