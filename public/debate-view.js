import { VIEW_DEBATE } from './ui-state.js';
import { MIN_DEBATE_ROUNDS, parseDebateConfig, parseDebateCycle, parseDebateTurns } from './debate-contract.js';
import { readAttachmentFiles } from './attachments.js';

/** The view owns DOM and subscriptions. Navigation and execution belong to their existing owners. */
export function createDebateView({ state, getCwd, getModels, select, toast,
  documentRef = document, windowRef = /** @type {any} */ (window),
  fetchImpl = (url, options) => fetch(url, options), createEventSource = (url) => new EventSource(url),
  schedule = setTimeout, cancel = clearTimeout,
}) {
  const root = documentRef.getElementById('debateView');
  const listRoot = documentRef.getElementById('debateList');
  root.innerHTML = `
    <div class="debate-inner">
      <form id="debateForm" class="debate-setup">
        <h2>Explore an idea</h2>
        <p class="lead">Two independent positions, then a conversation. Each agent writes its own conclusion.</p>
        <label for="debatePrompt">What would you like to explore?</label>
        <textarea id="debatePrompt" rows="6" required placeholder="Describe your idea, the question and any constraints."></textarea>
        <div id="debateAttachments" class="debate-attachments"></div>
        <button id="debateAttach" class="btn outline" type="button">Attach files</button>
        <input id="debateFileInput" type="file" multiple hidden>
        <label for="debateCwd">Project folder <span class="sys">Agents can read and explore this folder, but cannot modify it.</span></label>
        <input id="debateCwd" required spellcheck="false">
        <div class="debate-agents">
          <fieldset><legend>Agent A</legend><label for="debateModelA">Model</label><select id="debateModelA" required></select><label for="debateEffortA">Effort</label><select id="debateEffortA" required></select></fieldset>
          <fieldset><legend>Agent B</legend><label for="debateModelB">Model</label><select id="debateModelB" required></select><label for="debateEffortB">Effort</label><select id="debateEffortB" required></select></fieldset>
        </div>
        <div class="debate-launch"><label for="debateRounds">Rounds per agent</label><input id="debateRounds" type="number" step="1" value="4" required><span id="debateBudget" class="sys"></span><button class="btn teal" id="debateLaunch" type="submit">Start debate</button></div>
        <p class="sys">Read-only project tools. Text/code files and images supported. Uses your selected providers and their quota.</p>
      </form>
      <section id="debateRun" class="hide" aria-label="Debate">
        <div class="debate-toolbar"><h2>Debate</h2><span id="debateStatus" role="status"></span><button id="debateResume" class="btn teal" type="button">Resume</button><button id="debateStop" class="btn outline" type="button">Stop</button></div>
        <p id="debateModels" class="sys"></p>
        <details class="debate-prompt"><summary>Current cycle prompt</summary><div id="debateOriginal"></div><p id="debateInputFiles" class="sys"></p></details>
        <div class="debate-pages"><button id="debateOlder" class="btn outline" type="button">Older responses</button><button id="debateLatest" class="btn outline" type="button">Latest responses</button><button id="debateFinals" class="btn outline" type="button" aria-pressed="false">Conclusions only</button></div>
        <div id="debateTranscript"></div><div id="debateLive"></div>
        <form id="debateContinueForm" class="debate-setup debate-continuation hide">
          <h2>Continue the conversation</h2>
          <p class="sys">Both agents keep their context. Choose a new prompt and the rounds for this cycle.</p>
          <label for="debateContinuePrompt">Next prompt</label>
          <textarea id="debateContinuePrompt" rows="4" required></textarea>
          <div id="debateContinueAttachments" class="debate-attachments"></div>
          <button id="debateContinueAttach" class="btn outline" type="button">Attach files</button>
          <input id="debateContinueFileInput" type="file" multiple hidden>
          <div class="debate-launch"><label for="debateContinueRounds">Rounds per agent</label><input id="debateContinueRounds" type="number" step="1" value="4" required><span id="debateContinueBudget" class="sys"></span><button id="debateContinueSend" class="btn teal" type="submit">Start next cycle</button></div>
        </form>
      </section>
      <p id="debateError" class="debate-error hide" role="alert"></p>
    </div>`;
  /** @type {(id: string) => any} */
  const $ = (id) => documentRef.getElementById(id);
  let started = false;
  let selectedId = null;
  let visible = false;
  let generation = 0;
  let source = null;
  let frame = null;
  let snapshot = null;
  let before = null;
  let pageCursor = null;
  let finals = false;
  let historyRevision = '';
  let historyRequest = 0;
  let listRequest = 0;
  let listCursor = null;
  let listNext = null;
  let listCwd = null;
  let listTimer = null;
  let busy = false;
  let actionError = null;
  let models = [];
  const cleanups = [];
  const requests = new Set();
  const live = new Map();
  const liveNodes = new Map();
  const activities = new Map();
  const drafts = new Map();
  const lastSelections = new Map();
  let draft = null;

  function on(element, event, callback) {
    element.addEventListener(event, callback);
    cleanups.push(() => element.removeEventListener(event, callback));
  }
  function report(error) {
    $('debateError').textContent = error.message;
    $('debateError').classList.remove('hide');
  }
  async function request(url, body = undefined) {
    const controller = new AbortController();
    requests.add(controller);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || 'Debate request failed.');
      return data;
    } finally { requests.delete(controller); }
  }
  function option(value, label) {
    const node = documentRef.createElement('option');
    node.value = value; node.textContent = label;
    return node;
  }
  function updateEffort(agent) {
    const model = models[Number($(`debateModel${agent}`).value)];
    const picker = $(`debateEffort${agent}`);
    const previous = picker.value;
    picker.replaceChildren(...(model?.thinkingLevels ?? []).map((level) => option(level, level)));
    const levels = model?.thinkingLevels ?? [];
    if (levels.includes(previous)) picker.value = previous;
    else if (levels.includes('medium')) picker.value = 'medium';
  }
  function populateModels() {
    const previous = {};
    for (const agent of ['A', 'B']) previous[agent] = models[Number($(`debateModel${agent}`).value)];
    models = getModels();
    for (const agent of ['A', 'B']) {
      const picker = $(`debateModel${agent}`);
      picker.replaceChildren(...models.map((model, index) => option(String(index), `${model.provider} / ${model.name || model.id}`)));
      const index = models.findIndex((model) => model.provider === previous[agent]?.provider && model.id === previous[agent]?.id);
      if (index >= 0) picker.value = String(index);
      updateEffort(agent);
    }
    $('debateLaunch').disabled = !models.length || busy || draft.readers.size > 0;
    $('debateBudget').textContent = `${$('debateRounds').value * 2} responses, including conclusions`;
  }
  function remember(value) {
    const normalized = state.applyDebatePayload(value);
    return normalized;
  }
  function projectCwd() { return state.projects.get(state.activeTabId).cwd; }
  function listButton(label, action) {
    const node = documentRef.createElement('button');
    node.type = 'button'; node.className = 'srow debate-row'; node.textContent = label;
    node.addEventListener('click', action);
    return node;
  }
  async function loadList(cursor = listCursor) {
    const cwd = projectCwd();
    if (cwd !== listCwd) cursor = null;
    listCwd = cwd;
    listCursor = cursor;
    const ticket = ++listRequest;
    const query = new URLSearchParams();
    if (cwd) query.set('cwd', cwd);
    if (cursor) query.set('before', cursor);
    try {
      const page = await request(`/api/debates?${query}`);
      if (ticket !== listRequest || !started) return;
      if (!Array.isArray(page.debates)) throw new TypeError('Invalid debate list');
      listNext = page.before;
      const nodes = page.debates.map((value) => {
        const item = remember(value);
        const title = item.title.replace(/\s+/g, ' ').slice(0, 90);
        const button = listButton(title, () => select(item));
        button.title = `${item.status}: ${item.completed}/${item.config.rounds * 2} responses`;
        button.classList.toggle('on', state.selection?.view === VIEW_DEBATE && state.selection.resourceId === item.id);
        const status = documentRef.createElement('span'); status.className = 'debate-row-status'; status.textContent = item.status;
        button.appendChild(status);
        return button;
      });
      if (!nodes.length) {
        const hint = documentRef.createElement('p'); hint.className = 'sys'; hint.textContent = 'No debates on this page.'; nodes.push(hint);
      }
      if (listNext) nodes.push(listButton('Older debates', () => loadList(listNext)));
      if (listCursor) nodes.push(listButton('Newest debates', () => loadList(null)));
      listRoot.replaceChildren(...nodes);
    } catch (error) { if (error.name !== 'AbortError' && ticket === listRequest) toast(error.message); }
  }
  function refreshList() {
    if (!started || listTimer !== null) return;
    listTimer = schedule(() => { listTimer = null; loadList(); }, 150);
  }
  function header() {
    if (!snapshot) return;
    const { config, status, completed, ownedElsewhere } = snapshot;
    $('debateStatus').textContent = `Cycle ${snapshot.cycle} · ${status} · ${completed}/${config.rounds * 2} responses`;
    $('debateModels').textContent = ['A', 'B'].map((agent) => `${agent}: ${config[agent].name} (${config[agent].effort}) · ${config[agent].provider}`).join('   |   ');
    $('debateOriginal').textContent = config.prompt;
    $('debateInputFiles').textContent = snapshot.attachments.map((item) => item.name).join(', ');
    $('debateContinueForm').classList.toggle('hide', status !== 'completed');
    $('debateContinueSend').disabled = busy || draft.readers.size > 0;
    if (draft.rounds === null) $('debateContinueRounds').value = String(config.rounds);
    $('debateContinueBudget').textContent = `${Number($('debateContinueRounds').value) * 2} responses`;
    const running = status === 'running' || status === 'stopping';
    $('debateResume').classList.toggle('hide', running || status === 'completed' || ownedElsewhere);
    $('debateResume').textContent = status === 'ready' ? 'Start' : 'Resume';
    $('debateStop').classList.toggle('hide', !running || ownedElsewhere);
    $('debateStop').disabled = busy || status === 'stopping';
    $('debateResume').disabled = busy;
    $('debateError').classList.add('hide');
    if (snapshot.error) report(snapshot.error);
    if (ownedElsewhere) report({ message: 'Running in another app instance. Control it there; saved responses appear here.' });
    if (actionError) report(actionError);
  }
  function turnNode(key, text, final, streaming = false, cycle = snapshot.cycle, model = snapshot.config[key[0]]) {
    const article = documentRef.createElement('article'); article.className = 'debate-turn';
    article.setAttribute('data-turn', key);
    const heading = documentRef.createElement('h3');
    heading.textContent = `${key} — ${model.name} (${model.effort}) · ${model.provider} · Cycle ${cycle}` + (final ? ' — Conclusion' : '');
    const activity = documentRef.createElement('div'); activity.className = 'debate-activity';
    const content = documentRef.createElement('div'); content.className = 'md';
    if (streaming || !windowRef.marked || !windowRef.DOMPurify) {
      content.classList.add('debate-plain'); content.textContent = text || 'Preparing response…';
    } else {
      content.innerHTML = windowRef.DOMPurify.sanitize(windowRef.marked.parse(text), {
        FORBID_TAGS: ['img', 'iframe', 'style', 'form', 'input', 'button'], FORBID_ATTR: ['style', 'id'],
      });
      for (const link of content.querySelectorAll('a')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    }
    article.append(heading, activity, content);
    return { article, content, activity };
  }
  function followBottom(action) {
    const follow = root.scrollHeight - root.scrollTop - root.clientHeight < 90;
    action();
    if (follow) root.scrollTop = root.scrollHeight;
  }
  function renderLive() {
    frame = null;
    if (!visible) return;
    followBottom(() => {
      for (const [key, node] of liveNodes) if (!live.has(key) || finals || pageCursor !== null) { node.article.remove(); liveNodes.delete(key); }
      if (finals || pageCursor !== null) return;
      for (const [key, text] of [...live].sort()) {
        let node = liveNodes.get(key);
        if (!node) {
          node = turnNode(key, text, Number(key.slice(1)) === snapshot.config.rounds, true);
          liveNodes.set(key, node); $('debateLive').appendChild(node.article);
        }
        node.content.textContent = text || 'Preparing response…';
        node.activity.textContent = activities.get(key) || '';
      }
    });
  }
  function scheduleLive() { if (frame === null) frame = schedule(renderLive, 80); }
  async function loadHistory(cursor = pageCursor) {
    const ticket = ++historyRequest;
    const owner = generation;
    const id = selectedId;
    pageCursor = cursor;
    const query = new URLSearchParams();
    if (cursor !== null) query.set('before', String(cursor));
    if (finals) query.set('finals', '1');
    try {
      const page = parseDebateTurns(await request(`/api/debates/${id}/history?${query}`));
      if (ticket !== historyRequest || owner !== generation || !visible) return;
      before = page.before;
      const nodes = [];
      let lastCycle = null;
      for (const turn of page.turns) {
        if (lastCycle !== turn.cycle) {
          const prompt = documentRef.createElement('div'); prompt.className = 'debate-cycle-prompt';
          prompt.textContent = `Cycle ${turn.cycle}\n${turn.prompt}`; nodes.push(prompt); lastCycle = turn.cycle;
        }
        nodes.push(turnNode(turn.key, turn.text, turn.final, false, turn.cycle, turn.model).article);
      }
      followBottom(() => $('debateTranscript').replaceChildren(...nodes));
      $('debateOlder').disabled = before === null;
      $('debateLatest').disabled = cursor === null && !finals;
      $('debateFinals').setAttribute('aria-pressed', String(finals));
      scheduleLive();
    } catch (error) {
      if (owner === generation && error.name !== 'AbortError') {
        historyRevision = ''; $('debateLatest').disabled = false; report(error);
      }
    }
  }
  function applySnapshot(value) {
    const next = remember(value);
    if (next.id !== selectedId || !visible) return;
    if (snapshot && next.revision < snapshot.revision) return;
    const previousStatus = snapshot?.status;
    if (snapshot && snapshot.cycle !== next.cycle) {
      pageCursor = null; finals = false; historyRequest++;
      liveNodes.clear(); $('debateLive').replaceChildren();
    }
    snapshot = next;
    if (previousStatus !== next.status) refreshList();
    live.clear(); activities.clear();
    for (const item of next.live) { live.set(item.key, item.text); activities.set(item.key, item.activity); }
    header(); scheduleLive();
    const historyVersion = `${next.cycle}:${next.totalCompleted}`;
    if (historyRevision !== historyVersion) {
      historyRevision = historyVersion;
      if (pageCursor === null || finals) loadHistory();
    }
  }
  function connect(id, owner) {
    source = createEventSource(`/api/debates/${id}/events`);
    source.onmessage = (message) => {
      if (owner !== generation || !visible) return;
      try {
        const event = JSON.parse(message.data);
        if (event.kind === 'snapshot') applySnapshot(event.debate);
        else if (event.kind === 'activity') {
          if (event.cycle !== snapshot?.cycle || !live.has(event.key)) return;
          activities.set(event.key, event.activity); scheduleLive();
        } else if (event.kind === 'text') {
          if (event.cycle !== snapshot?.cycle) return;
          const text = live.get(event.key);
          if (typeof event.delta !== 'string' || text === undefined || text.length !== event.offset) return;
          live.set(event.key, text + event.delta); scheduleLive();
        } else if (event.kind === 'unavailable') report({ message: 'Saved debate is temporarily unavailable.' });
      } catch (error) { report(error); }
    };
    source.onerror = () => {
      if (owner !== generation) return;
      const message = source.readyState === 2
        ? 'The debate stream is unavailable. Reopen the debate to reconnect.'
        : 'Connection lost. Reconnecting without restarting the debate…';
      report({ message });
    };
  }
  function hide() {
    if (visible) {
      try { windowRef.sessionStorage?.removeItem('piDebateSelection'); } catch { /* storage may be unavailable */ }
    }
    visible = false; generation++; historyRequest++;
    source?.close(); source = null;
    if (frame !== null) cancel(frame);
    frame = null; root.classList.add('hide');
  }
  function show(id) {
    if (visible && selectedId === id) return;
    hide(); visible = true; selectedId = id; snapshot = null; historyRevision = ''; actionError = null;
    lastSelections.set(state.activeTabId, id);
    const draftKey = id ?? `new:${state.activeTabId}`;
    if (!drafts.has(draftKey)) drafts.set(draftKey, { text: '', rounds: null, attachments: [], readers: new Set() });
    draft = drafts.get(draftKey);
    const prefix = id === null ? 'debate' : 'debateContinue';
    $(`${prefix}Prompt`).value = draft.text;
    $(`${prefix}Rounds`).value = String(draft.rounds ?? 4);
    renderAttachments();
    if (id) {
      try { windowRef.sessionStorage?.setItem('piDebateSelection', id); } catch { /* storage may be unavailable */ }
    }
    pageCursor = null; finals = false; live.clear(); liveNodes.clear();
    $('debateTranscript').replaceChildren(); $('debateLive').replaceChildren();
    $('debateError').classList.add('hide'); root.classList.remove('hide');
    $('debateContinueForm').classList.add('hide');
    $('debateForm').classList.toggle('hide', id !== null);
    $('debateRun').classList.toggle('hide', id === null);
    $('debateResume').classList.add('hide'); $('debateStop').classList.add('hide');
    $('debateStatus').textContent = 'Loading…'; $('debateModels').textContent = ''; $('debateOriginal').textContent = '';
    if (id === null) {
      $('debateCwd').value = getCwd(); populateModels(); $('debatePrompt').focus();
    } else {
      connect(id, generation);
    }
    refreshList();
  }
  function renderAttachments() {
    if (!draft) return;
    const prefix = selectedId === null ? 'debate' : 'debateContinue';
    const owner = draft;
    $(`${prefix}Attachments`).replaceChildren(...owner.attachments.map((item) => {
      const chip = documentRef.createElement('span'); chip.className = 'debate-file'; chip.textContent = item.name;
      const remove = documentRef.createElement('button'); remove.type = 'button'; remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${item.name}`);
      remove.addEventListener('click', () => { owner.attachments = owner.attachments.filter((entry) => entry !== item); renderAttachments(); });
      chip.appendChild(remove); return chip;
    }));
    $('debateLaunch').disabled = busy || !models.length || owner.readers.size > 0;
    $('debateContinueSend').disabled = busy || owner.readers.size > 0;
  }
  function addFiles(files) {
    if (!visible || !draft) return;
    if (selectedId !== null && snapshot?.status !== 'completed') {
      report({ message: 'Finish the current cycle before attaching files to the next prompt.' }); return;
    }
    const owner = draft;
    readAttachmentFiles(files, {
      reader: () => {
        const reader = new windowRef.FileReader(); owner.readers.add(reader);
        reader.onerror = () => toast('Could not read attachment');
        reader.onloadend = () => { owner.readers.delete(reader); if (visible && draft === owner) renderAttachments(); };
        return reader;
      },
      append: (item) => { if (!started) return; owner.attachments.push(item); if (visible && draft === owner) renderAttachments(); },
      report: toast,
    });
    renderAttachments();
  }
  function attachmentBody(items) {
    return items.map((item) => {
      if (item.kind === 'image') return { kind: item.kind, name: item.name, data: item.data, mimeType: item.mimeType };
      return { kind: item.kind, name: item.name, text: item.text };
    });
  }
  function acceptDraft(owner, text, sent) {
    if (owner.text === text) owner.text = '';
    const accepted = new Set(sent);
    owner.attachments = owner.attachments.filter((item) => !accepted.has(item));
    if (owner === draft) {
      const prefix = selectedId === null ? 'debate' : 'debateContinue';
      if ($(`${prefix}Prompt`).value === text) $(`${prefix}Prompt`).value = '';
      renderAttachments();
    }
  }
  async function launch(event) {
    event.preventDefault();
    if (busy || draft.readers.size) return;
    busy = true; actionError = null; populateModels();
    const owner = generation;
    let actionGeneration = owner;
    const submitted = draft;
    const attachments = [...submitted.attachments];
    const text = $('debatePrompt').value;
    submitted.text = text;
    try {
      const agent = (name) => {
        const model = models[Number($(`debateModel${name}`).value)];
        return { provider: model?.provider, model: model?.id, name: model?.name, effort: $(`debateEffort${name}`).value };
      };
      const config = parseDebateConfig({ prompt: $('debatePrompt').value, cwd: $('debateCwd').value,
        rounds: Number($('debateRounds').value), A: agent('A'), B: agent('B') });
      const created = remember(await request('/api/debates', { ...config, attachments: attachmentBody(attachments) }));
      acceptDraft(submitted, text, attachments);
      // Select the saved record before execution: a rejected start remains recoverable.
      if (owner === generation) { select(created); actionGeneration = generation; }
      await request(`/api/debates/${created.id}/start`, {});
      refreshList();
    } catch (error) { if (visible && actionGeneration === generation) { actionError = error; report(error); } else toast(error.message); }
    finally { busy = false; renderAttachments(); header(); }
  }
  async function continueCycle(event) {
    event.preventDefault();
    if (busy || !snapshot || snapshot.status !== 'completed' || draft.readers.size) return;
    const id = selectedId;
    const owner = generation;
    const submitted = draft;
    const attachments = [...submitted.attachments];
    const text = $('debateContinuePrompt').value;
    const rounds = Number($('debateContinueRounds').value);
    submitted.text = text;
    submitted.rounds = rounds;
    const previousCycle = snapshot.cycle;
    busy = true; actionError = null; header();
    try {
      const cycle = parseDebateCycle({ prompt: text, rounds });
      const result = await request(`/api/debates/${id}/continue`, { ...cycle, previousCycle, attachments: attachmentBody(attachments) });
      acceptDraft(submitted, text, attachments);
      applySnapshot(result); refreshList();
    } catch (error) {
      if (id === selectedId && owner === generation && visible) { actionError = error; report(error); } else toast(error.message);
    } finally { busy = false; renderAttachments(); header(); }
  }
  async function action(verb) {
    if (busy || !selectedId) return;
    const id = selectedId;
    const owner = generation;
    busy = true; actionError = null; header();
    try { const result = await request(`/api/debates/${id}/${verb}`, {}); applySnapshot(result); refreshList(); }
    catch (error) { if (id === selectedId && owner === generation && visible) { actionError = error; report(error); } else toast(error.message); }
    finally { busy = false; header(); }
  }
  function start() {
    if (started) return;
    started = true;
    for (const prefix of ['debate', 'debateContinue']) {
      $(`${prefix}Rounds`).min = String(MIN_DEBATE_ROUNDS);
      on($(`${prefix}Prompt`), 'input', () => { if (draft) draft.text = $(`${prefix}Prompt`).value; });
      on($(`${prefix}Rounds`), 'input', () => {
        if (draft) draft.rounds = Number($(`${prefix}Rounds`).value);
        $(`${prefix}Budget`).textContent = `${Number($(`${prefix}Rounds`).value) * 2} responses`;
      });
      on($(`${prefix}Attach`), 'click', () => $(`${prefix}FileInput`).click());
      on($(`${prefix}FileInput`), 'change', (event) => { addFiles([...event.target.files]); event.target.value = ''; });
      on($(`${prefix}Prompt`), 'paste', (event) => {
        const files = [...event.clipboardData?.items ?? []].filter((item) => item.kind === 'file').map((item) => item.getAsFile());
        if (files.length) { event.preventDefault(); addFiles(files); }
      });
    }
    on($('newDebateBtn'), 'click', () => select(null));
    on($('debateRefresh'), 'click', () => loadList(null));
    on($('debateForm'), 'submit', launch);
    on($('debateContinueForm'), 'submit', continueCycle);
    for (const agent of ['A', 'B']) on($(`debateModel${agent}`), 'change', () => updateEffort(agent));
    on($('debateResume'), 'click', () => action('start'));
    on($('debateStop'), 'click', () => action('stop'));
    on($('debateOlder'), 'click', () => loadHistory(before));
    on($('debateLatest'), 'click', () => { finals = false; loadHistory(null); });
    on($('debateFinals'), 'click', () => { finals = !finals; loadHistory(null); });
    on(windowRef, 'focus', refreshList);
  }
  async function restoreSelection() {
    const ticket = generation;
    let id;
    try { id = windowRef.sessionStorage?.getItem('piDebateSelection'); } catch { return; }
    if (!id) return;
    try {
      const record = remember(await request(`/api/debates/${encodeURIComponent(id)}`));
      if (ticket === generation) select(record);
    } catch (error) { toast(error.message); }
  }
  function dispose() {
    const savedId = visible ? selectedId : null;
    hide(); started = false; listRequest++;
    if (savedId) {
      try { windowRef.sessionStorage?.setItem('piDebateSelection', savedId); } catch { /* storage may be unavailable */ }
    }
    if (listTimer !== null) cancel(listTimer);
    for (const controller of requests) controller.abort();
    for (const owner of drafts.values()) for (const reader of owner.readers) {
      reader.onload = reader.onloadend = reader.onerror = null;
      reader.abort();
    }
    drafts.clear();
    for (const cleanup of cleanups.splice(0)) cleanup();
  }
  function submit() {
    if (!visible || busy) return;
    if (selectedId === null) $('debateForm').requestSubmit();
    else if (snapshot?.status === 'completed') $('debateContinueForm').requestSubmit();
  }
  function openSection() {
    const id = lastSelections.get(state.activeTabId);
    select(state.debates.get(id) ?? null);
  }
  return { start, show, hide, dispose, loadList, refreshList, restoreSelection, addFiles, openSection, submit, has: (id) => id === null || state.debates.has(id) };
}
