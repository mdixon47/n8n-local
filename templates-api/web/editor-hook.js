// Loaded into the n8n editor through EXTERNAL_FRONTEND_HOOKS_URLS
// (n8n/compose.override.yml); n8n adds it as a <script> in index.html.
//
// 1. Links to n8n.io/workflows (the Assistant's "See all" under its
//    suggestions, the AI panel's template link) open this instance's ideas
//    page instead, served by templates-api next to this file.
// 2. When the ideas page sends a prompt to the Assistant, it opens
//    /assistant#n8n-local-prompt=<text>. This script drops the fragment
//    straight away and, only if the tab was opened from the ideas page, types
//    the text into the Assistant's input. It never sends it.
//
// It runs with the editor's full privileges, so it stays small: no network
// requests, no reading of n8n data, nothing stored but the pending prompt
// (sessionStorage, this tab only, dropped after 10 minutes or once used).
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
  function ideasUrl(href) {
    var target = new URL(GALLERY + '/');
    target.searchParams.set('editor', location.origin);
    try {
      var m = /^\/workflows\/categories\/([a-z0-9-]+)/.exec(new URL(href).pathname);
      if (m) target.searchParams.set('topic', m[1]);
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
