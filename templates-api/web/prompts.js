// Prompt generator page. Served by templates-api (server.py) at /prompts.
//
// Three steps against the production webhook of the n8n workflow
// "AI Prompt Generator — Multi-Model Evaluation" (ai-prompt-generator):
//   1. goal    -> POST {mode: "clarify", goal}
//                 <- {summary, questions: [{id, question, options}], fallback}
//   2. brief   -> the questions, answered or left blank; a live preview shows
//                 the brief exactly as the workflow builds it (Read Goal)
//   3. versions-> POST {mode: "generate", goal, answers: [{question, answer}]}
//                 <- {goal, brief, best_prompt, choices: [{level, label, prompt}]}
// Older workflow versions: no clarify step (it generates at once, shown as a
// result), or only best_prompt (shown as one version). The browser calls n8n
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
  let brief = null;  // { goal, summary, questions, fallback } from the clarify step

  // The same text the workflow's Read Goal node builds from goal + answers.
  function briefText(goal, answers) {
    const done = (answers || []).filter((a) => a.question && a.answer);
    return done.length
      ? `Goal: ${goal}\n\nClarified creative brief:\n${done.map((a) => `- ${a.question} ${a.answer}`).join('\n')}`
      : `Goal: ${goal}`;
  }

  function setStep(n) {
    document.body.dataset.step = String(n);
    for (const li of document.querySelectorAll('#steps li')) {
      const i = Number(li.dataset.step);
      li.classList.toggle('done', i < n);
      if (i === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    }
  }

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
    $('#result-brief').textContent = entry.brief || `Goal: ${entry.goal}`;
    $('#adjust').hidden = !(entry.questions && entry.questions.length);
    $('#choices').replaceChildren(...entry.choices.map((c) => choiceCard(c, entry.choices.length)));
    $('#result').hidden = false;
    setStep(3);
    renderHistory();
  }

  // --- step 2: the brief -------------------------------------------------------------
  function hideBrief() {
    brief = null;
    $('#brief').hidden = true;
  }

  function currentAnswers() {
    return [...document.querySelectorAll('#questions .q-answer')].map((input) => ({
      question: input.dataset.question,
      answer: input.value.trim().slice(0, 300),
    }));
  }

  function updatePreview() {
    if (!brief) return;
    $('#brief-preview').textContent = briefText(brief.goal, currentAnswers());
    for (const input of document.querySelectorAll('#questions .q-answer')) {
      for (const chip of input.closest('.question').querySelectorAll('.chip')) {
        chip.setAttribute('aria-pressed', String(chip.textContent === input.value.trim()));
      }
    }
  }

  function renderBrief(prefill) {
    const given = new Map((prefill || []).map((a) => [a.question, a.answer]));
    $('#brief-summary').textContent = brief.summary;
    $('#brief-fallback').hidden = !brief.fallback;
    $('#questions').replaceChildren(...brief.questions.map((q, i) => {
      const id = `q-${i}`;
      const input = el('input', { class: 'q-answer', id, type: 'text', maxlength: '300', autocomplete: 'off',
        placeholder: q.options.length ? 'Pick one above, or type your own' : 'Type an answer, or leave blank',
        'data-question': q.question, oninput: updatePreview });
      input.value = given.get(q.question) || '';
      return el('div', { class: 'question' },
        el('label', { class: 'q-label', for: id, text: q.question }),
        q.options.length ? el('div', { class: 'q-options' }, q.options.map((o) => el('button', {
          class: 'chip', type: 'button', text: o, 'aria-pressed': 'false',
          onclick: () => { input.value = input.value.trim() === o ? '' : o; updatePreview(); },
        }))) : null,
        input);
    }));
    $('#brief').hidden = false;
    setStep(2);
    updatePreview();
  }


  function showError(title, text, actions) {
    $('#error-title').textContent = title;
    $('#error-text').textContent = text;
    $('#error-actions').replaceChildren(...(actions || []));
    $('#error').hidden = false;
  }

  const executionsLink = () => el('a', { class: 'btn', href: links.executions, target: '_blank', rel: 'noopener', text: 'See the run in n8n' });
  const workflowLink = () => el('a', { class: 'btn', href: links.workflow, target: '_blank', rel: 'noopener', text: 'Open the workflow' });

  // --- calling the workflow -----------------------------------------------------------
  let running = null;  // { controller, timer, cancelled, timedOut }

  const STATUS = {
    clarify: ['Reading your goal…', 'A strategist works out which details would change the result most. Usually 5 to 15 seconds.'],
    generate: ['Generating…', 'Creative, marketing and technical agents draft from your brief in parallel, an evaluator picks the best, then two passes refine it. Usually 30 to 90 seconds.'],
  };

  function setRunning(kind) {
    $('#go').disabled = !!kind;
    $('#go').textContent = kind === 'clarify' ? 'Reading your goal…' : 'Clarify the brief';
    $('#generate').disabled = !!kind;
    $('#generate').textContent = kind === 'generate' ? 'Generating…' : 'Generate 3 versions';
    $('#again').disabled = !!kind;
    $('#adjust').disabled = !!kind;
    $('#status').hidden = !kind;
    if (kind) {
      [$('#status-title').textContent, $('#status-hint').textContent] = STATUS[kind];
      $('#elapsed').textContent = '0 s';
    }
  }

  // POST to the webhook. Returns { data, seconds }, or null after showing what went wrong.
  async function call(kind, payload) {
    if (running) return null;
    const controller = new AbortController();
    const started = Date.now();
    const state = running = { controller, cancelled: false, timedOut: false };
    state.timer = setInterval(() => { $('#elapsed').textContent = `${Math.round((Date.now() - started) / 1000)} s`; }, 500);
    const timeout = setTimeout(() => { state.timedOut = true; controller.abort(); }, TIMEOUT_MS);
    $('#error').hidden = true;
    setRunning(kind);
    try {
      let res;
      try {
        res = await fetch(WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
          credentials: 'omit',
        });
      } catch (e) {
        if (state.cancelled) {
          showError('Cancelled', kind === 'generate'
            ? 'The page stopped waiting. The workflow may still finish in n8n and save its result to Supabase.'
            : 'The page stopped waiting for the questions.', kind === 'generate' ? [executionsLink()] : []);
        } else if (state.timedOut) {
          showError('No answer after 5 minutes', 'The workflow is taking unusually long. Check its run in n8n.', [executionsLink()]);
        } else {
          showError('Could not reach n8n', `Nothing answered at ${WEBHOOK}. Check that n8n is running (./n8nctl.sh status) and that this page can reach port 5678.`);
        }
        return null;
      }
      const raw = await res.text();
      let data = null;
      try { data = JSON.parse(raw); } catch (e) { /* not JSON */ }
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { /* plain string */ } }
      if (res.status === 404) {
        showError('The webhook is not active', 'n8n has no published workflow at this address. Open the workflow and choose Publish, then try again.', [workflowLink()]);
        return null;
      }
      if (!res.ok) {
        const msg = data && (data.message || data.error) ? String(data.message || data.error) : `HTTP ${res.status}`;
        showError('The workflow failed', `n8n answered: ${msg}. The run in n8n shows which step stopped and why.`, [executionsLink()]);
        return null;
      }
      return { data, seconds: Math.round((Date.now() - started) / 1000) };
    } finally {
      clearInterval(state.timer);
      clearTimeout(timeout);
      running = null;
      setRunning(null);
    }
  }

  function addResult(goal, answers, questions, summary, data, seconds) {
    const choices = choicesOf(data);
    if (!choices.length) {
      showError('No prompt came back', 'The workflow answered, but without any prompt. Its run in n8n shows what the evaluator and refiners returned.', [executionsLink()]);
      return;
    }
    const entry = {
      goal, choices, at: Date.now(), seconds,
      answers: answers.filter((a) => a.answer),
      questions, summary,
      brief: data && typeof data.brief === 'string' ? data.brief : briefText(goal, answers),
    };
    history = [entry, ...history].slice(0, HISTORY_MAX);
    saveHistory(history);
    showResult(entry);
    $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function clearResult() {
    $('#result').hidden = true;
    shown = null;
    renderHistory();
  }

  // Step 1 -> 2
  async function clarify(goal) {
    clearResult();
    hideBrief();
    setStep(1);
    const r = await call('clarify', { mode: 'clarify', goal });
    if (!r) return;
    const qs = r.data && Array.isArray(r.data.questions) ? r.data.questions : [];
    const questions = qs
      .map((q) => ({ question: String((q && q.question) || '').trim(), options: (Array.isArray(q && q.options) ? q.options : []).map(String).filter(Boolean).slice(0, 4) }))
      .filter((q) => q.question)
      .slice(0, 5);
    if (questions.length) {
      brief = { goal, summary: String((r.data && r.data.summary) || goal), questions, fallback: !!(r.data && r.data.fallback) };
      renderBrief();
      $('#brief').scrollIntoView({ behavior: 'smooth', block: 'start' });
      const first = $('#questions .q-answer');
      if (first) first.focus({ preventScroll: true });
      return;
    }
    // A workflow version without the clarify step generates straight away.
    if (choicesOf(r.data).length) {
      addResult(goal, [], null, null, r.data, r.seconds);
      toast('This workflow version has no clarify step, so it generated directly.');
      return;
    }
    showError('No questions came back', 'The workflow answered without questions. Its run in n8n shows what the clarifier returned.', [executionsLink()]);
  }

  // Step 2 -> 3
  async function generate(goal, answers, questions, summary) {
    clearResult();
    const r = await call('generate', { mode: 'generate', goal, answers });
    if (!r) return;
    hideBrief();
    addResult(goal, answers, questions, summary, r.data, r.seconds);
  }

  // --- wiring -------------------------------------------------------------------------
  function start() {
    const goal = $('#goal');
    const updateCount = () => {
      $('#count').textContent = `${goal.value.length} / 4000`;
      goal.removeAttribute('aria-invalid');
    };

    $('#link-workflow').href = links.workflow;
    $('#curl').textContent = [
      `# 1. questions for the brief`,
      `curl -X POST '${WEBHOOK}' -H 'Content-Type: application/json' \\`,
      `  -d '{"mode": "clarify", "goal": "A LinkedIn post announcing our new feature"}'`,
      ``,
      `# 2. three versions from the clarified brief (blank answers are skipped)`,
      `curl -X POST '${WEBHOOK}' -H 'Content-Type: application/json' \\`,
      `  -d '{"mode": "generate", "goal": "A LinkedIn post announcing our new feature",`,
      `       "answers": [{"question": "Who is it for?", "answer": "Small-business owners"}]}'`,
    ].join('\n');

    $('#examples').replaceChildren(el('span', { class: 'label', text: 'Try:' }), ...EXAMPLES.map((text) =>
      el('button', { class: 'chip', type: 'button', text, onclick: () => { goal.value = text; updateCount(); goal.focus(); } })));

    goal.addEventListener('input', () => {
      updateCount();
      // A changed goal needs its own questions.
      if (brief && goal.value.trim() !== brief.goal) { hideBrief(); setStep(1); }
    });
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
      clarify(text);
    });
    const startGenerate = () => { if (brief) generate(brief.goal, currentAnswers(), brief.questions, brief.summary); };
    $('#generate').addEventListener('click', startGenerate);
    $('#brief').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); startGenerate(); }
      else if (e.key === 'Enter' && e.target.classList.contains('q-answer')) {
        e.preventDefault();  // Enter moves to the next answer, not off the page
        const inputs = [...document.querySelectorAll('#questions .q-answer')];
        const next = inputs[inputs.indexOf(e.target) + 1];
        if (next) next.focus(); else $('#generate').focus();
      }
    });
    $('#edit-goal').addEventListener('click', () => { hideBrief(); setStep(1); goal.focus(); goal.select(); });
    $('#cancel').addEventListener('click', () => { if (running) { running.cancelled = true; running.controller.abort(); } });
    $('#again').addEventListener('click', () => {
      if (!shown) return;
      goal.value = shown.goal;
      updateCount();
      generate(shown.goal, shown.answers || [], shown.questions || null, shown.summary || null);
    });
    $('#adjust').addEventListener('click', () => {
      const entry = shown;  // clearResult() forgets it
      if (!entry || !entry.questions) return;
      goal.value = entry.goal;
      updateCount();
      brief = { goal: entry.goal, summary: entry.summary || entry.goal, questions: entry.questions, fallback: false };
      clearResult();
      renderBrief(entry.answers);
      $('#brief').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#clear').addEventListener('click', () => {
      history = [];
      saveHistory(history);
      renderHistory();
      toast('Recent results cleared from this browser.');
    });

    renderHistory();
    if (history.length) showResult(history[0]); else setStep(1);
    goal.focus();
  }

  start();
})();
