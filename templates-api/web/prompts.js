// Prompt generator page. Served by templates-api (server.py) at /prompts.
//
// Sends {goal} as a POST to the production webhook of the n8n workflow
// "AI Prompt Generator — Multi-Model Evaluation" (ai-prompt-generator) and
// shows the three versions it answers with, each more refined than the last:
// {goal, best_prompt, choices: [{level, label, prompt}]}. An answer with only
// best_prompt (the workflow before 2026-10-24) shows as one version. The browser calls n8n
// directly: n8n's webhook answers CORS for this origin, and server.py's CSP
// for this page allows connections to the editor's port. Results are kept in
// localStorage (this browser only); everything is put on the page as text.
'use strict';

(function () {
  const $ = (sel) => document.querySelector(sel);
  const WORKFLOW_ID = 'aY4Q1DmIxBDcsVpW';
  const WEBHOOK_PATH = 'webhook/ai-prompt-generator';
  const HISTORY_KEY = 'n8n-local:prompt-history';
  const HISTORY_MAX = 20;
  const TIMEOUT_MS = 5 * 60 * 1000;
  // What each refinement level adds (Refiner 2 and 3 in the workflow).
  const LEVEL_HELP = {
    1: 'The evaluator’s pick from the three agents’ drafts.',
    2: 'Sharpened: role, audience, constraints and output format spelled out.',
    3: 'Production-ready: context, steps, quality criteria, edge cases and an example.',
  };
  const EXAMPLES = [
    'A LinkedIn post announcing a new feature to small-business owners',
    'A cold email asking a busy CTO for a 15-minute demo',
    'Summarize a week of customer support tickets into trends and fixes',
    'A YouTube Short script that explains n8n in 45 seconds',
  ];

  // --- editor origin: the same rules as app.js ---------------------------------
  function homeNetworkHost(host) {
    host = host.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host.endsWith('.local') || host === location.hostname.toLowerCase() ||
      /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host);
  }

  function editorOrigin() {
    const candidates = [new URLSearchParams(location.search).get('editor')];
    try { candidates.push(localStorage.getItem('n8n-local:editor')); } catch (e) { /* storage blocked */ }
    for (const c of candidates) {
      if (!c) continue;
      try {
        const u = new URL(c);
        if (/^https?:$/.test(u.protocol) && homeNetworkHost(u.hostname)) return u.origin;
      } catch (e) { /* not a URL */ }
    }
    return `${location.protocol}//${location.hostname}:5678`;
  }

  const EDITOR = editorOrigin();
  const WEBHOOK = `${EDITOR}/${WEBHOOK_PATH}`;
  const links = {
    workflow: `${EDITOR}/workflow/${WORKFLOW_ID}`,
    executions: `${EDITOR}/workflow/${WORKFLOW_ID}/executions`,
    assistant: (prompt) => `${EDITOR}/assistant#n8n-local-prompt=${encodeURIComponent(prompt)}`,
  };

  // --- small helpers --------------------------------------------------------------
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
    return node;
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true, () => false);
    // Plain HTTP on the home network has no async clipboard API.
    const ta = el('textarea', { class: 'visually-hidden', readonly: true });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return Promise.resolve(ok);
  }

  function ago(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(ts).toLocaleDateString();
  }

  function words(text) { return (text.match(/\S+/g) || []).length; }

  // The versions in an answer (or a saved entry), lowest level first.
  function choicesOf(data) {
    if (data && Array.isArray(data.choices)) {
      const list = data.choices
        .map((c, i) => ({
          level: Number(c && c.level) || i + 1,
          label: String((c && c.label) || `Version ${i + 1}`),
          prompt: c && typeof c.prompt === 'string' ? c.prompt.trim() : '',
        }))
        .filter((c) => c.prompt)
        .sort((a, b) => a.level - b.level);
      if (list.length) return list;
    }
    const best = data && typeof data.best_prompt === 'string' ? data.best_prompt.trim() : '';
    return best ? [{ level: 1, label: 'Best prompt', prompt: best }] : [];
  }

  // --- history (this browser only) -------------------------------------------------
  function loadHistory() {
    try {
      const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      if (!Array.isArray(list)) return [];
      return list
        .filter((h) => h && typeof h.goal === 'string')
        .map((h) => Object.assign(h, { choices: choicesOf(h) }))
        .filter((h) => h.choices.length);
    } catch (e) { return []; }
  }
  function saveHistory(list) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX))); } catch (e) { /* storage blocked */ }
  }

  let history = loadHistory();
  let shown = null;  // the entry in the result panel

  function renderHistory() {
    $('#history-sec').hidden = history.length === 0;
    $('#history-count').textContent = String(history.length);
    $('#history').replaceChildren(...history.map((h) => el('li', {},
      el('button', { type: 'button', 'aria-current': String(h === shown), onclick: () => showResult(h) },
        el('span', { class: 'h-goal', text: h.goal }),
        el('span', { class: 'h-when', text: ago(h.at) }),
        el('span', { class: 'h-prompt', text: (h.choices.length > 1 ? `${h.choices.length} versions · ` : '') + h.choices[0].prompt })))));
  }

  function choiceCard(c, count) {
    const copyBtn = el('button', { class: 'btn primary', type: 'button', text: 'Copy', onclick: () => {
      copy(c.prompt).then((ok) => toast(ok ? `Version ${c.level} copied.` : 'Could not copy; select the text and copy it.'));
    } });
    const help = count > 1 ? LEVEL_HELP[c.level] : null;
    return el('article', { class: `choice${count > 1 && c.level === count ? ' top' : ''}`, 'aria-label': `Version ${c.level}: ${c.label}` },
      el('div', { class: 'choice-head' },
        count > 1 ? el('span', { class: 'meter', 'aria-hidden': 'true' }, [1, 2, 3].map((i) => el('i', { class: i <= c.level ? 'on' : '' }))) : null,
        el('h3', { text: count > 1 ? `${c.level}. ${c.label}` : c.label }),
        el('span', { class: 'tag', text: `${words(c.prompt)} words` })),
      help ? el('p', { class: 'hint choice-help', text: help }) : null,
      el('pre', { class: 'result-text', text: c.prompt }),
      el('div', { class: 'actions' }, copyBtn,
        el('a', { class: 'btn', href: links.assistant(c.prompt), target: '_blank', rel: 'noopener', text: 'Send to the Assistant' })));
  }

  // --- panels ---------------------------------------------------------------------
  function showResult(entry) {
    shown = entry;
    $('#error').hidden = true;
    $('#result-goal').textContent = entry.goal;
    $('#result-h').textContent = entry.choices.length > 1 ? `${entry.choices.length} versions, each more refined` : 'Best prompt';
    $('#result-meta').textContent = entry.seconds ? `${entry.seconds} s` : ago(entry.at);
    $('#choices').replaceChildren(...entry.choices.map((c) => choiceCard(c, entry.choices.length)));
    $('#result').hidden = false;
    renderHistory();
  }

  function showError(title, text, actions) {
    $('#error-title').textContent = title;
    $('#error-text').textContent = text;
    $('#error-actions').replaceChildren(...(actions || []));
    $('#error').hidden = false;
  }

  const executionsLink = () => el('a', { class: 'btn', href: links.executions, target: '_blank', rel: 'noopener', text: 'See the run in n8n' });
  const workflowLink = () => el('a', { class: 'btn', href: links.workflow, target: '_blank', rel: 'noopener', text: 'Open the workflow' });

  // --- running ----------------------------------------------------------------------
  let running = null;  // { controller, timer, started, cancelled }

  function setRunning(on) {
    $('#go').disabled = on;
    $('#go').textContent = on ? 'Generating…' : 'Generate prompt';
    $('#again').disabled = on;
    $('#status').hidden = !on;
    if (on) $('#elapsed').textContent = '0 s';
  }

  async function generate(goal) {
    if (running) return;
    const controller = new AbortController();
    const started = Date.now();
    running = { controller, started, cancelled: false, timedOut: false };
    running.timer = setInterval(() => { $('#elapsed').textContent = `${Math.round((Date.now() - started) / 1000)} s`; }, 500);
    const timeout = setTimeout(() => { running.timedOut = true; controller.abort(); }, TIMEOUT_MS);
    // A new run replaces what is shown; earlier results stay under Recent.
    $('#error').hidden = true;
    $('#result').hidden = true;
    shown = null;
    renderHistory();
    setRunning(true);
    const state = running;
    try {
      let res;
      try {
        res = await fetch(WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ goal }),
          signal: controller.signal,
          credentials: 'omit',
        });
      } catch (e) {
        if (state.cancelled) {
          showError('Cancelled', 'The page stopped waiting. The workflow may still finish in n8n and save its result to Supabase.', [executionsLink()]);
        } else if (state.timedOut) {
          showError('No answer after 5 minutes', 'The workflow is taking unusually long. Check its run in n8n.', [executionsLink()]);
        } else {
          showError('Could not reach n8n', `Nothing answered at ${WEBHOOK}. Check that n8n is running (./n8nctl.sh status) and that this page can reach port 5678.`);
        }
        return;
      }
      const raw = await res.text();
      let data = null;
      try { data = JSON.parse(raw); } catch (e) { /* not JSON */ }
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { /* plain string */ } }
      if (res.status === 404) {
        showError('The webhook is not active', 'n8n has no published workflow at this address. Open the workflow and choose Publish, then try again.', [workflowLink()]);
        return;
      }
      if (!res.ok) {
        const msg = data && (data.message || data.error) ? String(data.message || data.error) : `HTTP ${res.status}`;
        showError('The workflow failed', `n8n answered: ${msg}. The run in n8n shows which step stopped and why.`, [executionsLink()]);
        return;
      }
      const choices = choicesOf(data);
      if (!choices.length) {
        showError('No prompt came back', 'The workflow answered, but without any prompt. Its run in n8n shows what the evaluator and refiners returned.', [executionsLink()]);
        return;
      }
      const entry = { goal, choices, at: Date.now(), seconds: Math.round((Date.now() - started) / 1000) };
      history = [entry, ...history].slice(0, HISTORY_MAX);
      saveHistory(history);
      showResult(entry);
      $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } finally {
      clearInterval(state.timer);
      clearTimeout(timeout);
      running = null;
      setRunning(false);
    }
  }

  // --- wiring -------------------------------------------------------------------------
  function start() {
    const goal = $('#goal');
    const updateCount = () => {
      $('#count').textContent = `${goal.value.length} / 4000`;
      goal.removeAttribute('aria-invalid');
    };

    $('#link-workflow').href = links.workflow;
    $('#curl').textContent = `curl -X POST '${WEBHOOK}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"goal": "A LinkedIn post announcing our new feature"}'`;

    $('#examples').replaceChildren(el('span', { class: 'label', text: 'Try:' }), ...EXAMPLES.map((text) =>
      el('button', { class: 'chip', type: 'button', text, onclick: () => { goal.value = text; updateCount(); goal.focus(); } })));

    goal.addEventListener('input', updateCount);
    goal.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#form').requestSubmit(); }
    });
    $('#form').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = goal.value.trim();
      if (!text) {
        goal.setAttribute('aria-invalid', 'true');
        goal.focus();
        toast('Describe what the prompt should achieve first.');
        return;
      }
      generate(text);
    });
    $('#cancel').addEventListener('click', () => { if (running) { running.cancelled = true; running.controller.abort(); } });
    $('#again').addEventListener('click', () => { if (shown) { goal.value = shown.goal; updateCount(); generate(shown.goal); } });
    $('#clear').addEventListener('click', () => {
      history = [];
      saveHistory(history);
      renderHistory();
      toast('Recent results cleared from this browser.');
    });

    renderHistory();
    if (history.length) showResult(history[0]);
    goal.focus();
  }

  start();
})();
