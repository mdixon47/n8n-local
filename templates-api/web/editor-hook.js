// Loaded into the n8n editor through EXTERNAL_FRONTEND_HOOKS_URLS
// (n8n/compose.override.yml); n8n adds it as a <script> in index.html.
//
// 1. Links to n8n.io/workflows (the Assistant's "See all" under its
//    suggestions, the AI panel's template link) open this instance's ideas
//    page instead, served by templates-api next to this file. A link to one
//    n8n.io template opens it there, ready to import.
// 2. When the ideas page sends a prompt to the Assistant, it opens
//    /assistant#n8n-local-prompt=<text>. This script drops the fragment
//    straight away and, only if the tab was opened from the ideas page, types
//    the text into the Assistant's input. It never sends it.
// 3. When a workflow is created from a template inside the editor, the
//    template's id goes to the gallery server, which stores it so it stays on
//    the Templates page (POST <gallery>/api/local/library/<id>). That covers
//    the editor's own paths, which the ideas page never sees: "Use template"
//    on a template page, with or without the credential setup step. Signals:
//    n8n's template.open hook (after any import), the move from
//    /templates/<id>/setup to the new workflow, and workflow.afterUpdate for
//    a saved workflow whose meta has a templateId.
// 4. Pin and save AI Assistant chats. On the chat history page
//    (/assistant/history) each chat gets a pin button and a save button;
//    pinned chats come first. The sidebar's Chats section gets a Pinned group,
//    plus "Pin" and "Save" for the chat that is open. A pin is the flag
//    n8nLocalPinned in the chat's metadata, set through n8n's own API
//    (PATCH /rest/instance-ai/threads/<id>; n8n merges metadata, so its own
//    fields stay). Save downloads the chat as Markdown, the same file
//    './n8nctl.sh chats save' writes. If n8n's markup changes, the buttons
//    stop appearing; nothing else is affected.
//
// It runs with the editor's full privileges, so it stays small. Network:
// the template id goes to the gallery without cookies; chat requests go only
// to this n8n, as the signed-in user, like the editor's own. n8n data read:
// the templateId in hook payloads, the chat list, and a chat's messages when
// you press Save (turned into a file in the browser, sent nowhere). Nothing
// is stored but the pending prompt (sessionStorage, this tab only, dropped
// after 10 minutes or once used).
(function () {
  'use strict';

  var self = document.currentScript;
  if (!self || !self.src) return;
  var GALLERY = new URL(self.src).origin;
  var KEY = 'n8n-local:assistant-prompt';
  var MAX_AGE_MS = 10 * 60 * 1000;

  function isTemplateLibrary(href) {
    try {
      var u = new URL(href, location.href);
      return (u.hostname === 'n8n.io' || u.hostname === 'www.n8n.io') && /^\/workflows(\/|$)/.test(u.pathname);
    } catch (e) {
      return false;
    }
  }

  // n8n.io/workflows/categories/<topic>/ -> ?topic=<topic>
  // n8n.io/workflows/<id>-<slug>/        -> that template from the n8n.io library
  function ideasUrl(href) {
    var target = new URL(GALLERY + '/');
    target.searchParams.set('editor', location.origin);
    try {
      var path = new URL(href).pathname;
      var m = /^\/workflows\/categories\/([a-z0-9-]+)/.exec(path);
      var one = /^\/workflows\/(\d+)/.exec(path);
      if (m) target.searchParams.set('topic', m[1]);
      if (one) {
        target.searchParams.set('source', 'n8nio');
        target.searchParams.set('n8nio', one[1]);
      }
    } catch (e) { /* keep the plain page */ }
    return target.href;
  }

  // Rewrite matching links in place, so hover, middle-click and "copy link"
  // all point to the ideas page too.
  function rewrite(root) {
    var links = root.querySelectorAll ? root.querySelectorAll('a[href*="n8n.io/workflows"]') : [];
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (!isTemplateLibrary(a.href)) continue;
      a.setAttribute('href', ideasUrl(a.href));
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
    }
  }

  // Safety net for links the observer has not seen yet, and window.open calls.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || !isTemplateLibrary(a.href)) return;
    e.preventDefault();
    window.open(ideasUrl(a.href), '_blank');
  }, true);
  var open = window.open;
  window.open = function (url) {
    if (typeof url === 'string' && isTemplateLibrary(url)) {
      var args = Array.prototype.slice.call(arguments);
      args[0] = ideasUrl(url);
      return open.apply(window, args);
    }
    return open.apply(window, arguments);
  };

  // --- templates created in the editor -> gallery library --------------------
  var sent = {};
  function storeTemplate(id) {
    id = String(id == null ? '' : id);
    if (!/^\d{1,9}$/.test(id) || sent[id]) return;
    sent[id] = true;
    // Not awaited: n8n waits for its hooks. The server fetches the template
    // from n8n.io itself and answers 409 for a local gallery template.
    fetch(GALLERY + '/api/local/library/' + id, {
      method: 'POST', mode: 'cors', credentials: 'omit',
      headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).catch(function () { /* gallery down: build.py stores it later */ });
  }

  var hooks = window.n8nExternalHooks = window.n8nExternalHooks || {};
  function on(group, event, fn) {
    hooks[group] = hooks[group] || {};
    (hooks[group][event] = hooks[group][event] || []).push(function (stores, payload) {
      try { fn(payload || {}); } catch (e) { /* never break the editor */ }
    });
  }
  on('template', 'open', function (p) { storeTemplate(p.templateId); });
  on('workflow', 'afterUpdate', function (p) {
    var meta = p.workflowData && p.workflowData.meta;
    if (meta) storeTemplate(meta.templateId);
  });

  // The credential setup step creates the workflow without a hook, then
  // replaces /templates/<id>/setup with /workflow/<new id>.
  var lastPath = location.pathname;
  function routeChanged() {
    var setup = /\/templates\/(\d+)\/setup\/?$/.exec(lastPath);
    lastPath = location.pathname;
    if (setup && /\/workflow\/(?!new\b)[^/]+/.test(lastPath)) storeTemplate(setup[1]);
    scheduleChats();
  }
  ['pushState', 'replaceState'].forEach(function (name) {
    var orig = history[name];
    history[name] = function () {
      var out = orig.apply(this, arguments);
      routeChanged();
      return out;
    };
  });
  window.addEventListener('popstate', routeChanged);

  // --- Assistant chats: pin and save ------------------------------------------
  var PIN = 'n8nLocalPinned';
  var UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  var CHAT_PATH = new RegExp('/assistant/(' + UUID + ')(?:[/?#]|$)', 'i');
  var chats = { list: null, at: 0, loading: null };

  function basePath() { return (window.BASE_PATH || '/').replace(/\/?$/, '/'); }

  function api(method, path, body) {
    var headers = {};
    try { headers['browser-id'] = localStorage.getItem('n8n-browserId') || ''; } catch (e) { /* n8n then refuses */ }
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(basePath() + 'rest' + path, {
      method: method, credentials: 'same-origin', headers: headers, body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      if (!r.ok) throw new Error('n8n answered HTTP ' + r.status);
      return r.json();
    }).then(function (j) { return j && j.data !== undefined ? j.data : j; });
  }

  // n8n's /threads answers with the newest 100 chats.
  function loadChats(force) {
    if (!force && chats.list && Date.now() - chats.at < 30000) return Promise.resolve(chats.list);
    if (chats.loading) return chats.loading;
    chats.loading = api('GET', '/instance-ai/threads').then(function (d) {
      chats.list = (d.threads || []).map(function (t) {
        return { id: t.id, title: t.title || 'Untitled chat', createdAt: t.createdAt, updatedAt: t.updatedAt,
          pinned: !!(t.metadata && t.metadata[PIN] === true) };
      });
      chats.at = Date.now();
      chats.loading = null;
      scheduleChats();
      return chats.list;
    }, function (e) { chats.loading = null; chats.at = Date.now(); throw e; });
    return chats.loading;
  }

  function chatById(id) {
    var list = chats.list || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function setPinned(id, pinned) {
    var meta = {};
    meta[PIN] = pinned;
    return api('PATCH', '/instance-ai/threads/' + encodeURIComponent(id), { metadata: meta })
      .then(function () { return loadChats(true); });
  }

  // Markdown, as in './n8nctl.sh chats save'. n8n wraps what you type in
  // context blocks it hides in its own UI; strip them the same way
  // (cleanStoredUserMessage in n8n's instance-ai internal-messages.js).
  var LEADING = /^(?:<thread-context>\n[\s\S]*?\n<\/thread-context>|<running-tasks>\n[\s\S]*?\n<\/running-tasks>|<planned-task-follow-up[\s\S]*?\n<\/planned-task-follow-up>|<planning-blueprint>\n[\s\S]*?\n<\/planning-blueprint>|<background-task-completed>\n[\s\S]*?\n<\/background-task-completed>|<workflow-verification-follow-up>\n[\s\S]*?\n<\/workflow-verification-follow-up>|<workflow-setup-required>\n[\s\S]*?\n<\/workflow-setup-required>|<workflow-setup-state>\n[\s\S]*?\n<\/workflow-setup-state>|<workflow-test-request>\n[\s\S]*?\n<\/workflow-test-request>|<editor-context>\n[\s\S]*?\n<\/editor-context>|<credential-context>\n[\s\S]*?\n<\/credential-context>|<agent-preview-context>\n[\s\S]*?\n<\/agent-preview-context>|<instance-context>\n[\s\S]*?\n<\/instance-context>|<thread-artifacts>\n[\s\S]*?\n<\/thread-artifacts>)(?:\n\n|$)/;
  var TRAILING = ['current-date-time', 'project-context', 'past-conversations', 'ai-preferences', 'onboarding-answer'].map(function (tag) {
    return new RegExp('(?<!\\n)\\n*<' + tag + '>(?:(?!<' + tag + '>)[\\s\\S])*?</' + tag + '>\\s*$');
  });
  function cleanUserText(text) {
    var prev, i;
    do { prev = text; for (i = 0; i < TRAILING.length; i++) text = text.replace(TRAILING[i], ''); } while (text !== prev);
    do { prev = text; text = text.replace(LEADING, ''); } while (text !== prev);
    return text.trim() === '(continue)' ? '' : text;
  }
  function when(v) { return String(v || '').replace('T', ' ').slice(0, 16); }
  function slug(s) {
    return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chat';
  }
  function fileName(t) { return when(t.createdAt).slice(0, 10) + '-' + slug(t.title) + '-' + t.id.slice(0, 8) + '.md'; }
  function markdown(t, messages) {
    var out = ['# ' + t.title, '',
      'Chat with the n8n AI Assistant. Started ' + when(t.createdAt) + ' UTC, last active ' + when(t.updatedAt) +
        ' UTC, ' + messages.length + ' messages. Chat id ' + t.id + '.',
      'Saved ' + when(new Date().toISOString()) + " UTC. The Assistant's reasoning and its tools' inputs and outputs are left out."];
    messages.forEach(function (m) {
      var parts = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [];
      var text = parts.filter(function (p) { return p && p.type === 'text' && p.text; })
        .map(function (p) { return (m.role === 'user' ? cleanUserText(p.text) : p.text).trim(); })
        .filter(Boolean).join('\n\n');
      var tools = parts.filter(function (p) { return p && p.type === 'tool-call'; })
        .map(function (p) { return p.toolName + (p.error || p.state === 'output-error' ? ' (failed)' : ''); });
      if (!text && !tools.length) return;
      out.push('', '### ' + (m.role === 'user' ? 'You' : 'Assistant') + ' · ' + when(m.createdAt), '');
      if (text) out.push(text);
      if (tools.length) out.push((text ? '\n' : '') + '_Tools: ' + tools.join(', ') + '_');
    });
    return out.join('\n') + '\n';
  }

  function saveChat(id) {
    var all = [];
    function page(n) {  // page 0 holds the newest 50
      return api('GET', '/instance-ai/threads/' + encodeURIComponent(id) + '/messages?raw=true&limit=50&page=' + n)
        .then(function (d) {
          var got = d.messages || [];
          all = got.concat(all);
          return got.length === 50 && n < 400 ? page(n + 1) : all;
        });
    }
    return Promise.all([page(0), chatById(id) ? null : loadChats(true)]).then(function (r) {
      var t = chatById(id) || { id: id, title: 'Untitled chat' };
      var name = fileName(t);
      var url = URL.createObjectURL(new Blob([markdown(t, r[0])], { type: 'text/markdown;charset=utf-8' }));
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      return name;
    });
  }

  var toastTimer = null;
  function toast(text) {
    var box = document.getElementById('n8nl-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'n8nl-toast';
      box.setAttribute('role', 'status');
      document.body.appendChild(box);
    }
    box.textContent = text;
    box.className = 'show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.className = ''; }, 3000);
  }

  function pinAction(id, pinned) {
    setPinned(id, !pinned).then(function () { toast(pinned ? 'Chat unpinned' : 'Chat pinned'); },
      function (e) { toast('Could not ' + (pinned ? 'unpin' : 'pin') + ' the chat: ' + e.message); });
  }
  function saveAction(id) {
    toast('Saving the chat…');
    saveChat(id).then(function (name) { toast('Saved ' + name); }, function (e) { toast('Could not save the chat: ' + e.message); });
  }

  function button(cls, label, text, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'n8nl-btn ' + cls;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.textContent = text;
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); onClick(); });
    return b;
  }

  // Inside n8n's own router, so switching chats does not reload the editor.
  function openChat(id, e) {
    if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)) return;
    var app = document.getElementById('app');
    var router = app && app.__vue_app__ && app.__vue_app__.config.globalProperties.$router;
    if (!router) return;  // let the link load the page
    e.preventDefault();
    router.push(basePath().replace(/\/$/, '') + '/assistant/' + id);
  }

  var CSS = [
    '.n8nl-tools{display:inline-flex;gap:2px;flex-shrink:0;opacity:0}',
    '[data-test-id="instance-ai-history-thread"]:hover .n8nl-tools,[data-test-id="instance-ai-history-thread"]:focus-within .n8nl-tools,[data-n8nl-pinned] .n8nl-tools{opacity:1}',
    '@media (hover:none){.n8nl-tools{opacity:1}}',
    '.n8nl-btn{border:0;background:transparent;cursor:pointer;padding:4px 6px;border-radius:4px;font:inherit;font-size:14px;line-height:1;color:var(--color--text--tint-1,#888)}',
    '.n8nl-btn:hover,.n8nl-btn:focus-visible{background:var(--color--background--light-1,rgba(127,127,127,.15));color:var(--color--text,inherit)}',
    '.n8nl-pin[aria-pressed="false"]{filter:grayscale(1);opacity:.55}',
    'div:has(> [data-test-id="instance-ai-history-thread"]){display:flex;flex-direction:column}',
    'div:has(> [data-test-id="instance-ai-history-thread"]) > *{flex-shrink:0}',
    '[data-n8nl-pinned]{order:-1}',
    '.n8nl-pinned{padding:2px 0 6px}',
    '.n8nl-label{font-size:12px;font-weight:600;padding:4px 12px 2px;color:var(--color--text--tint-1,#888)}',
    '.n8nl-item{display:block;padding:6px 12px;border-radius:6px;font-size:13px;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--color--text,inherit)}',
    '.n8nl-item:hover,.n8nl-item[aria-current="page"]{background:var(--color--background--light-1,rgba(127,127,127,.15))}',
    '.n8nl-actions{display:flex;flex-wrap:wrap;gap:4px;padding:2px 8px}',
    '.n8nl-actions .n8nl-btn{font-size:12px;padding:4px 8px;border:1px solid var(--color--foreground,rgba(127,127,127,.35))}',
    '#n8nl-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(20px);opacity:0;pointer-events:none;z-index:99999;',
    'padding:8px 14px;border-radius:8px;font-size:13px;background:#222;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.25);transition:opacity .2s,transform .2s}',
    '#n8nl-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}',
  ].join('\n');

  function decorateChats() {
    var rows = document.querySelectorAll('[data-test-id="instance-ai-history-thread"]');
    var sidebar = document.querySelector('[data-test-id="instance-ai-sidebar-chats"]');
    if (!rows.length && !sidebar) return;
    if (!document.getElementById('n8nl-style')) {
      var style = document.createElement('style');
      style.id = 'n8nl-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    // Refreshed in the background at most every 30 seconds (new chats, renames);
    // a failed load waits as long, not one try per DOM change.
    if (!chats.loading && Date.now() - chats.at > 30000) loadChats().catch(function () { /* signed out */ });
    if (!chats.list) return;
    for (var i = 0; i < rows.length; i++) decorateRow(rows[i]);
    if (sidebar) decorateSidebar(sidebar);
  }

  function decorateRow(row) {
    var link = row.querySelector('a[href]');
    var m = link && CHAT_PATH.exec(link.getAttribute('href') || '');
    if (!m) return;  // agent chats link elsewhere
    var id = m[1];
    var t = chatById(id);
    var pinned = !!(t && t.pinned);
    var tools = row.querySelector('.n8nl-tools');
    if (!tools) {
      tools = document.createElement('span');
      tools.className = 'n8nl-tools';
      tools.appendChild(button('n8nl-pin', 'Pin', '📌', function () { pinAction(id, tools.getAttribute('data-pinned') === '1'); }));
      tools.appendChild(button('n8nl-save', 'Save as Markdown', '⤓', function () { saveAction(id); }));
      row.insertBefore(tools, row.lastElementChild);
    }
    if (tools.getAttribute('data-pinned') !== (pinned ? '1' : '0')) {
      tools.setAttribute('data-pinned', pinned ? '1' : '0');
      var pin = tools.querySelector('.n8nl-pin');
      pin.setAttribute('aria-pressed', String(pinned));
      pin.title = pinned ? 'Unpin' : 'Pin';
      pin.setAttribute('aria-label', pin.title);
    }
    if (pinned !== row.hasAttribute('data-n8nl-pinned')) {
      if (pinned) row.setAttribute('data-n8nl-pinned', '');
      else row.removeAttribute('data-n8nl-pinned');
    }
  }

  function decorateSidebar(sidebar) {
    var m = CHAT_PATH.exec(location.pathname);
    var open = m ? m[1] : null;
    var pinnedList = (chats.list || []).filter(function (t) { return t.pinned; });
    var openChat_ = open ? chatById(open) : null;
    var box = sidebar.querySelector('.n8nl-pinned');
    // Rebuild only when something changed, so this does not feed the observer.
    var key = JSON.stringify([open, openChat_ && openChat_.pinned, pinnedList.map(function (t) { return [t.id, t.title]; })]);
    if (box && box.getAttribute('data-key') === key) return;
    if (!pinnedList.length && !open) { if (box) box.remove(); return; }
    if (!box) {
      box = document.createElement('div');
      box.className = 'n8nl-pinned';
      var header = sidebar.firstElementChild;
      sidebar.insertBefore(box, header ? header.nextSibling : sidebar.firstChild);
    }
    box.setAttribute('data-key', key);
    box.textContent = '';
    if (pinnedList.length) {
      var label = document.createElement('div');
      label.className = 'n8nl-label';
      label.textContent = '📌 Pinned';
      box.appendChild(label);
      pinnedList.forEach(function (t) {
        var a = document.createElement('a');
        a.className = 'n8nl-item';
        a.href = basePath() + 'assistant/' + t.id;
        a.title = t.title;
        a.textContent = t.title;
        if (t.id === open) a.setAttribute('aria-current', 'page');
        a.addEventListener('click', function (e) { openChat(t.id, e); });
        box.appendChild(a);
      });
    }
    if (open) {
      var isPinned = !!(openChat_ && openChat_.pinned);
      var actions = document.createElement('div');
      actions.className = 'n8nl-actions';
      actions.appendChild(button('', isPinned ? 'Unpin this chat' : 'Pin this chat', isPinned ? '📌 Unpin' : '📌 Pin',
        function () { pinAction(open, isPinned); }));
      actions.appendChild(button('', 'Save this chat as Markdown', '⤓ Save', function () { saveAction(open); }));
      box.appendChild(actions);
    }
  }

  var chatsQueued = false;
  function scheduleChats() {
    if (chatsQueued) return;
    chatsQueued = true;
    setTimeout(function () {
      chatsQueued = false;
      try { decorateChats(); } catch (e) { /* never break the editor */ }
    }, 200);
  }

  // --- prompt hand-off from the ideas page -----------------------------------
  function stashPrompt() {
    var m = /(?:^#|&)n8n-local-prompt=([^&]*)/.exec(location.hash);
    if (!m) return;
    history.replaceState(history.state, '', location.pathname + location.search);
    var fromIdeas = false;
    try { fromIdeas = !!document.referrer && new URL(document.referrer).origin === GALLERY; } catch (e) { /* no */ }
    if (!fromIdeas) return;
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ text: decodeURIComponent(m[1]).slice(0, 4000), at: Date.now() }));
    } catch (e) { /* storage blocked: the ideas page also copied the prompt */ }
  }

  function pendingPrompt() {
    try {
      var saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
      if (saved && typeof saved.text === 'string' && Date.now() - saved.at < MAX_AGE_MS) return saved.text;
      sessionStorage.removeItem(KEY);
    } catch (e) { /* ignore */ }
    return null;
  }

  function visible(el) {
    var r = el.getBoundingClientRect();
    return r.width > 120 && r.height > 10 && getComputedStyle(el).visibility !== 'hidden';
  }

  function assistantInput() {
    var all = document.querySelectorAll('[contenteditable="true"], textarea');
    var fallback = null;
    for (var i = 0; i < all.length; i++) {
      if (!visible(all[i])) continue;
      if (all[i].closest('[data-test-id^="instance-ai"]')) return all[i];
      fallback = fallback || all[i];
    }
    return fallback;
  }

  function fill() {
    if (!/\/assistant(\/|$)/.test(location.pathname)) return false;
    var text = pendingPrompt();
    if (text === null) return true;
    var box = assistantInput();
    if (!box) return false;
    box.focus();
    if (box.tagName === 'TEXTAREA') box.select();
    else document.getSelection().selectAllChildren(box);
    if (!document.execCommand('insertText', false, text) && box.tagName === 'TEXTAREA') {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
    try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    return true;
  }

  stashPrompt();

  var filled = false;
  var started = Date.now();
  var queued = false;
  var observer = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j++) if (added[j].nodeType === 1) rewrite(added[j]);
      if (records[i].type === 'attributes') rewrite(records[i].target.parentNode || document);
    }
    scheduleChats();
    if (filled || queued) return;
    queued = true;
    setTimeout(function () {
      queued = false;
      if (!filled) filled = fill() && pendingPrompt() === null;
      if (Date.now() - started > 2 * 60 * 1000 && !pendingPrompt()) filled = true;
    }, 250);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
})();
