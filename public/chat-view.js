import { withSessionKey } from './transport.js';
import { showChatPreview } from './chat-previews.js';
import { createMathExtensions } from './chat-math.js';

export function decorateMarkdownAlert(quote, documentRef) {
  const first = quote.firstElementChild;
  const marker = first?.firstChild;
  if (first?.tagName !== 'P' || marker?.nodeType !== 3) return;
  const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]*\n?)?/i.exec(marker.nodeValue ?? '');
  if (!match) return;
  const kind = match[1].toLowerCase();
  quote.classList.add('mdAlert', `mdAlert-${kind}`);
  marker.nodeValue = marker.nodeValue.slice(match[0].length);
  const label = documentRef.createElement('strong');
  label.className = 'mdAlertLabel';
  label.textContent = match[1][0] + match[1].slice(1).toLowerCase();
  quote.prepend(label);
  if (!first.textContent.trim()) first.remove();
}

// Drive paths are handled by the guarded local-path click handler, not navigation.
// Escape the hyphen in the negated class: .-: would also swallow relative-path slashes.
const CHAT_URI_PATTERN = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|file|ms-settings):|[a-z]:(?:[\\/]|%5c|%2f)|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;
const ICON_COPY = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_CHECK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>';
const ICON_RUN = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';
const ICON_FORK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="2.3"/><circle cx="6" cy="18" r="2.3"/><circle cx="18" cy="12" r="2.3"/><path d="M6 8.3V15.7M8 7l7.5 3.5M8 17l7.5-3.5"/></svg>';
const SHELL_LANGS = ['bash', 'sh', 'shell', 'zsh', 'console', 'powershell', 'ps', 'ps1', 'pwsh', 'cmd', 'bat'];
const MARKDOWN_FLUSH_MS = 50;
const MESSAGE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[char]));

function requireFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

/**
 * Owns transcript DOM, tool and form presentation, scroll, and cached snapshots.
 * Importing this module is inert; listeners and timers begin only in start().
 * @param {{
 *   documentRef?: Document,
 *   windowRef?: Window & Record<string, any>,
 *   storage?: Storage|null,
 *   cache: any,
 *   getKey: () => string|null,
 *   getChatState: (key?: string|null) => any,
 *   getModels?: () => any[],
 *   getCommands?: () => any[],
 *   getPlatformCapabilities?: () => any,
 *   post: (url: string, body?: any, options?: any) => Promise<any>,
 *   toast: (message: string, ok?: boolean) => void,
 *   setAwaitingInput: (on: boolean, key?: string|null) => void,
 *   setHeroMode: (on: boolean) => void,
 *   forkFrom: (entryId: string) => Promise<any>|any,
 *   cancelQueuedPrompt: (id: string) => Promise<any>|any,
 *   openImage: (src: string, alt?: string) => void,
 *   requestHistoryPage: (before: number, key: string) => Promise<any>,
 *   isActiveKey: (key: string) => boolean,
 *   onToolEvent?: (event: any, key: string) => void,
 * }} options
 */
export function createChatView({
  documentRef = document,
  windowRef = /** @type {Window & Record<string, any>} */ (window),
  storage = windowRef.localStorage ?? windowRef.sessionStorage,
  cache,
  getKey,
  getChatState,
  getModels = () => [],
  getCommands = () => [],
  getPlatformCapabilities = () => null,
  post,
  toast,
  setAwaitingInput,
  setHeroMode,
  forkFrom,
  cancelQueuedPrompt,
  openImage,
  requestHistoryPage,
  isActiveKey,
  onToolEvent = () => {},
}) {
  requireFunction(getKey, 'getKey');
  requireFunction(getChatState, 'getChatState');
  requireFunction(post, 'post');
  requireFunction(toast, 'toast');
  requireFunction(setAwaitingInput, 'setAwaitingInput');
  requireFunction(setHeroMode, 'setHeroMode');
  requireFunction(forkFrom, 'forkFrom');
  requireFunction(cancelQueuedPrompt, 'cancelQueuedPrompt');
  requireFunction(openImage, 'openImage');
  requireFunction(requestHistoryPage, 'requestHistoryPage');
  requireFunction(isActiveKey, 'isActiveKey');

  const chat = documentRef.getElementById('chat');
  const chatWrap = documentRef.getElementById('chatWrap');
  const formDock = documentRef.getElementById('formDock');
  if (!chat || !chatWrap || !formDock) throw new Error('chat view roots are missing');
  /** @type {(selector: string, root?: ParentNode) => any[]} */
  const all = (selector, root = documentRef) => [...root.querySelectorAll(selector)];

  let started = false;
  let currentAssistant = null;
  let currentThinking = null;
  let currentTurn = null;
  let historyRoot = null;
  let pendingMarkdown = null;
  let markdownFlushTimer = null;
  let streamingMarkdown = null;
  let formControlSequence = 0;
  const toolCards = new Map();
  const formAnchors = new WeakMap();
  let persistedFormDrafts = {};

  function currentState() {
    return getChatState(getKey());
  }

  function configureMarkdown() {
    if (!windowRef.marked || windowRef.marked.__piChatViewConfigured) return;
    windowRef.marked.setOptions({ breaks: true, gfm: true });
    windowRef.marked.use({
      extensions: [...(windowRef.katex ? createMathExtensions(windowRef.katex) : []), {
        name: 'themeMark',
        level: 'inline',
        start(source) { return source.indexOf('=='); },
        tokenizer(source) {
          const match = /^==(?=\S)([\s\S]*?\S)==/.exec(source);
          if (match) return { type: 'themeMark', raw: match[0], text: match[1], tokens: this.lexer.inlineTokens(match[1]) };
        },
        renderer(token) { return `<mark>${this.parser.parseInline(token.tokens)}</mark>`; },
      }],
    });
    windowRef.marked.__piChatViewConfigured = true;
  }

  function loadFormDrafts() {
    // A form can outlive the desktop process. Keep typed answers with the
    // session identity, including drafts made before the storage switch.
    try { persistedFormDrafts = JSON.parse(storage?.getItem('piFormDrafts') ?? windowRef.sessionStorage?.getItem('piFormDrafts') ?? '{}'); }
    catch { persistedFormDrafts = {}; }
  }

  function saveFormDrafts() {
    try { storage?.setItem('piFormDrafts', JSON.stringify(persistedFormDrafts)); } catch {}
  }

  function atBottom() {
    return chatWrap.scrollHeight - chatWrap.scrollTop - chatWrap.clientHeight < 90;
  }

  function scrollDown() {
    chatWrap.scrollTop = chatWrap.scrollHeight;
  }

  function addChatListener(target, type, callback, listenerOptions) {
    const key = getKey();
    if (key) return cache.trackListener(key, target, type, callback, listenerOptions);
    target.addEventListener(type, callback, listenerOptions);
    return () => target.removeEventListener(type, callback, listenerOptions);
  }

  function addChatTimer(callback, delay) {
    const key = getKey();
    let untrack = () => {};
    const id = setTimeout(() => { untrack(); callback(); }, delay);
    if (key) untrack = cache.trackTimer(key, id, clearTimeout);
    return id;
  }

  function enhanceMarkdownStructure(div) {
    for (const quote of all('blockquote', div)) decorateMarkdownAlert(quote, documentRef);
  }

  function renderMarkdown(div, { decorate = true } = {}) {
    div.innerHTML = windowRef.marked && windowRef.DOMPurify
      ? windowRef.DOMPurify.sanitize(windowRef.marked.parse(div.dataset.raw ?? ''), { ALLOWED_URI_REGEXP: CHAT_URI_PATTERN })
      : esc(div.dataset.raw ?? '');
    enhanceMarkdownStructure(div);
    if (!decorate) return;
    const highlightLimit = 100_000;
    if (windowRef.hljs) {
      let highlighted = 0;
      for (const element of all('pre code', div)) {
        const language = [...element.classList].find((name) => name.startsWith('language-'))?.slice(9);
        if (!language || !windowRef.hljs.getLanguage(language)) continue;
        const size = element.textContent?.length ?? 0;
        if (size > 50_000 || highlighted + size > highlightLimit) continue;
        windowRef.hljs.highlightElement(element);
        highlighted += size;
      }
    }
    addCopyButtons(div);
  }

  function isLocalLink(href) {
    if (!href || href.startsWith('#')) return false;
    let decoded = href;
    try { decoded = decodeURIComponent(href); } catch {}
    if (/^(https?|mailto):/i.test(decoded)) return false;
    return !/^[a-z][a-z\d+.-]*:/i.test(decoded) || /^file:/i.test(decoded) || /^[a-z]:[\\/]/i.test(decoded);
  }

  async function copyToClipboard(text, button) {
    try {
      await windowRef.navigator.clipboard.writeText(text ?? '');
      if (button) flashCopied(button);
    } catch {
      toast('Copy failed (browser clipboard permissions)');
    }
  }

  function flashCopied(button) {
    if (button.dataset.flashing) return;
    button.dataset.flashing = '1';
    const previous = button.innerHTML;
    button.innerHTML = ICON_CHECK;
    button.classList.add('copied');
    addChatTimer(() => {
      button.innerHTML = previous;
      button.classList.remove('copied');
      delete button.dataset.flashing;
    }, 1200);
  }

  function shellCommandOf(pre) {
    const code = pre.querySelector('code');
    const text = (code ? code.textContent : pre.textContent).trim();
    if (!text || text.includes('\n') || text.length > 2000) return null;
    const language = [...(code?.classList ?? [])]
      .map((name) => name.replace(/^(language|lang)-/, ''))
      .find((name) => name !== 'hljs' && name !== '');
    if (language && !SHELL_LANGS.includes(language.toLowerCase())) return null;
    return text;
  }

  function addRunButton(wrapper, pre) {
    if (!getPlatformCapabilities()?.typeInTerminal) return;
    const command = shellCommandOf(pre);
    if (!command) return;
    const run = documentRef.createElement('button');
    run.type = 'button';
    run.className = 'codeRunBtn';
    run.title = 'Open a terminal with this command typed in — it is not executed';
    run.innerHTML = ICON_RUN;
    run.dataset.command = command;
    wrapper.appendChild(run);
  }

  function addCopyButtons(container) {
    container.querySelectorAll('pre').forEach((pre) => {
      if (pre.parentElement?.classList.contains('codeBox')) return;
      const wrapper = documentRef.createElement('div');
      wrapper.className = 'codeBox';
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);
      const button = documentRef.createElement('button');
      button.type = 'button';
      button.className = 'codeCopyBtn';
      button.title = 'Copy';
      button.innerHTML = ICON_COPY;
      wrapper.appendChild(button);
      addRunButton(wrapper, pre);
    });
  }

  /** @param {any} body @param {any} message @param {{ entryId?: string }} [options] */
  function addMessageActions(body, message, { entryId } = {}) {
    const bar = documentRef.createElement('div');
    bar.className = 'msgActions';
    const copy = documentRef.createElement('button');
    copy.type = 'button';
    copy.className = 'msgActionBtn';
    copy.title = 'Copy message';
    copy.innerHTML = ICON_COPY;
    addChatListener(copy, 'click', () => copyToClipboard(message.dataset.raw ?? message.textContent, copy));
    bar.appendChild(copy);
    if (entryId) {
      const fork = documentRef.createElement('button');
      fork.type = 'button';
      fork.className = 'msgActionBtn';
      fork.title = 'New chat from here';
      fork.innerHTML = ICON_FORK;
      addChatListener(fork, 'click', () => forkFrom(entryId));
      bar.appendChild(fork);
    }
    body.appendChild(bar);
  }

  function newTurn(role, model = null) {
    const root = historyRoot ?? chat;
    if (!historyRoot) {
      documentRef.getElementById('hero')?.remove();
      setHeroMode(false);
    }
    const queued = root.querySelector('.queuedPrompts');
    const last = queued ? queued.previousElementSibling : root.lastElementChild;
    if (last?.classList.contains('turn') && last.classList.contains(role)) {
      const selected = role === 'user' ? null : (model ?? currentState().turnModel ?? currentState().model);
      const signature = role === 'user' ? 'user' : `${selected?.provider ?? ''}/${selected?.id ?? selected?.model ?? ''}`;
      if (last.dataset.sig === signature) return last.querySelector('.body');
    }
    const turn = documentRef.createElement('div');
    turn.className = `turn ${role}`;
    if (role === 'user') {
      turn.dataset.sig = 'user';
      turn.innerHTML = '<div class="body"></div>';
    } else {
      const selected = model ?? currentState().turnModel ?? currentState().model;
      const provider = selected?.provider ?? '';
      const id = selected ? (selected.id ?? selected.model ?? '') : '';
      const pretty = selected?.name || getModels().find((item) => item.provider === provider && item.id === id)?.name || id;
      turn.dataset.sig = `${provider}/${id}`;
      turn.innerHTML = selected
        ? `<div class="body"><div class="who" title="${esc(provider)}/${esc(id)}">${esc(pretty)} <span class="mprov">${esc(provider)}</span></div></div>`
        : '<div class="body"><div class="who">pi</div></div>';
    }
    root.insertBefore(turn, queued);
    return turn.querySelector('.body');
  }

  function skillInvocationFromCommand(text, knownCommands = null) {
    const match = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(String(text ?? '').trim());
    if (!match) return null;
    if (Array.isArray(knownCommands)
        && !knownCommands.some((command) => command.source === 'skill' && command.name === `skill:${match[1]}`)) {
      return null;
    }
    return { type: 'skill', name: match[1], arguments: match[2]?.trim() ?? '' };
  }

  function skillInvocationText(skill) {
    return [`/skill:${skill.name}`, skill.arguments].filter(Boolean).join(' ');
  }

  function skillInvocationElement(skill) {
    const div = documentRef.createElement('div');
    div.className = 'msg user skillInvocation';
    div.dataset.raw = skillInvocationText(skill);
    const name = documentRef.createElement('span');
    name.className = 'skillName';
    name.textContent = `/skill:${skill.name}`;
    div.appendChild(name);
    if (skill.arguments) {
      const args = documentRef.createElement('span');
      args.className = 'skillArguments';
      args.textContent = skill.arguments;
      div.appendChild(args);
    }
    return div;
  }

  function mutateTranscript(mutate) {
    if (historyRoot) return mutate();
    const stick = atBottom();
    const result = mutate();
    if (stick) scrollDown();
    return result;
  }

  function timestampMillis(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function runDuration(milliseconds) {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
  }

  /**
   * @param {any} body
   * @param {{ timestamp?: string|number|null, durationMs?: number|null, role?: string }} [metadata]
   */
  function appendMessageMeta(body, { timestamp, durationMs = null, role = 'user' } = {}) {
    const sentAt = timestampMillis(timestamp);
    if (sentAt === null) return null;
    const meta = documentRef.createElement('div');
    meta.className = 'msgMeta';
    const time = documentRef.createElement('time');
    const date = new Date(sentAt);
    time.dateTime = date.toISOString();
    time.title = date.toLocaleString();
    time.textContent = MESSAGE_TIME_FORMAT.format(date);
    meta.appendChild(time);
    if (role === 'assistant' && Number.isFinite(durationMs) && durationMs >= 60_000) {
      const duration = documentRef.createElement('span');
      duration.className = 'runDuration';
      duration.textContent = `(${runDuration(durationMs)})`;
      meta.appendChild(duration);
    }
    body.appendChild(meta);
    return meta;
  }

  function flushAssistantMeta(chatState = currentState()) {
    const metadata = chatState.pendingAssistantMeta;
    if (!metadata || !currentTurn) return;
    appendMessageMeta(currentTurn, metadata);
    chatState.pendingAssistantMeta = null;
    currentAssistant = currentThinking = null;
  }

  function bubble(className, text = '', body = null) {
    return mutateTranscript(() => {
      const div = documentRef.createElement('div');
      div.className = `msg ${className}`;
      if (className === 'assistant') {
        div.classList.add('md');
        div.dataset.raw = text;
        renderMarkdown(div);
      } else {
        div.textContent = text;
      }
      (body ?? newTurn(className === 'user' ? 'user' : 'pi')).appendChild(div);
      return div;
    });
  }

  function flushPendingMarkdown({ decorate = false } = {}) {
    clearTimeout(markdownFlushTimer);
    markdownFlushTimer = null;
    const pending = pendingMarkdown;
    pendingMarkdown = null;
    if (pending) {
      mutateTranscript(() => {
        pending.div.dataset.raw = (pending.div.dataset.raw ?? '') + pending.delta;
        pending.div.classList.toggle('streaming', !decorate);
        renderMarkdown(pending.div, { decorate });
      });
      streamingMarkdown = decorate ? null : pending.div;
      return;
    }
    if (decorate && streamingMarkdown) {
      const div = streamingMarkdown;
      streamingMarkdown = null;
      mutateTranscript(() => {
        div.classList.remove('streaming');
        renderMarkdown(div);
      });
    }
  }

  function finalizeStreamingMarkdown() {
    flushPendingMarkdown({ decorate: true });
  }

  function appendMarkdown(div, delta) {
    if (pendingMarkdown && pendingMarkdown.div !== div) finalizeStreamingMarkdown();
    if (pendingMarkdown) pendingMarkdown.delta += delta;
    else pendingMarkdown = { div, delta };
    if (!markdownFlushTimer) markdownFlushTimer = setTimeout(() => flushPendingMarkdown(), MARKDOWN_FLUSH_MS);
  }

  function formResult(output) {
    try {
      const parsed = JSON.parse(output ?? '');
      if (parsed?.status === 'skipped') return parsed;
      return parsed?.status === 'submitted' && parsed.values && typeof parsed.values === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function formControls(card, fieldId) {
    return all('[data-form-field]', card).filter((control) => control.dataset.formField === fieldId);
  }

  function formCustomControl(card, fieldId) {
    return all('[data-form-custom]', card).find((control) => control.dataset.formCustom === fieldId);
  }

  function isChoiceField(field) {
    return field.type === 'radio' || field.type === 'select' || field.type === 'multiselect';
  }

  function setInteractiveFormValues(card, definition, values) {
    for (const field of definition.fields ?? []) {
      const controls = formControls(card, field.id);
      const value = values?.[field.id];
      if (field.type === 'checkbox') {
        if (controls[0]) controls[0].checked = value === true;
      } else if (isChoiceField(field)) {
        const selected = field.type === 'multiselect'
          ? (Array.isArray(value) ? value : value?.selected ?? [])
          : [typeof value === 'string' ? value : ''];
        const allowed = new Set((field.options ?? []).map((option) => option.value));
        controls.forEach((control) => { control.checked = selected.includes(control.value); });
        const custom = formCustomControl(card, field.id);
        if (custom) custom.value = value?.custom ?? selected.find((item) => item && !allowed.has(item)) ?? '';
      } else if (controls[0]) {
        controls[0].value = value ?? '';
      }
    }
  }

  function dockInteractiveForm(card) {
    if (card.classList.contains('isDocked')) return;
    const anchor = documentRef.createElement('div');
    anchor.className = 'formTranscriptAnchor';
    anchor.textContent = 'Answer the questions below to continue';
    card.parentNode.insertBefore(anchor, card);
    formAnchors.set(card, anchor);
    card.classList.add('isDocked');
    formDock.appendChild(card);
  }

  function finishInteractiveForm(card, definition, { values = null, error = false, skipped = false } = {}) {
    if (values) setInteractiveFormValues(card, definition, values);
    card.classList.remove('pending');
    card.classList.toggle('submitted', !!values && !error);
    card.classList.toggle('formError', error);
    card.classList.toggle('skipped', skipped);
    for (const row of all('.formField', card)) row.hidden = false;
    const fieldset = card.querySelector('.formFields');
    if (fieldset) fieldset.disabled = true;
    const button = card.querySelector('.formSubmit');
    if (button) button.disabled = true;
    const nav = card.querySelector('.formNav');
    if (nav) nav.hidden = true;
    const actions = card.querySelector('.formActions');
    if (actions) actions.hidden = true;
    const title = card.querySelector('.formQuestion');
    if (title) title.textContent = definition.title || 'Questions';
    const hint = card.querySelector('.formQuestionHint');
    if (hint) hint.textContent = definition.description || '';
    const status = card.querySelector('.formStatus');
    if (status) status.textContent = error ? 'Unavailable' : skipped ? 'Skipped' : 'Submitted';
    if (card.classList.contains('isDocked')) {
      card.classList.remove('isDocked');
      formAnchors.get(card)?.replaceWith(card);
      formAnchors.delete(card);
    }
    if (card.dataset.draftKey) {
      delete persistedFormDrafts[card.dataset.draftKey];
      saveFormDrafts();
    }
  }

  function optionControl(field, option, inputType) {
    const label = documentRef.createElement('label');
    label.className = 'formOption';
    const input = documentRef.createElement('input');
    input.type = inputType;
    input.name = field.id;
    input.value = option.value;
    input.dataset.formField = field.id;
    const copy = documentRef.createElement('span');
    copy.className = 'formOptionCopy';
    const name = documentRef.createElement('span');
    name.className = 'formOptionLabel';
    name.textContent = option.label;
    copy.appendChild(name);
    if (option.description) {
      const description = documentRef.createElement('span');
      description.className = 'formOptionDescription';
      description.textContent = option.description;
      copy.appendChild(description);
    }
    label.append(input, copy);
    return label;
  }

  function interactiveFormField(field) {
    const grouped = isChoiceField(field);
    const row = documentRef.createElement(grouped ? 'fieldset' : 'div');
    row.className = 'formField';
    const label = documentRef.createElement(grouped ? 'legend' : 'label');
    label.className = 'formLabel';
    label.textContent = field.label;
    if (field.required) {
      const required = documentRef.createElement('span');
      required.className = 'formRequired';
      required.textContent = 'Required';
      label.appendChild(required);
    }
    row.appendChild(label);
    if (field.description) {
      const description = documentRef.createElement('div');
      description.className = 'formHint';
      description.textContent = field.description;
      row.appendChild(description);
    }
    if (grouped) {
      const options = documentRef.createElement('div');
      options.className = 'formOptions';
      for (const option of field.options ?? []) {
        options.appendChild(optionControl(field, option, field.type === 'multiselect' ? 'checkbox' : 'radio'));
      }
      row.appendChild(options);
      const customLabel = documentRef.createElement('label');
      customLabel.className = 'formCustomLabel';
      customLabel.textContent = 'Or write your own answer';
      const custom = documentRef.createElement('textarea');
      custom.className = 'formCustomInput';
      custom.rows = 2;
      custom.maxLength = 4096;
      custom.dataset.formCustom = field.id;
      custom.id = `model-form-custom-${++formControlSequence}`;
      custom.placeholder = 'Your answer…';
      customLabel.setAttribute('for', custom.id);
      row.append(customLabel, custom);
      return row;
    }
    if (field.type === 'checkbox') {
      const choice = documentRef.createElement('label');
      choice.className = 'formBoolean';
      const input = documentRef.createElement('input');
      input.type = 'checkbox';
      input.name = field.id;
      input.dataset.formField = field.id;
      input.required = !!field.required;
      const text = documentRef.createElement('span');
      text.textContent = field.placeholder || 'Yes';
      choice.append(input, text);
      row.appendChild(choice);
      return row;
    }
    let control;
    if (field.type === 'textarea') {
      control = documentRef.createElement('textarea');
      control.rows = 3;
    } else {
      control = documentRef.createElement('input');
      control.type = field.type;
    }
    control.name = field.id;
    control.dataset.formField = field.id;
    control.required = !!field.required;
    control.id = `model-form-field-${++formControlSequence}`;
    label.setAttribute('for', control.id);
    if (field.placeholder) control.placeholder = field.placeholder;
    row.appendChild(control);
    return row;
  }

  function interactiveFormValues(card, definition) {
    const values = {};
    for (const field of definition.fields ?? []) {
      const controls = formControls(card, field.id);
      if (field.type === 'checkbox') values[field.id] = !!controls[0]?.checked;
      else if (isChoiceField(field)) {
        const custom = formCustomControl(card, field.id)?.value.trim() ?? '';
        if (field.type === 'multiselect') {
          const selected = controls.filter((control) => control.checked).map((control) => control.value);
          values[field.id] = custom ? { selected, custom } : selected;
        } else {
          values[field.id] = custom ? { custom } : controls.find((control) => control.checked)?.value ?? '';
        }
      }
      else values[field.id] = controls[0]?.value ?? '';
    }
    return values;
  }

  function formFieldAnswered(card, field) {
    const controls = formControls(card, field.id);
    if (field.type === 'checkbox') return !!controls[0]?.checked;
    if (isChoiceField(field)) {
      return controls.some((control) => control.checked) || !!formCustomControl(card, field.id)?.value.trim();
    }
    return !!String(controls[0]?.value ?? '').trim();
  }

  function showFormStep(card, definition, index) {
    const fields = definition.fields ?? [];
    const active = Math.max(0, Math.min(index, fields.length - 1));
    card.dataset.activeStep = String(active);
    all('.formField', card).forEach((row, position) => { row.hidden = position !== active; });
    card.querySelector('.formQuestion').textContent = fields[active]?.label ?? definition.title ?? 'Question';
    card.querySelector('.formQuestionHint').textContent = fields[active]?.description || (active === 0 ? definition.description : '') || '';
    const count = card.querySelector('.formQuestionCount');
    count.textContent = `${active + 1} of ${fields.length} ▾`;
    const menu = card.querySelector('.formQuestionMenu');
    menu.hidden = true;
    count.setAttribute('aria-expanded', 'false');
    menu.replaceChildren();
    fields.forEach((field, position) => {
      const item = documentRef.createElement('button');
      item.type = 'button';
      item.className = 'formQuestionItem';
      item.dataset.formStep = String(position);
      item.textContent = `${position + 1}. ${field.label}`;
      if (formFieldAnswered(card, field)) item.classList.add('answered');
      if (position === active) item.classList.add('current');
      menu.appendChild(item);
    });
    const progress = card.querySelector('.formProgress');
    progress.replaceChildren();
    fields.forEach((field, position) => {
      const segment = documentRef.createElement('span');
      segment.className = position === active ? 'active' : formFieldAnswered(card, field) ? 'done' : '';
      progress.appendChild(segment);
    });
    card.querySelector('.formBack').hidden = active === 0;
    card.querySelector('.formSubmit').textContent = active === fields.length - 1
      ? definition.submitLabel || 'Send answers' : 'Continue';
    card.querySelector('.formValidation').textContent = '';
  }

  function validateFormStep(card, field) {
    if (field.required && !formFieldAnswered(card, field)) {
      card.querySelector('.formValidation').textContent = isChoiceField(field)
        ? 'Choose an option or write your answer.' : 'This answer is required.';
      (formCustomControl(card, field.id) ?? formControls(card, field.id)[0])?.focus?.();
      return false;
    }
    if (!isChoiceField(field) && !formControls(card, field.id)[0]?.reportValidity()) return false;
    card.querySelector('.formValidation').textContent = '';
    return true;
  }

  function renderInteractiveForm(event) {
    let card = event.id ? toolCards.get(event.id) : null;
    if (!card && event.status === 'start') {
      setAwaitingInput(true, getKey());
      const definition = event.args ?? {};
      card = documentRef.createElement('section');
      card.className = 'interactiveForm pending';
      card.dataset.definition = JSON.stringify(definition);
      const head = documentRef.createElement('div');
      head.className = 'formHead';
      const nav = documentRef.createElement('div');
      nav.className = 'formNav';
      const count = documentRef.createElement('button');
      count.type = 'button';
      count.className = 'formQuestionCount';
      count.setAttribute('aria-haspopup', 'true');
      count.setAttribute('aria-expanded', 'false');
      const previous = documentRef.createElement('button');
      previous.type = 'button';
      previous.className = 'formStepArrow formPrevious';
      previous.textContent = '‹';
      previous.setAttribute('aria-label', 'Previous question');
      const next = documentRef.createElement('button');
      next.type = 'button';
      next.className = 'formStepArrow formNext';
      next.textContent = '›';
      next.setAttribute('aria-label', 'Next question');
      const menu = documentRef.createElement('div');
      menu.className = 'formQuestionMenu';
      menu.id = `model-form-menu-${++formControlSequence}`;
      menu.hidden = true;
      count.setAttribute('aria-controls', menu.id);
      nav.append(count, previous, next, menu);
      const context = documentRef.createElement('div');
      context.className = 'formContext';
      context.textContent = definition.title || 'Questions';
      const title = documentRef.createElement('h3');
      title.className = 'formQuestion';
      const hint = documentRef.createElement('p');
      hint.className = 'formQuestionHint';
      const progress = documentRef.createElement('div');
      progress.className = 'formProgress';
      progress.setAttribute('aria-hidden', 'true');
      const status = documentRef.createElement('span');
      status.className = 'formStatus';
      status.textContent = 'Needs your input';
      status.setAttribute('aria-live', 'polite');
      head.append(nav, context, title, hint, progress, status);
      const form = documentRef.createElement('form');
      form.className = 'modelForm';
      form.noValidate = true;
      const fields = documentRef.createElement('fieldset');
      fields.className = 'formFields';
      for (const field of definition.fields ?? []) fields.appendChild(interactiveFormField(field));
      const validation = documentRef.createElement('div');
      validation.className = 'formValidation';
      validation.setAttribute('role', 'status');
      const actions = documentRef.createElement('div');
      actions.className = 'formActions';
      const skip = documentRef.createElement('button');
      skip.type = 'button';
      skip.className = 'btn outline formSkip';
      skip.textContent = 'Non rispondere';
      skip.title = 'Skip this form and stop the current response';
      const back = documentRef.createElement('button');
      back.type = 'button';
      back.className = 'btn outline formBack';
      back.textContent = 'Back';
      const submit = documentRef.createElement('button');
      submit.type = 'submit';
      submit.className = 'btn teal formSubmit';
      actions.append(skip, back, submit);
      form.append(fields, validation, actions);
      card.append(head, form);
      currentTurn.appendChild(card);
      if (event.id) toolCards.set(event.id, card);
      const ownerKey = getKey();
      const draftKey = `${ownerKey ?? ''}\n${event.id ?? ''}`;
      card.dataset.draftKey = draftKey;
      if (persistedFormDrafts[draftKey]) setInteractiveFormValues(card, definition, persistedFormDrafts[draftKey]);
      showFormStep(card, definition, 0);
      if (!historyRoot) dockInteractiveForm(card);
      const rememberDraft = (inputEvent) => {
        const target = inputEvent.target;
        const fieldId = target?.dataset?.formCustom ?? target?.dataset?.formField;
        const field = (definition.fields ?? []).find((item) => item.id === fieldId);
        if (field && field.type !== 'multiselect' && isChoiceField(field)) {
          if (target.dataset.formCustom && target.value.trim()) {
            formControls(card, field.id).forEach((control) => { control.checked = false; });
          } else if (target.checked) {
            const custom = formCustomControl(card, field.id);
            if (custom) custom.value = '';
          }
        }
        persistedFormDrafts[draftKey] = interactiveFormValues(card, definition);
        saveFormDrafts();
      };
      addChatListener(form, 'input', rememberDraft);
      addChatListener(form, 'change', rememberDraft);
      addChatListener(count, 'click', () => {
        menu.hidden = !menu.hidden;
        count.setAttribute('aria-expanded', String(!menu.hidden));
      });
      addChatListener(menu, 'click', (clickEvent) => {
        const step = clickEvent.target.closest('[data-form-step]');
        if (step) showFormStep(card, definition, Number(step.dataset.formStep));
      });
      addChatListener(previous, 'click', () => showFormStep(card, definition,
        (Number(card.dataset.activeStep) + definition.fields.length - 1) % definition.fields.length));
      addChatListener(next, 'click', () => showFormStep(card, definition,
        (Number(card.dataset.activeStep) + 1) % definition.fields.length));
      addChatListener(back, 'click', () => showFormStep(card, definition, Number(card.dataset.activeStep) - 1));
      addChatListener(skip, 'click', async () => {
        skip.disabled = true;
        submit.disabled = true;
        status.textContent = 'Skipping…';
        const result = await post(`/api/forms/${encodeURIComponent(event.id)}/skip`, {}, {
          key: ownerKey, guardChat: true, followKey: false, quiet: ['form_not_pending'],
        });
        if (result.error) {
          skip.disabled = false;
          submit.disabled = false;
          status.textContent = 'Needs your input';
          card.querySelector('.formValidation').textContent = 'Could not skip this form. Try again or reopen the chat.';
          return;
        }
        finishInteractiveForm(card, definition, { skipped: true });
        // A live skip has been accepted, but the SDK still needs to settle the
        // turn. Keep the composer closed until its idle status arrives.
        if (!getChatState(ownerKey)?.streaming) setAwaitingInput(false, ownerKey);
      });
      addChatListener(form, 'submit', async (submitEvent) => {
        submitEvent.preventDefault();
        const active = Number(card.dataset.activeStep);
        if (!validateFormStep(card, definition.fields[active])) return;
        if (active < definition.fields.length - 1) {
          showFormStep(card, definition, active + 1);
          return;
        }
        for (let index = 0; index < definition.fields.length; index++) {
          showFormStep(card, definition, index);
          if (!validateFormStep(card, definition.fields[index])) return;
        }
        showFormStep(card, definition, definition.fields.length - 1);
        submit.disabled = true;
        status.textContent = 'Submitting…';
        const result = await post(`/api/forms/${encodeURIComponent(event.id)}/respond`, {
          values: interactiveFormValues(card, definition),
        }, { key: ownerKey, guardChat: true, followKey: false, quiet: ['form_not_pending'] });
        if (result.error) {
          submit.disabled = false;
          status.textContent = 'Needs your input';
          card.querySelector('.formValidation').textContent = 'Could not send answers. Try again or reopen the chat.';
          return;
        }
        finishInteractiveForm(card, definition, { values: result.values });
        setAwaitingInput(false, ownerKey);
      });
    }
    if (!card) return null;
    let definition = {};
    try { definition = JSON.parse(card.dataset.definition || '{}'); } catch {}
    if (event.status === 'end') {
      const result = formResult(event.output);
      if (result?.status !== 'skipped' || !getChatState(getKey())?.streaming) {
        setAwaitingInput(false, getKey());
      }
      finishInteractiveForm(card, definition, {
        values: result?.values ?? null,
        skipped: result?.status === 'skipped',
        error: !!event.isError || !result,
      });
    }
    return card;
  }

  function toolResultSummary(output, { running = false, isError = false } = {}) {
    if (running) return 'Running…';
    const text = String(output ?? '').trim();
    if (!text) return isError ? 'Failed without output' : 'Completed without output';
    const lines = text.split(/\r?\n/);
    const first = lines.find((line) => line.trim())?.trim().replace(/\s+/g, ' ') ?? '';
    const preview = first.length > 140 ? `${first.slice(0, 139)}…` : first;
    return lines.length > 1 ? `${lines.length} lines · ${preview}` : preview;
  }

  const toolIconKinds = {
    read: 'read', bash: 'bash', edit: 'edit', write: 'write',
    grep: 'search', find: 'search', ls: 'folder',
    web: 'web', search: 'search', fetch: 'web',
  };
  const toolCountLabels = {
    read: ['read', 'reads'], bash: ['shell command', 'shell commands'],
    edit: ['edit', 'edits'], write: ['write', 'writes'],
    grep: ['search', 'searches'], find: ['search', 'searches'],
    ls: ['listing', 'listings'],
  };

  function toolCountLabel(name, count) {
    const labels = toolCountLabels[name];
    return `${count} ${labels ? labels[count === 1 ? 0 : 1] : name}`;
  }

  function updateToolGroup(group) {
    const entries = [...group.querySelector('.toolGroupCalls').children];
    const cards = entries.filter((entry) => entry.classList.contains('toolCard'));
    group.querySelector('.toolGroupCount').textContent = `${cards.length} tool calls`;
    const thoughts = entries.filter((entry) => entry.classList.contains('thinking'));
    const latest = group.querySelector('.toolGroupThought');
    const thoughtText = thoughts.length ? thoughts[thoughts.length - 1].textContent.trim() : '';
    latest.textContent = thoughtText.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    latest.hidden = !latest.textContent;
    const counts = new Map();
    for (const card of cards) {
      const name = card.querySelector('.nm').textContent || 'tool';
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const preview = group.querySelector('.toolGroupPreview');
    preview.replaceChildren();
    for (const [name, count] of counts) {
      const pill = documentRef.createElement('span');
      pill.textContent = toolCountLabel(name, count);
      preview.appendChild(pill);
    }
  }

  function appendGroupedThinking(body, text = '') {
    const thought = bubble('thinking', text.replace(/\*\*/g, ''), body);
    thought.dataset.rawText = text;
    const trailingMeta = thought.previousElementSibling?.classList.contains('msgMeta')
      ? thought.previousElementSibling : null;
    const group = trailingMeta?.previousElementSibling ?? thought.previousElementSibling;
    if (group?.classList.contains('toolGroup')) {
      const calls = group.querySelector('.toolGroupCalls');
      if (trailingMeta) calls.appendChild(trailingMeta);
      calls.appendChild(thought);
      updateToolGroup(group);
    }
    return thought;
  }

  function appendToolCard(body, card) {
    const previous = body.lastElementChild;
    const trailingMeta = previous?.classList.contains('msgMeta') ? previous : null;
    const existingGroup = trailingMeta?.previousElementSibling ?? previous;
    if (existingGroup?.classList.contains('toolGroup')) {
      const calls = existingGroup.querySelector('.toolGroupCalls');
      if (trailingMeta) calls.appendChild(trailingMeta);
      calls.appendChild(card);
      updateToolGroup(existingGroup);
      return;
    }
    body.appendChild(card);
    const nodes = [];
    for (let node = card; node && (node.classList.contains('toolCard') || node.classList.contains('thinking') || node.classList.contains('msgMeta')); node = node.previousElementSibling) nodes.unshift(node);
    if (nodes.filter((node) => node.classList.contains('toolCard')).length !== 4) return;
    const group = documentRef.createElement('details');
    group.className = 'toolGroup';
    const summary = documentRef.createElement('summary');
    const count = documentRef.createElement('span');
    count.className = 'toolGroupCount';
    const preview = documentRef.createElement('span');
    preview.className = 'toolGroupPreview';
    const thought = documentRef.createElement('span');
    thought.className = 'toolGroupThought';
    summary.append(count, preview, thought);
    const calls = documentRef.createElement('div');
    calls.className = 'toolGroupCalls';
    group.append(summary, calls);
    body.insertBefore(group, nodes[0]);
    group.querySelector('.toolGroupCalls').append(...nodes);
    updateToolGroup(group);
  }

  function renderTool(event) {
    return mutateTranscript(() => {
      if (!currentTurn) currentTurn = newTurn('pi');
      if (event.name === 'request_form') return renderInteractiveForm(event);
      let card = event.id ? toolCards.get(event.id) : null;
      if (!card) {
        card = documentRef.createElement('div');
        card.className = 'toolCard running';
        card.innerHTML = `<button type="button" class="toolHead" aria-expanded="false">
          <span class="toolDot" aria-hidden="true"></span>
          <span class="toolMain">
            <span class="toolTitle"><span class="nm"></span><span class="sm"></span></span>
            <span class="toolResult">Running…</span>
          </span>
          <span class="st">running</span>
          <svg class="caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M9 5l7 7-7 7"/></svg>
        </button>
        <div class="toolBody">
          <h6>Input</h6><pre class="args">…</pre>
          <h6>Raw output</h6><pre class="out">(running…)</pre>
        </div>`;
        const head = card.querySelector('.toolHead');
        addChatListener(head, 'click', () => {
          const open = card.classList.toggle('open');
          head.setAttribute('aria-expanded', String(open));
        });
        appendToolCard(currentTurn, card);
        if (event.id) toolCards.set(event.id, card);
        addCopyButtons(card);
      }
      const query = (selector) => card.querySelector(selector);
      if (event.name && !query('.toolIcon')) {
        query('.nm').textContent = event.name;
        const icon = documentRef.createElement('span');
        icon.className = 'toolIcon';
        icon.dataset.kind = toolIconKinds[event.name] ?? 'other';
        icon.setAttribute('aria-hidden', 'true');
        query('.nm').parentNode.insertBefore(icon, query('.nm'));
      }
      if (event.status === 'preview') {
        showChatPreview(card, event, getKey(), documentRef, (url) => windowRef.fetch(url));
      } else if (event.status === 'start') {
        query('.sm').textContent = event.summary || '';
        query('.sm').title = event.summary || '';
        query('.args').textContent = typeof event.args === 'string' ? event.args : JSON.stringify(event.args ?? {}, null, 2);
      } else if (event.status === 'update') {
        if (event.output) {
          query('.out').textContent = event.output;
          query('.toolResult').textContent = toolResultSummary(event.output);
        }
      } else {
        card.classList.remove('running');
        card.classList.toggle('done', !event.isError);
        card.classList.toggle('error', !!event.isError);
        query('.st').textContent = event.isError ? 'error' : 'done';
        query('.toolResult').textContent = toolResultSummary(event.output, { isError: !!event.isError });
        query('.out').textContent = event.output || '(no output)';
        if (event.previewReady) showChatPreview(card, event, getKey(), documentRef, (url) => windowRef.fetch(url));
        if (event.isError) {
          card.classList.add('open');
          query('.toolHead').setAttribute('aria-expanded', 'true');
        }
      }
      const group = card.closest('.toolGroup');
      if (group && event.status === 'start') updateToolGroup(group);
      return card;
    });
  }

  function appendMessageImage(body, { src, alt = 'Attached image', title = alt }) {
    let media = body.querySelector(':scope > .media');
    if (!media) {
      media = documentRef.createElement('div');
      media.className = 'media';
      body.appendChild(media);
    }
    const image = documentRef.createElement('img');
    image.src = src;
    image.alt = alt;
    image.title = `${title} — click to enlarge`;
    media.appendChild(image);
    return image;
  }

  function acceptedUserTurn(text, attachments) {
    const turn = documentRef.createElement('div');
    turn.className = 'turn user';
    turn.dataset.sig = 'user';
    const body = documentRef.createElement('div');
    body.className = 'body';
    if (attachments.length) {
      const media = documentRef.createElement('div');
      media.className = 'media';
      for (const attachment of attachments) {
        if (attachment.kind === 'image') {
          const image = documentRef.createElement('img');
          image.src = attachment.url;
          image.alt = attachment.name;
          image.title = `${attachment.name} — click to enlarge`;
          media.appendChild(image);
        } else {
          const file = documentRef.createElement('span');
          file.className = 'filechip';
          file.textContent = `📄 ${attachment.name}`;
          media.appendChild(file);
        }
      }
      body.appendChild(media);
    }
    if (text) {
      const skill = skillInvocationFromCommand(text, getCommands());
      if (skill) body.appendChild(skillInvocationElement(skill));
      else {
        const message = documentRef.createElement('div');
        message.className = 'msg user';
        message.textContent = text;
        body.appendChild(message);
      }
    }
    appendMessageMeta(body, { timestamp: Date.now() });
    turn.appendChild(body);
    return turn;
  }

  function renderHistoryMessages(messages, key) {
    const fragment = documentRef.createDocumentFragment();
    const previousRoot = historyRoot;
    const previousTurn = currentTurn;
    historyRoot = fragment;
    try {
      for (const message of messages) {
        const blocks = Array.isArray(message.blocks) && message.blocks.length
          ? message.blocks
          : (message.text ? [{ type: 'text', text: message.text }] : []);
        if (!blocks.length && !message.errorMessage) continue;
        const body = newTurn(message.role === 'user' ? 'user' : 'pi',
          message.role === 'assistant' && (message.provider || message.model)
            ? { provider: message.provider, id: message.model }
            : null);
        currentTurn = body;
        let lastText = null;
        for (const block of blocks) {
          if (block.type === 'text') {
            lastText = bubble(message.role === 'user' ? 'user' : 'assistant', block.text ?? '', body);
          } else if (block.type === 'image' && message.entryId && Number.isInteger(block.contentIndex)) {
            appendMessageImage(body, {
              src: withSessionKey(
                `/api/attachment?entry=${encodeURIComponent(message.entryId)}&block=${block.contentIndex}`,
                key,
              ),
            });
          } else if (block.type === 'skill' && message.role === 'user') {
            lastText = skillInvocationElement(block);
            body.appendChild(lastText);
          } else if (block.type === 'thinking') {
            appendGroupedThinking(body, block.text ?? '');
          } else if (block.type === 'tool') {
            renderTool({ ...block, status: 'start' });
            if (block.status === 'end') renderTool({ ...block, status: 'end' });
          }
        }
        if (message.errorMessage) {
          bubble('sys err', `${message.stopReason === 'aborted' ? '⏹ ' : '⚠ '}${message.errorMessage}`, body);
        }
        appendMessageMeta(body, {
          timestamp: message.timestamp,
          durationMs: message.durationMs,
          role: message.role,
        });
        if (lastText) addMessageActions(body, lastText, { entryId: message.entryId });
      }
      return fragment;
    } finally {
      historyRoot = previousRoot;
      currentTurn = previousTurn;
    }
  }

  function historyPageButton(before, key) {
    if (before === null || before === undefined) return null;
    const button = documentRef.createElement('button');
    button.type = 'button';
    button.className = 'historyMore';
    button.textContent = 'Load earlier messages';
    addChatListener(button, 'click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        const result = await requestHistoryPage(before, key);
        if (result.error || !isActiveKey(key) || !button.isConnected) return;
        const fragment = renderHistoryMessages(result.messages ?? [], key);
        const next = historyPageButton(result.before, key);
        if (next) fragment.prepend(next);
        const anchor = button.nextElementSibling;
        const top = anchor?.getBoundingClientRect().top;
        button.replaceWith(fragment);
        if (anchor && top !== undefined) chatWrap.scrollTop += anchor.getBoundingClientRect().top - top;
        cache.ensure(key).view.historyStart = result.start;
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }

  function renderHistory({ key, messages, live = [], before = null, replace = false, preserveScroll = false }) {
    const savedScrollTop = preserveScroll ? chatWrap.scrollTop : null;
    if (replace) {
      cache.clearView(key);
      chat.replaceChildren();
      formDock.replaceChildren();
      toolCards.clear();
      currentAssistant = currentThinking = currentTurn = null;
    }
    const fragment = renderHistoryMessages(messages ?? [], key);
    const more = historyPageButton(before, key);
    if (more) fragment.prepend(more);
    currentTurn = currentAssistant = currentThinking = null;
    historyRoot = fragment;
    try {
      for (const segment of live) {
        if (!currentTurn) currentTurn = newTurn('pi');
        if (segment.type === 'text') {
          currentThinking = null;
          currentAssistant = bubble('assistant', segment.text ?? '', currentTurn);
        } else if (segment.type === 'thinking') {
          currentAssistant = null;
          currentThinking = appendGroupedThinking(currentTurn, segment.text ?? '');
        } else if (segment.type === 'tool' && segment.tool) {
          currentAssistant = currentThinking = null;
          renderTool({ ...segment.tool, status: 'start' });
          onToolEvent({ ...segment.tool, status: 'start' }, key);
          if (segment.tool.status === 'end') {
            renderTool({ ...segment.tool, status: 'end' });
            onToolEvent({ ...segment.tool, status: 'end' }, key);
          } else if (segment.tool.output) {
            renderTool({ ...segment.tool, status: 'update' });
          }
        }
      }
    } finally {
      historyRoot = null;
    }
    chat.appendChild(fragment);
    for (const pending of all('.interactiveForm.pending', chat)) dockInteractiveForm(pending);
    if (savedScrollTop === null) scrollDown();
    else chatWrap.scrollTop = savedScrollTop;
    return { empty: !chat.children.length, scrollTop: chatWrap.scrollTop };
  }

  function applyStreamEvent(event, chatState = currentState()) {
    switch (event.kind) {
      case 'text':
        flushAssistantMeta(chatState);
        currentThinking = null;
        if (!currentAssistant) {
          if (!currentTurn) currentTurn = newTurn('pi');
          currentAssistant = bubble('assistant', '', currentTurn);
        }
        appendMarkdown(currentAssistant, event.delta);
        return true;
      case 'thinking': {
        finalizeStreamingMarkdown();
        flushAssistantMeta(chatState);
        currentAssistant = null;
        if (!currentTurn) currentTurn = newTurn('pi');
        if (!currentThinking) currentThinking = appendGroupedThinking(currentTurn);
        currentThinking.dataset.rawText = (currentThinking.dataset.rawText ?? '') + event.delta;
        mutateTranscript(() => { currentThinking.textContent = currentThinking.dataset.rawText.replace(/\*\*/g, ''); });
        const thinkingGroup = currentThinking.closest('.toolGroup');
        if (thinkingGroup) updateToolGroup(thinkingGroup);
        return true;
      }
      case 'tool':
        finalizeStreamingMarkdown();
        currentThinking = currentAssistant = null;
        renderTool(event);
        return true;
      case 'message-meta':
        finalizeStreamingMarkdown();
        chatState.pendingAssistantMeta = event;
        return true;
      case 'error':
        finalizeStreamingMarkdown();
        if (!currentTurn) currentTurn = newTurn('pi');
        bubble('sys err', `${event.aborted ? '⏹ ' : '⚠ '}${event.message}`, currentTurn);
        return true;
      default:
        return false;
    }
  }

  function queueTypeLabel(type) {
    return type === 'steer' ? 'Reindirizza' : 'Dopo';
  }

  function queueAttachmentLabel(item) {
    const count = item.attachments?.length ?? 0;
    return count ? `${count} ${count === 1 ? 'allegato' : 'allegati'}` : '';
  }

  function queuedPromptElement(item, index) {
    const row = documentRef.createElement('div');
    row.className = 'queuedPrompt';
    row.dataset.id = item.id;
    row.dataset.type = item.type;
    const order = documentRef.createElement('span');
    order.className = 'queueOrder';
    order.textContent = String(index + 1);
    const content = documentRef.createElement('div');
    content.className = 'queueBubble';
    const type = documentRef.createElement('span');
    type.className = 'queueType';
    type.textContent = queueTypeLabel(item.type);
    content.appendChild(type);
    if (item.text) content.appendChild(documentRef.createTextNode(item.text));
    const attachmentLabel = queueAttachmentLabel(item);
    if (attachmentLabel) {
      const attachment = documentRef.createElement('span');
      attachment.className = 'queueAttachment';
      attachment.textContent = `${item.text ? ' · ' : ''}${attachmentLabel}`;
      content.appendChild(attachment);
    }
    const remove = documentRef.createElement('button');
    remove.type = 'button';
    remove.className = 'queueRemove';
    remove.dataset.queueRemove = item.id;
    remove.title = 'Rimuovi dalla coda';
    remove.setAttribute('aria-label', 'Rimuovi dalla coda');
    remove.textContent = '×';
    row.append(order, content, remove);
    return row;
  }

  function renderQueuedPrompts(items) {
    chat.querySelector('.queuedPrompts')?.remove();
    if (!items.length) return;
    const section = documentRef.createElement('section');
    section.className = 'queuedPrompts';
    section.setAttribute('aria-label', 'Messaggi preparati, non ancora nel transcript');
    const caption = documentRef.createElement('div');
    caption.className = 'queuedCaption';
    caption.textContent = 'Messaggi preparati, non ancora nel transcript';
    section.appendChild(caption);
    items.forEach((item, index) => section.appendChild(queuedPromptElement(item, index)));
    chat.appendChild(section);
  }

  function deliveredPromptElement(item) {
    const turn = documentRef.createElement('div');
    turn.className = 'turn user queuedDelivered';
    turn.dataset.queueId = item.id;
    turn.dataset.sig = 'user';
    const body = documentRef.createElement('div');
    body.className = 'body';
    const type = documentRef.createElement('span');
    type.className = 'queueType';
    type.textContent = queueTypeLabel(item.type);
    const skill = skillInvocationFromCommand(item.text, getCommands());
    const message = skill ? skillInvocationElement(skill) : documentRef.createElement('div');
    if (!skill) {
      message.className = 'msg user';
      message.textContent = item.text || queueAttachmentLabel(item);
    }
    body.append(type, message);
    appendMessageMeta(body, { timestamp: Date.now() });
    turn.appendChild(body);
    return turn;
  }

  function dispatchQueuedPrompts(ids, previousItems, chatState) {
    const previous = new Map(previousItems.map((item) => [item.id, item]));
    const section = chat.querySelector('.queuedPrompts');
    for (const id of ids ?? []) {
      const item = previous.get(id);
      const alreadyFixed = all('[data-queue-id]', chat).some((turn) => turn.dataset.queueId === id);
      if (!item || alreadyFixed) continue;
      const turn = deliveredPromptElement(item);
      mutateTranscript(() => {
        if (section) chat.insertBefore(turn, section);
        else chat.appendChild(turn);
      });
      flushAssistantMeta(chatState);
      currentTurn = currentAssistant = currentThinking = null;
    }
  }

  function disposeSnapshot(snapshot) {
    snapshot.fragment.replaceChildren();
    snapshot.formFragment.replaceChildren();
    snapshot.toolCards.length = 0;
    snapshot.currentAssistant = snapshot.currentThinking = snapshot.currentTurn = null;
  }

  function park(key) {
    if (!key || cache.peek(key)?.view.snapshot) return;
    finalizeStreamingMarkdown();
    const fragment = documentRef.createDocumentFragment();
    const formFragment = documentRef.createDocumentFragment();
    cache.captureView(key, {
      readScrollTop: () => chatWrap.scrollTop,
      detachSnapshot: () => {
        fragment.append(...chat.childNodes);
        formFragment.append(...formDock.childNodes);
        return {
          fragment,
          formFragment,
          currentAssistant,
          currentThinking,
          currentTurn,
          toolCards: [...toolCards],
        };
      },
      disposeSnapshot,
    });
    currentAssistant = currentThinking = currentTurn = null;
    toolCards.clear();
  }

  function restore(key) {
    const entry = cache.ensure(key);
    const snapshot = cache.takeSnapshot(key);
    chat.replaceChildren();
    formDock.replaceChildren();
    currentAssistant = currentThinking = currentTurn = null;
    toolCards.clear();
    if (snapshot) {
      chat.append(snapshot.fragment);
      formDock.append(snapshot.formFragment);
      currentAssistant = snapshot.currentAssistant;
      currentThinking = snapshot.currentThinking;
      currentTurn = snapshot.currentTurn;
      for (const [id, card] of snapshot.toolCards) toolCards.set(id, card);
    }
    if (entry.view.scrollTop !== null) chatWrap.scrollTop = entry.view.scrollTop;
  }

  function clearSegments() {
    currentAssistant = currentThinking = currentTurn = null;
  }

  function showHero(projectName = '') {
    if (chat.children.length) return;
    const hero = documentRef.createElement('div');
    hero.id = 'hero';
    hero.innerHTML = projectName
      ? `<h1>What should we build in <span class="proj">${esc(projectName)}</span>?</h1>`
      : '<h1>What should we build today?</h1>';
    chat.appendChild(hero);
    setHeroMode(true);
  }

  function capturePromptAnchor() {
    return chat.lastElementChild;
  }

  function insertAcceptedUserTurn(text, attachments, anchor) {
    const hero = documentRef.getElementById('hero');
    const insertionAnchor = anchor === hero ? null : anchor;
    hero?.remove();
    setHeroMode(false);
    const turn = acceptedUserTurn(text, attachments);
    if (insertionAnchor?.parentNode === chat) insertionAnchor.after(turn);
    else chat.prepend(turn);
    scrollDown();
  }

  async function onChatClick(event) {
    const queueRemove = event.target.closest('[data-queue-remove]');
    if (queueRemove) {
      await cancelQueuedPrompt(queueRemove.dataset.queueRemove);
      return;
    }
    const copy = event.target.closest('.codeCopyBtn');
    if (copy) {
      const pre = copy.closest('.codeBox')?.querySelector('pre');
      const code = pre?.querySelector('code');
      await copyToClipboard(code ? code.innerText : pre?.innerText, copy);
      return;
    }
    const run = event.target.closest('.codeRunBtn');
    if (run) {
      const result = await post('/api/type-command', { command: run.dataset.command });
      if (!result.error) toast('Command typed in a new terminal — press Enter there to run it', true);
      return;
    }
    const link = event.target.closest('.md a');
    if (link && isLocalLink(link.getAttribute('href'))) {
      event.preventDefault();
      const result = await post('/api/open-local-path', { href: link.getAttribute('href') }, {
        key: getKey(), guardChat: true,
      });
      if (!result.error) toast(`Opened ${result.path}`, true);
      return;
    }
    const image = event.target.closest('.media img, .msg img');
    if (image) openImage(image.src, image.alt);
  }

  function start() {
    if (started) return;
    started = true;
    configureMarkdown();
    loadFormDrafts();
    chat.addEventListener('click', onChatClick);
  }

  function dispose() {
    if (!started) return;
    started = false;
    finalizeStreamingMarkdown();
    chat.removeEventListener('click', onChatClick);
  }

  return {
    start,
    dispose,
    hasSnapshot: (key) => Boolean(key && cache.peek(key)?.view.snapshot),
    hasContent: () => chat.children.length > 0,
    park,
    restore,
    renderHistory,
    applyStreamEvent,
    finalizeStreamingMarkdown,
    flushAssistantMeta,
    clearSegments,
    renderQueuedPrompts,
    dispatchQueuedPrompts,
    showHero,
    capturePromptAnchor,
    insertAcceptedUserTurn,
  };
}
