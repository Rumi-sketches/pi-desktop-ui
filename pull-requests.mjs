const GH_PR_CREATE_RE = /\bgh\s+pr\s+create\b/;
const GITHUB_PR_URL_RE = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)\b/giu;

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Incrementally finds pull requests created by shell tool calls in a session log.
 * Only the public GitHub URL and numeric id survive; command output is discarded.
 */
export function createPullRequestTracker() {
  const createCalls = new Set();
  const pullRequests = new Map();

  return {
    accept(record) {
      if (record?.type !== "message") return;
      const message = record.message;
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          const command = block?.arguments?.command;
          if (block?.type === "toolCall" && block.name === "bash" && typeof block.id === "string"
              && typeof command === "string" && GH_PR_CREATE_RE.test(command)) {
            createCalls.add(block.id);
          }
        }
        return;
      }
      if (message?.role !== "toolResult" || message.isError || !createCalls.has(message.toolCallId)) return;
      const text = contentText(message.content);
      for (const match of text.matchAll(GITHUB_PR_URL_RE)) {
        const url = match[0].replace(/[),.;]+$/u, "");
        if (!pullRequests.has(url)) pullRequests.set(url, { number: Number(match[1]), url });
      }
    },
    values() {
      return [...pullRequests.values()];
    },
  };
}
