// The settings preview of the two work styles. A short scripted run plays
// through the real work blocks, so the preview is exactly what a chat shows.
import { createWorkBlocks, toolVerb } from './work-blocks.js';

const ICON_KINDS = { read: 'read', bash: 'bash', edit: 'edit', grep: 'search' };
const SCRIPT = [
  { thought: '**Locating the send state**\n\nSend is enabled from the textarea value only. Find where `sendBtn.disabled` is set.' },
  { tool: 'grep', target: 'sendBtn.disabled public/', result: '3 matches', ms: 900 },
  { tool: 'read', target: 'public/app.js', result: '61 lines', ms: 700 },
  { text: 'Send only looks at the typed text. Checking how attachments are added.' },
  { thought: 'Adding an attachment never calls `updateSendState()`, so an image alone leaves Send disabled.' },
  { tool: 'edit', target: 'public/attachments.js', result: '+2 −0', ms: 800 },
  { tool: 'bash', target: 'npm test', result: '148 passed', ms: 1600 },
  { text: 'Fixed: adding or removing an attachment now updates the Send button.' },
];

let session = 0;

/**
 * Plays the scripted run into root in the given style, replacing any run in progress.
 * @param {HTMLElement} root
 * @param {string} style
 */
export function playWorkStyleDemo(root, style) {
  const id = ++session;
  const documentRef = root.ownerDocument;
  const alive = () => id === session && root.isConnected;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const startedAt = Date.now();
  const work = createWorkBlocks({
    documentRef,
    root,
    later: setTimeout,
    inHistory: () => false,
    runStartedAt: () => startedAt,
    workStyle: () => style,
  });
  const el = (tag, className, text) => {
    const node = documentRef.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const turn = (role) => {
    const node = el('div', `turn ${role}`);
    const body = el('div', 'body');
    node.appendChild(body);
    root.appendChild(node);
    return body;
  };
  const stream = async (text, onText) => {
    for (let end = 3; alive(); end += 3) {
      onText(text.slice(0, end));
      if (end >= text.length) return;
      await sleep(22);
    }
  };

  root.replaceChildren();
  root.onclick = (event) => work.handleClick(event.target);
  turn('user').appendChild(el('div', 'msg user', 'Why does Send stay disabled after attaching an image?'));
  const body = turn('pi');
  const ticker = setInterval(() => (alive() ? work.tick() : clearInterval(ticker)), 1000);

  (async () => {
    for (const step of SCRIPT) {
      if (!alive()) break;
      if (step.thought) {
        const thought = work.addThought(body);
        let shown = '';
        await stream(step.thought, (text) => {
          work.appendThought(thought, text.slice(shown.length));
          shown = text;
        });
        await sleep(300);
      } else if (step.tool) {
        const card = toolCard(el, step);
        work.addTool(body, card);
        await sleep(step.ms);
        card.classList.replace('running', 'done');
        card.querySelector('.nm').textContent = toolVerb(step.tool, true);
        card.querySelector('.toolResult').textContent = step.result;
        work.toolChanged(card);
        await sleep(250);
      } else {
        work.textStarted();
        const message = el('div', 'msg assistant md');
        const paragraph = el('p', '');
        message.appendChild(paragraph);
        body.appendChild(message);
        await stream(step.text, (text) => {
          message.dataset.raw = text;
          paragraph.textContent = text;
        });
        await sleep(700);
      }
    }
    if (alive()) work.finishAll();
    clearInterval(ticker);
  })();
}

function toolCard(el, step) {
  const card = el('div', 'toolCard running');
  card.dataset.tool = step.tool;
  const head = el('div', 'toolHead');
  const icon = el('span', 'toolIcon');
  icon.dataset.kind = ICON_KINDS[step.tool] ?? 'other';
  const title = el('span', 'toolTitle');
  title.append(el('span', 'nm', toolVerb(step.tool, false)), el('span', 'sm', step.target));
  head.append(icon, title, el('span', 'toolResult', ''));
  card.appendChild(head);
  return card;
}
