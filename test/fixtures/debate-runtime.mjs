// In-process provider stream for SDK, HTTP and browser tests. Never uses a credential or network.
export const fixtureModel = (id) => ({
  id, name: id, provider: 'debate-fixture', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1',
  reasoning: true, input: ['text', 'image'], contextWindow: 100000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
export const fixtureConfig = (cwd, rounds = 4) => ({
  prompt: 'Explore a library open all night.', cwd, rounds,
  A: { provider: 'debate-fixture', model: 'model-a', effort: 'medium' },
  B: { provider: 'debate-fixture', model: 'model-b', effort: 'high' },
});

export function fixtureRuntime({ calls = [], delay = 0, stopReason = 'stop', decorate = (text) => text, toolCall = null } = {}) {
  return {
    getModel(provider, id) { return provider === 'debate-fixture' && ['model-a', 'model-b'].includes(id) ? fixtureModel(id) : undefined; },
    hasConfiguredAuth: () => true,
    isUsingOAuth: () => false,
    async streamSimple(model, context, options) {
      calls.push({ model, context: structuredClone({ ...context,
        tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) }), options });
      const agent = model.id === 'model-a' ? 'A' : 'B';
      const round = context.messages.filter((message) => message.role === 'user').length;
      const requestedTool = toolCall && context.messages.at(-1)?.role === 'user' ? toolCall : null;
      const reply = decorate(`Response ${agent}${round}. Consider access, staffing and cost.`);
      /** @type {any} */
      const message = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason,
        content: [{ type: 'thinking', thinking: `private-${agent}`, thinkingSignature: `signature-${agent}` },
          { type: 'text', text: reply }],
        usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      if (requestedTool) {
        message.stopReason = 'toolUse';
        message.content = [{ type: 'toolCall', id: `call_${agent}_${round}`, name: requestedTool.name, arguments: requestedTool.arguments }];
      }
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'start', partial: { ...message, content: [] } };
          if (requestedTool) { yield { type: 'done', reason: 'toolUse', message }; return; }
          yield { type: 'text_start', contentIndex: 1, partial: message };
          yield { type: 'text_delta', contentIndex: 1, delta: reply.slice(0, 9), partial: message };
          if (delay) await new Promise((resolve) => {
            const finish = () => { clearTimeout(timer); options.signal.removeEventListener('abort', finish); resolve(undefined); };
            const timer = setTimeout(finish, delay);
            options.signal.addEventListener('abort', finish, { once: true });
            if (options.signal.aborted) finish();
          });
          if (options.signal?.aborted) message.stopReason = 'aborted';
          yield { type: 'text_delta', contentIndex: 1, delta: reply.slice(9), partial: message };
          yield { type: 'text_end', contentIndex: 1, content: message.content[1].text, partial: message };
          yield { type: 'done', reason: message.stopReason, message };
        },
        result: async () => message,
      };
    },
  };
}
