import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { createReadToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition } from '@earendil-works/pi-coding-agent';
import { AGENT_DIR } from '../storage/agent-paths.mjs';
import { DebateError } from '../../public/debate-contract.js';

export const DEBATE_TOOL_NAMES = ['read', 'grep', 'find', 'ls'];
function within(target, root) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** The tool allowlist is enforced by the SDK; paths also stay inside the selected project. */
export async function createDebateTools(cwd) {
  const root = await realpath(cwd);
  let agentDir = path.resolve(AGENT_DIR);
  try { agentDir = await realpath(agentDir); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (within(agentDir, root) || within(root, agentDir)) {
    throw new DebateError('unsafe_project_folder', 'Choose a project folder separate from Pi configuration.', 409);
  }
  const definitions = [createReadToolDefinition(root), createGrepToolDefinition(root), createFindToolDefinition(root), createLsToolDefinition(root)];
  return definitions.map((definition) => ({
    ...definition,
    async execute(id, args, signal, update, context) {
      signal?.throwIfAborted();
      const target = await realpath(path.resolve(root, args.path || '.'));
      if (!within(target, root) || within(target, agentDir)) {
        throw new DebateError('path_outside_project', 'Read-only exploration is restricted to the selected project.', 403);
      }
      return definition.execute(id, { ...args, path: target }, signal, update, context);
    },
  }));
}
