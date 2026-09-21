const SHELL_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GITHUB_PR_URL_RE = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)\b/giu;
const GITHUB_ISSUE_URL_RE = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/(\d+)\b/giu;

function shellCommandSegments(command) {
  const segments = [];
  let words = [];
  let word = "";
  let wordStarted = false;
  let quote = null;
  let comment = false;

  const finishWord = () => {
    if (!wordStarted) return;
    words.push(word);
    word = "";
    wordStarted = false;
  };
  const finishSegment = () => {
    finishWord();
    if (words.length) segments.push(words);
    words = [];
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (comment) {
      if (char === "\n") {
        comment = false;
        finishSegment();
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (quote === '"' && char === "\\" && i + 1 < command.length) {
        word += command[++i];
      } else {
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      wordStarted = true;
      continue;
    }
    if (char === "\\" && i + 1 < command.length) {
      wordStarted = true;
      word += command[++i];
      continue;
    }
    if (char === "#" && !wordStarted) {
      comment = true;
      continue;
    }
    if (/\s/u.test(char)) {
      finishWord();
      if (char === "\n") finishSegment();
      continue;
    }
    if (";|&(){}".includes(char)) {
      finishSegment();
      continue;
    }
    wordStarted = true;
    word += char;
  }
  finishSegment();
  return segments;
}

function invokesGhCreate(command, resource) {
  return shellCommandSegments(command).some((words) => {
    let index = 0;
    while (SHELL_ASSIGNMENT_RE.test(words[index] ?? "")) index += 1;
    return words[index] === "gh" && words[index + 1] === resource && words[index + 2] === "create";
  });
}

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
function createGitHubResourceTracker(resource, urlPattern) {
  const createCalls = new Set();
  const resources = new Map();

  return {
    accept(record) {
      if (record?.type !== "message") return;
      const message = record.message;
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          const command = block?.arguments?.command;
          if (block?.type === "toolCall" && block.name === "bash" && typeof block.id === "string"
              && typeof command === "string" && invokesGhCreate(command, resource)) {
            createCalls.add(block.id);
          }
        }
        return;
      }
      if (message?.role !== "toolResult" || message.isError || !createCalls.has(message.toolCallId)) return;
      const text = contentText(message.content);
      for (const match of text.matchAll(urlPattern)) {
        const url = match[0].replace(/[),.;]+$/u, "");
        if (!resources.has(url)) resources.set(url, { number: Number(match[1]), url });
      }
    },
    values() {
      return [...resources.values()];
    },
  };
}

export const createPullRequestTracker = () => createGitHubResourceTracker("pr", GITHUB_PR_URL_RE);
export const createIssueTracker = () => createGitHubResourceTracker("issue", GITHUB_ISSUE_URL_RE);
