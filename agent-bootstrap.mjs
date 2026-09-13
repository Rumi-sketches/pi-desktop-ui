/**
 * The files and tool preferences that shape a pi session before its first
 * prompt. Paths sent by the browser are never trusted: every mutation/open
 * resolves an opaque id against a freshly discovered, server-owned catalog.
 */
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { AGENT_DIR } from "./session-store.mjs";

const MAX_EDIT_BYTES = 512 * 1024;

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
    { key: "global-agents", label: "Global context", scope: "global", kinds: ["context"], path: path.join(AGENT_DIR, "AGENTS.md") },
    { key: "global-system", label: "Global system prompt", scope: "global", kinds: ["system"], path: path.join(AGENT_DIR, "SYSTEM.md") },
    { key: "global-append", label: "Global appended prompt", scope: "global", kinds: ["append"], path: path.join(AGENT_DIR, "APPEND_SYSTEM.md") },
    { key: "project-agents", label: "Project context", scope: "project", kinds: ["context"], path: path.join(cwd, "AGENTS.md") },
    { key: "project-system", label: "Project system prompt", scope: "project", kinds: ["system"], path: path.join(cwd, ".pi", "SYSTEM.md") },
    { key: "project-append", label: "Project appended prompt", scope: "project", kinds: ["append"], path: path.join(cwd, ".pi", "APPEND_SYSTEM.md") },
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
    addResource(catalog, file, "prompt", { active: true, scope: prompt.sourceInfo?.scope ?? inferredScope(file, cwd) });
  }
  for (const skill of loader.getSkills().skills) {
    const file = skill.sourceInfo?.path ?? skill.filePath;
    addResource(catalog, file, "skill", { active: true, scope: skill.sourceInfo?.scope ?? inferredScope(file, cwd) });
  }
  for (const extension of loader.getExtensions().extensions ?? []) {
    addResource(catalog, extension.path, "extension", { active: true, scope: inferredScope(extension.path, cwd) });
  }
  return catalog;
}

const canEditInline = (resource) => resource.kinds.some((kind) => ["context", "system", "append", "prompt"].includes(kind));

async function describeResource(resource) {
  let info = null;
  try {
    info = await lstat(resource.path);
  } catch {}
  const symlink = Boolean(info?.isSymbolicLink());
  const exists = Boolean(!symlink && info?.isFile());
  const editable = canEditInline(resource);
  const tooLarge = Boolean(exists && editable && info.size > MAX_EDIT_BYTES);
  let content = null;
  if (exists && editable && !tooLarge) content = await readFile(resource.path, "utf8");
  return { ...resource, exists, symlink, editable, tooLarge, content };
}

export async function agentBootstrapFiles(session, cwd) {
  const described = await Promise.all([...resourceCatalog(session, cwd).values()].map(describeResource));
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
  await rm(resource.path, { force: true });
  return resource.path;
}
