import { createAgentSession, createExtensionRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { DebateError } from '../../public/debate-contract.js';
import { debateSystemPrompt, debateUserText, requireCompleteAnswer } from './debate-protocol.mjs';
import { supportedThinkingLevels } from './contexts.mjs';
import { createDebateTools, DEBATE_TOOL_NAMES } from './debate-tools.mjs';

export function validateDebateModels(config, runtime, images = []) {
  for (const name of ['A', 'B']) {
    const selected = config[name];
    const model = runtime.getModel(selected.provider, selected.model);
    if (!model || !runtime.hasConfiguredAuth(model.provider)) {
      throw new DebateError('model_unavailable', `Agent ${name}: the selected model is not available or authenticated.`, 409);
    }
    if (images.length && !model.input.includes('image')) {
      throw new DebateError('images_unsupported', `Agent ${name}: the selected model does not support image attachments.`, 409);
    }
    if (!supportedThinkingLevels(model).includes(selected.effort)) {
      throw new DebateError('effort_unsupported', `Agent ${name}: the selected effort is not supported.`, 409);
    }
  }
}

/** No discovery: even APPEND_SYSTEM.md and extension hooks must stay out of debates. */
export function debateResources(agent, rounds) {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => debateSystemPrompt(agent, rounds),
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export async function createDebateAgent({ config, turns, agent, runtime }) {
  const selected = config[agent];
  const manager = SessionManager.inMemory(config.cwd);
  for (const turn of turns) {
    if (turn.key[0] !== agent) continue;
    manager.appendMessage(turn.user);
    for (const message of turn.intermediate) manager.appendMessage(message);
    manager.appendMessage(turn.assistant);
  }
  const { session } = await createAgentSession({
    cwd: config.cwd,
    modelRuntime: runtime,
    model: runtime.getModel(selected.provider, selected.model),
    thinkingLevel: selected.effort,
    tools: [...DEBATE_TOOL_NAMES],
    customTools: await createDebateTools(config.cwd),
    resourceLoader: debateResources(agent, config.rounds),
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false, provider: { maxRetries: 0 } },
      enableInstallTelemetry: false,
      enableAnalytics: false,
    }),
  });
  if (session.model?.id !== selected.model || session.model?.provider !== selected.provider || session.thinkingLevel !== selected.effort) {
    session.dispose();
    throw new DebateError('model_configuration_changed', `Agent ${agent}: Pi changed the requested model or effort.`, 409);
  }
  return {
    async answer(prompt, onText, { images = [], onActivity = (_activity) => {} } = {}) {
      const from = session.messages.length;
      const unsubscribe = session.subscribe((event) => {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') onText(event.assistantMessageEvent.delta);
        if (event.type === 'tool_execution_start') {
          const activity = DEBATE_TOOL_NAMES.includes(event.toolName) ? `Exploring with ${event.toolName}` : 'Unsupported tool request';
          onActivity(activity);
        }
        if (event.type === 'tool_execution_end') onActivity(event.isError ? 'Read-only exploration failed' : 'Considering the findings');
      });
      try {
        await session.prompt(prompt, { expandPromptTemplates: false, images: images.map(({ data, mimeType }) => ({ type: 'image', data, mimeType })) });
        const added = session.messages.slice(from);
        const assistant = requireCompleteAnswer(added.findLast((message) => message.role === 'assistant'));
        const user = added.find((message) => message.role === 'user');
        if (!user || debateUserText(user) !== prompt) {
          throw new DebateError('prompt_changed', 'The delivered prompt did not match the debate protocol.', 502);
        }
        return { user, assistant, intermediate: added.slice(1, -1) };
      } finally { unsubscribe(); }
    },
    abort: () => session.abort(),
    dispose: () => session.dispose(),
  };
}
