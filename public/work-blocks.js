// A work block folds one stretch of the model's work (reasoning, tool calls and
// the short updates it writes between them) behind a single summary row.
// Three levels share one list: closed shows the summary, peek the latest
// reasoning paragraph and tool call, full every step. All state lives in the
// DOM, so parked chat snapshots and history rebuilds need no side tables.
//
// Two styles decide where the updates go. 'block' folds them in as chapters
// and lets the latest one lead the summary; 'flow' leaves them in the chat, so
// each stretch of work between two updates becomes a block of its own.

const NEXT_LEVEL = { closed: 'peek', peek: 'full', full: 'closed' };
const ANIMATION_MS = 380;
const TOOL_VERBS = {
  read: ['Reading', 'Read'], bash: ['Running', 'Ran'], edit: ['Editing', 'Edited'],
  write: ['Writing', 'Wrote'], grep: ['Searching', 'Searched'], find: ['Searching', 'Searched'],
  search: ['Searching', 'Searched'], ls: ['Listing', 'Listed'],
  web: ['Fetching', 'Fetched'], fetch: ['Fetching', 'Fetched'],
};
const TOOL_NOUNS = {
  read: ['read', 'reads'], bash: ['command', 'commands'], edit: ['edit', 'edits'],
  write: ['write', 'writes'], grep: ['search', 'searches'], find: ['search', 'searches'],
  search: ['search', 'searches'], ls: ['listing', 'listings'],
  web: ['fetch', 'fetches'], fetch: ['fetch', 'fetches'],
};
const ICON_CHECK = '<svg class="wbCheck" width="14" height="14" viewBox="0 0 16 16"><path d="M3.5 8.5l3 3L12.5 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CHEVRON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

/** Label for a tool call: a verb for the built-in tools, the raw name otherwise. */
export function toolVerb(name, done) {
  const verbs = TOOL_VERBS[name];
  return verbs ? verbs[done ? 1 : 0] : String(name ?? 'tool');
}

function plural(count, [one, many]) {
  return `${count} ${count === 1 ? one : many}`;
}

function clock(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function duration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** First readable line of a markdown message, without the markup. */
function plainFirstLine(markdown) {
  const line = String(markdown ?? '').split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? '';
  return line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits reasoning into paragraphs; a paragraph that is only bold text is a heading. */
function thoughtParagraphs(raw) {
  return String(raw ?? '').split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean).map((part) => {
    const heading = /^\*\*([^*]+)\*\*$/.exec(part);
    return heading
      ? { text: heading[1].replace(/\s+/g, ' ').trim(), heading: true }
      : { text: part.replace(/\*\*/g, ''), heading: false };
  });
}

/**
 * @param {{
 *   documentRef: Document,
 *   root: HTMLElement,
 *   later: (callback: () => void, delay: number) => any,
 *   inHistory: () => boolean,
 *   runStartedAt: () => number|null|undefined,
 *   workStyle?: () => string,
 *   now?: () => number,
 * }} options
 */
export function createWorkBlocks({
  documentRef, root, later, inHistory, runStartedAt, workStyle = () => 'block', now = Date.now,
}) {
  let historyClock = null;
  const inFlow = () => workStyle() === 'flow';

  function el(tag, className, text) {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** A grid row that animates between 0fr and 1fr; the clip keeps margins inside. */
  function fold(className, child) {
    const wrapper = el('div', `wbFold ${className}`);
    const clip = el('div', 'wbClip');
    clip.appendChild(child);
    wrapper.appendChild(clip);
    return wrapper;
  }

  /** Plays an entry animation once; removing the class keeps restores from replaying it. */
  function enter(node) {
    if (inHistory()) return;
    node.classList.add('wbEnter');
    later(() => node.classList.remove('wbEnter'), ANIMATION_MS);
  }

  function parts(block) {
    const [head, body] = block.children;
    const [glyph, headline, meta] = head.children;
    const [steps, foot] = body.firstElementChild.firstElementChild.children;
    return { head, glyph, headline, meta, steps, foot, more: foot.firstElementChild };
  }

  function createBlock() {
    const block = el('section', 'workBlock');
    block.dataset.level = 'closed';
    const head = el('button', 'wbHead');
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');
    const glyph = el('span', 'wbGlyph');
    glyph.setAttribute('aria-hidden', 'true');
    glyph.innerHTML = `<span class="wbSpin"></span>${ICON_CHECK}`;
    const chevron = el('span', 'wbChevron');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = ICON_CHEVRON;
    head.append(glyph, el('span', 'wbHeadline'), el('span', 'wbMeta'), chevron);
    const content = el('div');
    const foot = el('div', 'wbFoot');
    const more = el('button', 'wbMore');
    more.type = 'button';
    foot.appendChild(more);
    content.append(el('div', 'wbSteps'), foot);
    block.append(head, fold('wbBody', content));
    if (historyClock?.started != null) block.dataset.started = String(historyClock.started);
    return block;
  }

  function isAssistantText(node) {
    return node.classList.contains('msg') && node.classList.contains('assistant');
  }

  function isAbsorbable(node) {
    const classes = node.classList;
    return classes.contains('msgMeta') || classes.contains('msgActions') || isAssistantText(node);
  }

  function step(kind, content, { node = true } = {}) {
    const inner = el('div', 'wbStepIn');
    if (node) {
      const dot = el('span', 'wbNode');
      dot.setAttribute('aria-hidden', 'true');
      inner.appendChild(dot);
    }
    inner.appendChild(content);
    const wrapper = fold(`wbStep ${kind}`, inner);
    enter(wrapper);
    return wrapper;
  }

  /** Assistant text followed by more work was an interim update, not the answer. */
  function absorb(block, node) {
    const { steps } = parts(block);
    if (!node.classList.contains('assistant')) {
      steps.appendChild(node);
      return;
    }
    const height = inHistory() ? 0 : node.offsetHeight;
    if (height && node.parentNode && typeof node.cloneNode === 'function') {
      // The text leaves the flow with a collapse instead of a jump.
      const ghost = node.cloneNode(true);
      ghost.classList.add('wbGhost');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.style.height = `${height}px`;
      node.parentNode.insertBefore(ghost, node);
      later(() => ghost.remove(), ANIMATION_MS);
    }
    steps.appendChild(step('wbUpdate', node));
  }

  /** Returns the block the next step of body belongs to, creating it when needed. */
  function blockFor(body) {
    let trailing = [];
    let node = body.lastElementChild;
    while (node && isAbsorbable(node)) {
      trailing.unshift(node);
      node = node.previousElementSibling;
    }
    // In the flow style an update stays where it is and closes the stretch before it.
    const afterUpdate = inFlow() && trailing.some(isAssistantText);
    let block = !afterUpdate && node?.classList.contains('workBlock') ? node : null;
    if (!block) {
      block = createBlock();
      // The first stretch of a run shares its clock; one after an update starts now.
      if (!inHistory()) block.dataset.started = String((afterUpdate ? null : runStartedAt()) ?? now());
      if (afterUpdate) {
        body.appendChild(block);
        trailing = [];
      } else if (node) body.insertBefore(block, node.nextElementSibling);
      else body.prepend(block);
    }
    for (const item of trailing) absorb(block, item);
    if (historyClock?.ended != null) block.dataset.ended = String(historyClock.ended);
    if (!inHistory()) markLive(block);
    return block;
  }

  function addStep(body, kind, content, options) {
    const block = blockFor(body);
    parts(block).steps.appendChild(step(kind, content, options));
    if (!inHistory()) refresh(block);
    return block;
  }

  function addThought(body, text = '') {
    const thought = el('div', 'thinking');
    thought.dataset.rawText = '';
    addStep(body, 'wbThought', thought);
    if (text) appendThought(thought, text);
    return thought;
  }

  function renderInline(target, text) {
    target.replaceChildren();
    for (const piece of text.split(/(`[^`\n]+`)/)) {
      if (/^`[^`\n]+`$/.test(piece)) target.appendChild(el('code', null, piece.slice(1, -1)));
      else if (piece) target.appendChild(documentRef.createTextNode(piece));
    }
  }

  function appendThought(thought, delta) {
    thought.dataset.rawText = (thought.dataset.rawText ?? '') + delta;
    const paragraphs = thoughtParagraphs(thought.dataset.rawText);
    const rendered = [...thought.children];
    paragraphs.forEach((paragraph, index) => {
      let wrapper = rendered[index];
      if (!wrapper) {
        wrapper = fold('wbPara', el('p'));
        enter(wrapper);
        thought.appendChild(wrapper);
      }
      const source = `${paragraph.heading ? '#' : ''}${paragraph.text}`;
      if (wrapper.dataset.source === source) return;
      wrapper.dataset.source = source;
      wrapper.classList.toggle('isHeading', paragraph.heading);
      renderInline(wrapper.firstElementChild.firstElementChild, paragraph.text);
    });
    for (const extra of rendered.slice(paragraphs.length)) extra.remove();
    const title = paragraphs.filter((paragraph) => paragraph.heading).at(-1)?.text;
    if (title) thought.dataset.title = title;
    else delete thought.dataset.title;
    const block = thought.closest('.workBlock');
    if (!block || inHistory()) return;
    // A new paragraph can change what peek hides; otherwise only the summary moves.
    if (paragraphs.length !== rendered.length) refresh(block);
    else renderSummary(block);
  }

  function addTool(body, card) {
    addStep(body, 'wbTool', card, { node: false });
  }

  function toolChanged(card) {
    const block = card.closest('.workBlock');
    if (block && !inHistory()) refresh(block);
  }

  function stepsOf(block) {
    return [...parts(block).steps.children].filter((node) => node.classList.contains('wbStep'));
  }

  function toolCards(block) {
    return stepsOf(block).filter((node) => node.classList.contains('wbTool'))
      .map((node) => node.querySelector('.toolCard')).filter(Boolean);
  }

  /** The tail is the last thought and the last tool call after the latest update. */
  function markTail(block) {
    const steps = stepsOf(block);
    const lastUpdate = steps.map((node) => node.classList.contains('wbUpdate')).lastIndexOf(true);
    let tool = -1;
    let thought = -1;
    steps.forEach((node, index) => {
      if (index <= lastUpdate) return;
      if (node.classList.contains('wbTool')) tool = index;
      if (node.classList.contains('wbThought')) thought = index;
    });
    if (tool < 0 && thought < 0) tool = lastUpdate;
    let hidden = 0;
    steps.forEach((node, index) => {
      const tail = index === tool || index === thought;
      node.classList.toggle('isTail', tail);
      if (!tail) hidden += 1;
      else if (index === thought) hidden += Math.max(0, (node.querySelector('.thinking')?.children.length ?? 0) - 1);
    });
    return { steps: steps.length, hidden };
  }

  function toolLabel(card) {
    const summary = card.querySelector('.sm')?.textContent ?? '';
    return `${toolVerb(card.dataset.tool, !card.classList.contains('running'))} ${summary}`.trim();
  }

  function titles(block) {
    return stepsOf(block).map((node) => node.querySelector('.thinking')?.dataset.title).filter(Boolean);
  }

  function liveHeadline(block) {
    const steps = stepsOf(block);
    const update = steps.filter((node) => node.classList.contains('wbUpdate')).at(-1);
    const updateText = update ? plainFirstLine(update.querySelector('.msg')?.dataset.raw) : '';
    if (updateText) return updateText;
    // Without updates to lead it, the flow style names the latest step that has a name.
    if (inFlow()) {
      for (const node of steps.toReversed()) {
        const card = node.querySelector('.toolCard');
        if (card) return toolLabel(card);
        const heading = node.querySelector('.thinking')?.dataset.title;
        if (heading) return heading;
      }
      return 'Thinking';
    }
    const cards = toolCards(block);
    const running = cards.find((card) => card.classList.contains('running'));
    const title = titles(block).at(-1);
    if (title) return title;
    // A finished tool keeps the row until the next one, so it doesn't flicker back to "Thinking".
    const card = running ?? cards.at(-1);
    return card ? toolLabel(card) : 'Thinking';
  }

  function stamp(block, name) {
    const value = block.dataset[name] ? Number(block.dataset[name]) : NaN;
    return Number.isFinite(value) ? value : null;
  }

  function elapsed(block) {
    const started = stamp(block, 'started');
    const ended = stamp(block, 'ended');
    return started === null || ended === null ? null : ended - started;
  }

  function doneHeadline(block) {
    const cards = toolCards(block);
    const verb = cards.length ? 'Worked' : 'Thought';
    const ms = elapsed(block);
    const timed = ms === null ? verb : `${verb} for ${duration(ms)}`;
    if (!inFlow()) return timed;
    // A short stretch reads best by what it did: its heading, its one tool or its tools.
    const title = titles(block)[0];
    if (title) return title;
    if (cards.length === 1) return toolLabel(cards[0]);
    return cards.length ? breakdown(cards).join(' · ') : timed;
  }

  function breakdown(cards) {
    const counts = new Map();
    for (const card of cards) counts.set(card.dataset.tool, (counts.get(card.dataset.tool) ?? 0) + 1);
    return [...counts].map(([name, count]) => plural(count, TOOL_NOUNS[name] ?? [name, name]));
  }

  /** History and live creation stamp their own start; a rebuilt running block takes the run's. */
  function liveStart(block) {
    const known = stamp(block, 'started');
    if (known !== null) return known;
    const run = runStartedAt();
    if (!Number.isFinite(run)) return null;
    block.dataset.started = String(run);
    return run;
  }

  function renderMeta(block) {
    const { meta } = parts(block);
    const cards = toolCards(block);
    const failed = cards.filter((card) => card.classList.contains('error')).length;
    const tools = cards.length ? plural(cards.length, ['tool', 'tools']) : null;
    const ms = elapsed(block);
    let items;
    if (block.classList.contains('live')) items = [tools, clock(now() - (liveStart(block) ?? now()))];
    // A heading leaves the tools unnamed, so the count joins the duration.
    else if (inFlow()) items = [titles(block).length ? tools : null, ms === null ? null : duration(ms)];
    else items = breakdown(cards);
    meta.replaceChildren();
    meta.appendChild(documentRef.createTextNode(items.filter(Boolean).join(' · ')));
    if (failed) meta.appendChild(el('span', 'wbFailed', ` · ${failed} failed`));
  }

  function setHeadline(block, text) {
    const { headline } = parts(block);
    if (headline.dataset.text === text) return;
    headline.dataset.text = text;
    const line = el('span', 'wbLine', text);
    line.title = text;
    const previous = [...headline.children];
    if (inHistory() || !previous.length) {
      headline.replaceChildren(line);
      return;
    }
    for (const old of previous) {
      old.classList.add('wbLeave');
      later(() => old.remove(), ANIMATION_MS);
    }
    enter(line);
    headline.appendChild(line);
  }

  function renderSummary(block) {
    setHeadline(block, block.classList.contains('live') ? liveHeadline(block) : doneHeadline(block));
    renderMeta(block);
  }

  function refresh(block) {
    const { hidden, steps } = markTail(block);
    const { foot, more, head } = parts(block);
    const level = block.dataset.level;
    foot.hidden = level === 'closed' || (level === 'peek' && hidden === 0);
    more.textContent = level === 'full' ? 'Show less' : `Show all ${plural(steps, ['step', 'steps'])}`;
    head.setAttribute('aria-expanded', String(level !== 'closed'));
    renderSummary(block);
  }

  function setLevel(block, level) {
    block.dataset.level = level;
    refresh(block);
  }

  function markLive(block) {
    let superseded = false;
    for (const other of root.querySelectorAll('.workBlock.live')) {
      if (other === block) continue;
      finish(other);
      superseded = true;
    }
    if (block.classList.contains('live')) return;
    block.classList.add('live');
    delete block.dataset.ended;
    // The first block of a run shares the run's clock; a later one starts now.
    if (superseded) block.dataset.started = String(now());
  }

  function finish(block) {
    liveStart(block);
    block.dataset.ended = String(now());
    block.classList.remove('live');
    refresh(block);
  }

  return {
    addThought,
    appendThought,
    addTool,
    toolChanged,
    /** Messages render with their neighbours' timestamps so history knows each block's span. */
    setHistoryClock(started, ended) {
      historyClock = started == null && ended == null ? null : { started, ended };
    },
    /** A timestamp right after a block closes a work message, so it moves inside. */
    adoptMeta(meta) {
      const block = meta?.previousElementSibling;
      if (block?.classList.contains('workBlock')) parts(block).steps.appendChild(meta);
    },
    refreshAll(container) {
      for (const block of container.querySelectorAll('.workBlock')) refresh(block);
    },
    /** A history rebuild of a running turn: its last block keeps working. */
    resumeLast(body) {
      const blocks = body.querySelectorAll('.workBlock');
      const block = blocks[blocks.length - 1];
      if (!block) return;
      markLive(block);
      refresh(block);
    },
    finishAll() {
      for (const block of root.querySelectorAll('.workBlock.live')) finish(block);
    },
    /** In the flow style a reply or an update ends the stretch of work before it. */
    textStarted() {
      if (!inFlow()) return;
      for (const block of root.querySelectorAll('.workBlock.live')) finish(block);
    },
    tick() {
      for (const block of root.querySelectorAll('.workBlock.live')) renderMeta(block);
    },
    /** @returns {boolean} whether the click belonged to a work block */
    handleClick(target) {
      const more = target.closest('.wbMore');
      const head = more ? null : target.closest('.wbHead');
      const block = (more ?? head)?.closest('.workBlock');
      if (!block) return false;
      const level = block.dataset.level;
      setLevel(block, more ? (level === 'full' ? 'peek' : 'full') : NEXT_LEVEL[level] ?? 'closed');
      return true;
    },
  };
}
