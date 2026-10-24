// Ideas page for this n8n instance. Served by templates-api (server.py) at /.
//
// Data: api/local/catalog (built by build.py from workflows tagged
// `template`), api/workflows/templates/<id> for one workflow's nodes, and
// ideas.json. The n8n.io library comes through the same server
// (api/n8nio/search, api/templates/workflows/<id>), which fetches it from
// api.n8n.io; importing opens the editor's own route
// /workflows/templates/<id>, which reads the template from that server too.
// Importing also stores the template (POST api/local/library/<id>; the server
// fetches it from n8n.io), and the catalog then lists it under "From n8n.io"
// with source: 'n8nio'. Every piece of template text is put on the page as
// text, never as HTML: templates come from imported workflows.
//
// Links go to the n8n editor: the origin passed as ?editor= by
// editor-hook.js, else this host on port 5678. Prompts for the Assistant
// travel as /assistant#n8n-local-prompt=..., which editor-hook.js types in.
'use strict';

(function () {
  // --- small DOM helpers ----------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const SVG_NS = 'http://www.w3.org/2000/svg';

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

  function svg(tag, attrs, ...children) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) node.setAttribute(k, String(v));
    for (const c of children.flat()) if (c) node.append(c);
    return node;
  }

  // --- editor origin ----------------------------------------------------------
  function homeNetworkHost(host) {
    host = host.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host.endsWith('.local') || host === location.hostname.toLowerCase() ||
      /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host);
  }

  function editorOrigin() {
    const params = new URLSearchParams(location.search);
    const candidates = [params.get('editor')];
    try { candidates.push(localStorage.getItem('n8n-local:editor')); } catch (e) { /* storage blocked */ }
    for (const c of candidates) {
      if (!c) continue;
      try {
        const u = new URL(c);
        if (/^https?:$/.test(u.protocol) && homeNetworkHost(u.hostname)) {
          try { localStorage.setItem('n8n-local:editor', u.origin); } catch (e) { /* ignore */ }
          return u.origin;
        }
      } catch (e) { /* not a URL */ }
    }
    return `${location.protocol}//${location.hostname}:5678`;
  }

  const EDITOR = editorOrigin();
  const links = {
    assistant: (prompt) => `${EDITOR}/assistant` + (prompt ? `#n8n-local-prompt=${encodeURIComponent(prompt)}` : ''),
    template: (id) => `${EDITOR}/templates/${id}`,
    importTemplate: (id) => `${EDITOR}/workflows/templates/${id}`,
    workflow: (id) => `${EDITOR}/workflow/${encodeURIComponent(id)}`,
  };

  // --- data -------------------------------------------------------------------
  const TRIGGERS = ['App event', 'Schedule', 'Webhook', 'Form', 'Chat', 'Sub-workflow', 'Error', 'Manual'];
  const TRIGGER_HELP = {
    'App event': 'Starts when something happens in an app',
    Schedule: 'Runs on a timetable',
    Webhook: 'Starts on an HTTP call',
    Form: 'Starts from an n8n form',
    Chat: 'Starts from a chat message',
    'Sub-workflow': 'Called by another workflow',
    Error: 'Runs when a workflow fails',
    Manual: 'You start it by hand',
  };
  const SIZES = [
    { id: 'quick', name: 'Quick (up to 5 nodes)', test: (n) => n <= 5 },
    { id: 'medium', name: 'Medium (6 to 15)', test: (n) => n > 5 && n <= 15 },
    { id: 'advanced', name: 'Advanced (16+)', test: (n) => n > 15 },
  ];
  const MISSING_HELP = {
    'n8n-nodes-base.executeCommand': 'Execute Command is disabled by default since n8n 2.0',
    'n8n-nodes-base.localFileTrigger': 'Local File Trigger is disabled by default since n8n 2.0',
    'n8n-nodes-base.start': 'Start was removed; use a Manual Trigger instead',
  };
  const TOPIC_GROUP = { 'it-ops': 'ops', marketing: 'content', sales: 'sales', support: 'support', ai: 'ai' };

  let catalog = { categories: [], templates: [] };
  let ideaData = { groups: [], ideas: [] };
  const catName = new Map();

  const state = {
    q: '', group: 'all', cat: null, trig: null, apps: [], size: null, ai: false, runs: false,
    sort: 'relevance', ideasAll: false, tplLimit: 24, appsAll: false, source: 'local',
  };
  const STICKY = 'n8n-nodes-base.stickyNote';
  let localTypes = {};
  let customMap = {}; // CUSTOM.<name> -> installed community type the server maps it to

  // --- text -------------------------------------------------------------------
  // n8n.io descriptions carry some HTML entities (e.g. "-&gt;"). Decoded into text, never parsed as HTML.
  const ENTITIES = { '&gt;': '>', '&lt;': '<', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&amp;': '&' };
  function decode(text) { return String(text || '').replace(/&(?:gt|lt|quot|#39|apos|nbsp|amp);/g, (e) => ENTITIES[e]); }

  function plain(md) {
    return decode(md)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[#*_`>~|]+/g, ' ')
      .replace(/^\s*[-+]\s+/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function inline(text) {
    const out = [];
    const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index).replace(/[*_]{1,2}/g, ''));
      if (m[1]) out.push(el('strong', { text: m[1] }));
      else if (m[2]) out.push(el('code', { text: m[2] }));
      else out.push(el('a', { href: m[4], target: '_blank', rel: 'noopener noreferrer', text: m[3] }));
      last = re.lastIndex;
    }
    if (last < text.length) out.push(text.slice(last).replace(/[*_]{1,2}/g, ''));
    return out;
  }

  // Headings, paragraphs, bullet lists, bold, code and http(s) links; the rest as text.
  function markdown(md) {
    const box = el('div', { class: 'desc' });
    let para = [];
    let list = null;
    const flush = () => {
      if (para.length) box.append(el('p', {}, inline(para.join(' '))));
      para = [];
      if (list) box.append(list);
      list = null;
    };
    for (const raw of decode(md).replace(/\r/g, '').split('\n')) {
      const line = raw.trim().replace(/<[^>]+>/g, '');
      if (!line || /^!\[[^\]]*\]\([^)]*\)$/.test(line) || /^[-=_*]{3,}$/.test(line)) { flush(); continue; }
      const h = /^#{1,6}\s+(.*)$/.exec(line);
      const li = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (h) { flush(); box.append(el('div', { class: 'h' }, inline(h[1]))); }
      else if (li) {
        if (para.length) { box.append(el('p', {}, inline(para.join(' ')))); para = []; }
        list = list || el('ul');
        list.append(el('li', {}, inline(li[1])));
      } else {
        if (list) { box.append(list); list = null; }
        para.push(line);
      }
    }
    flush();
    return box;
  }

  function sizeOf(t) { return SIZES.find((s) => s.test(t.nodeCount)); }

  // --- search and filters -----------------------------------------------------
  function tokens() { return state.q.toLowerCase().split(/\s+/).filter(Boolean); }

  function tplScore(t, toks) {
    let score = 0;
    for (const tok of toks) {
      let s = 0;
      if (t._name.includes(tok)) s += 3;
      if (t._apps.includes(tok)) s += 2;
      if (t._rest.includes(tok)) s += 1;
      if (!s) return 0;
      score += s;
    }
    return score || 1;
  }

  function ideaScore(i, toks) {
    let score = 0;
    for (const tok of toks) {
      const s = (i._title.includes(tok) ? 3 : 0) + (i._rest.includes(tok) ? 1 : 0);
      if (!s) return 0;
      score += s;
    }
    return score || 1;
  }

  function tplPasses(t, skip) {
    if (skip !== 'cat' && state.cat !== null && !t.categoryIds.includes(state.cat)) return false;
    if (skip !== 'trig' && state.trig && !t.triggers.includes(state.trig)) return false;
    if (skip !== 'apps' && state.apps.some((a) => !t.apps.includes(a))) return false;
    if (skip !== 'size' && state.size && sizeOf(t).id !== state.size) return false;
    if (skip !== 'ai' && state.ai && !t.ai) return false;
    if (skip !== 'runs' && state.runs && t.missingNodes.length) return false;
    return true;
  }

  function searched() {
    const toks = tokens();
    return catalog.templates
      .map((t) => ({ t, score: toks.length ? tplScore(t, toks) : 1 }))
      .filter((x) => x.score > 0);
  }

  function ideaTemplates(idea) {
    return catalog.templates.filter((t) => idea._match.every((re) => re.test(t._hay)));
  }

  // --- icons ------------------------------------------------------------------
  // Simple line glyphs (24x24) for n8n's core nodes, which ship no image file.
  const G = {
    pen: ['M4 20h4L19 9l-4-4L4 16z', 'M13 7l4 4'],
    globe: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z', 'M3 12h18', 'M12 3c3 3 3 15 0 18c-3-3-3-15 0-18z'],
    code: ['M8 7l-5 5 5 5', 'M16 7l5 5-5 5'],
    pointer: ['M6 3l13 8-6 2-2 6z'],
    robot: ['M5 9h14v10H5z', 'M12 4v5', 'M9 14h0', 'M15 14h0', 'M2 13v3', 'M22 13v3'],
    spark: ['M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z'],
    branch: ['M6 4v16', 'M6 12h5a7 7 0 0 0 7-7', 'M18 5h0'],
    filter: ['M4 5h16l-6 8v6l-4-2v-4z'],
    bolt: ['M13 3L5 14h6l-1 7 8-11h-6z'],
    reply: ['M9 14l-5-5 5-5', 'M4 9h11a5 5 0 0 1 0 10h-3'],
    chat: ['M4 5h16v11H9l-5 4z'],
    merge: ['M6 4c0 6 6 6 6 10v6', 'M18 4c0 6-6 6-6 10'],
    db: ['M5 6c0-1.7 3-3 7-3s7 1.3 7 3-3 3-7 3-7-1.3-7-3z', 'M5 6v12c0 1.7 3 3 7 3s7-1.3 7-3V6', 'M5 12c0 1.7 3 3 7 3s7-1.3 7-3'],
    split: ['M3 12h7', 'M10 12l9-6', 'M10 12l9 6', 'M10 12h9'],
    gather: ['M21 12h-7', 'M14 12L5 6', 'M14 12l-9 6', 'M14 12H5'],
    loop: ['M4 12a8 8 0 0 1 14-5.3', 'M18 3v4h-4', 'M20 12a8 8 0 0 1-14 5.3', 'M6 21v-4h4'],
    clock: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z', 'M12 7v5l3 2'],
    braces: ['M9 4c-2 0-2 1.5-2 4s-2 4-2 4 2 1.5 2 4 0 4 2 4', 'M15 4c2 0 2 1.5 2 4s2 4 2 4-2 1.5-2 4 0 4-2 4'],
    nested: ['M3 3h11v11H3z', 'M10 10h11v11H10z'],
    noop: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z', 'M8 12h8'],
    doc: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 13h6', 'M9 17h6'],
    form: ['M5 4h14v16H5z', 'M8 9h8', 'M8 13h8', 'M8 17h4'],
    mail: ['M3 6h18v12H3z', 'M3 6l9 7 9-7'],
    lines: ['M4 7h7', 'M13 7h7', 'M4 12h16', 'M4 17h7', 'M13 17h7'],
    image: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M15.5 8.5h0'],
    calc: ['M6 3h12v18H6z', 'M9 7h6', 'M9 12h0', 'M12 12h0', 'M15 12h0', 'M9 16h0', 'M12 16h0', 'M15 16h0'],
    limit: ['M4 6h16', 'M4 12h10', 'M4 18h5'],
    terminal: ['M4 5h16v14H4z', 'M7 9l3 3-3 3', 'M12 15h5'],
  };
  const GLYPH_FOR = {
    'edit-fields': 'pen', 'http-request': 'globe', code: 'code', html: 'code', 'manual-trigger': 'pointer',
    'ai-agent': 'robot', 'basic-llm-chain': 'spark', 'summarization-chain': 'spark', 'question-and-answer-chain': 'spark',
    'information-extractor': 'spark', 'text-classifier': 'spark', 'sentiment-analysis': 'spark',
    if: 'branch', switch: 'branch', filter: 'filter', webhook: 'bolt', 'respond-to-webhook': 'reply',
    'chat-trigger': 'chat', comments: 'chat', merge: 'merge', 'simple-memory': 'db', 'vector-store-question-answer-tool': 'db',
    'split-out': 'split', aggregate: 'gather', 'loop-over-items': 'loop', 'schedule-trigger': 'clock', wait: 'clock',
    'structured-output-parser': 'braces', tools: 'braces', 'sub-workflow-trigger': 'nested', 'call-n8n-sub-workflow-tool': 'nested',
    'execute-workflow': 'nested', 'no-operation': 'noop', markdown: 'doc', 'extract-from-file': 'doc', 'convert-to-file': 'doc',
    'default-data-loader': 'doc', 'read-write-files-from-disk': 'doc', 'form-trigger': 'form', form: 'form',
    'send-mail': 'mail', inbox: 'mail', 'recursive-character-text-splitter': 'lines', 'token-splitter': 'lines',
    'character-text-splitter': 'lines', 'edit-image': 'image', calculator: 'calc', limit: 'limit', 'remove-duplicates': 'limit',
    sort: 'limit', 'execute-command': 'terminal',
  };

  function glyphPaths(n) {
    const name = (n.icon || '').replace(/^(node|fa|file):/, '').replace(/\.svg$/, '');
    const key = GLYPH_FOR[name] || (/trigger$/i.test(n.name) ? 'bolt' : null);
    return key ? G[key] : null;
  }

  function glyphSvg(paths, size) {
    return svg('svg', { viewBox: '0 0 24 24', width: size, height: size, class: 'glyph', 'aria-hidden': 'true' },
      paths.map((d) => svg('path', { d })));
  }

  function initials(name) {
    const words = (name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
    return ((words[0] || '?')[0] + (words[1] ? words[1][0] : '')).toUpperCase();
  }

  function nodeIcon(n) {
    const box = el('span', { class: 'nicon', title: n.displayName });
    if (n.iconPath) {
      box.append(el('img', { src: n.iconPath, alt: '', loading: 'lazy', class: n.iconPathDark ? 'light has-dark' : 'light' }));
      if (n.iconPathDark) box.append(el('img', { src: n.iconPathDark, alt: '', loading: 'lazy', class: 'dark' }));
    } else if (glyphPaths(n)) {
      box.append(glyphSvg(glyphPaths(n), 18));
    } else {
      box.append(el('span', { class: 'mono', text: initials(n.displayName) }));
    }
    return box;
  }

  function cardIcons(t, max) {
    // App icons first (they say the most), then the trigger, then core nodes.
    const isTrig = (n) => /trigger$/i.test(n.name) || n.name.endsWith('.webhook');
    const rank = (n) => (n.iconPath ? 0 : isTrig(n) ? 1 : glyphPaths(n) ? 2 : 3);
    const ordered = [...t.nodes].sort((a, b) => rank(a) - rank(b));
    const row = el('div', { class: 'icons', 'aria-hidden': 'true' });
    ordered.slice(0, max).forEach((n) => row.append(nodeIcon(n)));
    if (ordered.length > max) row.append(el('span', { class: 'nicon more', text: `+${ordered.length - max}` }));
    return row;
  }

  // --- rendering: ideas -------------------------------------------------------
  function ideaCard(idea) {
    const matches = idea._templates.length;
    return el('button', { class: 'card idea-card', type: 'button', onclick: () => openIdea(idea) },
      el('h3', { text: idea.title }),
      el('p', { text: idea.summary }),
      el('div', { class: 'card-foot' },
        el('span', { class: `tag level-${idea.level}`, text: idea.level }),
        el('span', { class: 'tag', text: idea.trigger }),
        idea.apps.slice(0, 3).map((a) => el('span', { class: 'tag', text: a })),
        matches ? el('span', { class: 'tag match', text: `${matches} template${matches > 1 ? 's' : ''}` }) : null));
  }

  function renderIdeas() {
    const toks = tokens();
    const hits = ideaData.ideas
      .map((i) => ({ i, score: toks.length ? ideaScore(i, toks) : 1 }))
      .filter((x) => x.score > 0);
    const inGroup = (x) => state.group === 'all' || x.i.group === state.group;

    const chips = $('#groups');
    chips.replaceChildren();
    const chip = (id, name, n) => el('button', {
      class: 'chip', type: 'button', role: 'tab', 'aria-selected': String(state.group === id),
      onclick: () => { state.group = id; state.ideasAll = false; update(); },
    }, name, el('span', { class: 'n', text: String(n) }));
    chips.append(chip('all', 'All', hits.length));
    for (const g of ideaData.groups) chips.append(chip(g.id, g.name, hits.filter((x) => x.i.group === g.id).length));

    const group = ideaData.groups.find((g) => g.id === state.group);
    $('#group-blurb').textContent = group ? group.blurb : 'Pick a group, or search above.';

    let list = hits.filter(inGroup);
    if (toks.length) list.sort((a, b) => b.score - a.score);
    const limit = state.group === 'all' && !toks.length && !state.ideasAll ? 8 : list.length;
    const grid = $('#idea-grid');
    grid.replaceChildren(...list.slice(0, limit).map((x) => ideaCard(x.i)));
    if (!list.length) grid.append(el('p', { class: 'empty', text: 'No ideas match. The Assistant can still build it: see the box under the templates.' }));
    const more = $('#ideas-more');
    more.hidden = list.length <= limit;
    more.textContent = `Show all ${list.length} ideas`;
    $('#ideas-count').textContent = String(ideaData.ideas.length);
  }

  // --- rendering: templates ---------------------------------------------------
  function templateCard(t) {
    const snippet = plain(t.description);
    return el('button', { class: 'card', type: 'button', onclick: () => openTemplate(t) },
      cardIcons(t, 6),
      el('h3', { text: t.name }),
      snippet ? el('p', { class: 'snippet', text: snippet.slice(0, 220) })
        : el('p', { class: 'snippet flow', text: t.flow.length ? t.flow.join(' → ') : 'No description.' }),
      el('div', { class: 'card-foot' },
        t.triggers[0] ? el('span', { class: 'tag', text: t.triggers[0], title: TRIGGER_HELP[t.triggers[0]] }) : null,
        el('span', { class: 'tag', text: `${t.nodeCount} node${t.nodeCount === 1 ? '' : 's'}` }),
        t.ai ? el('span', { class: 'tag ai', text: 'AI' }) : null,
        t.source === 'n8nio' ? el('span', { class: 'tag', text: 'n8n.io', title: 'Stored from the n8n.io library' }) : null,
        t.missingNodes.length ? el('span', { class: 'tag warn', text: 'Needs a missing node' }) : null));
  }

  function facet(title, items, key, opts) {
    const box = el('div', { class: 'facet' }, el('h3', { text: title }));
    const ul = el('ul');
    let shown = items;
    if (opts && opts.limit && !state.appsAll) shown = items.slice(0, opts.limit);
    for (const it of shown) {
      const pressed = opts && opts.multi ? state[key].includes(it.value) : state[key] === it.value;
      ul.append(el('li', {}, el('button', {
        type: 'button', 'aria-pressed': String(pressed), disabled: !it.n && !pressed, title: it.help,
        onclick: () => {
          if (opts && opts.multi) state[key] = pressed ? state[key].filter((v) => v !== it.value) : [...state[key], it.value];
          else state[key] = pressed ? null : it.value;
          state.tplLimit = 24;
          update();
        },
      }, el('span', { text: it.label }), el('span', { class: 'n', text: String(it.n) }))));
    }
    box.append(ul);
    if (opts && opts.limit && items.length > opts.limit) {
      box.append(el('button', {
        class: 'show-more', type: 'button',
        text: state.appsAll ? 'Show fewer' : `Show all ${items.length}`,
        onclick: () => { state.appsAll = !state.appsAll; renderTemplates(); },
      }));
    }
    return box;
  }

  function toggle(label, key, n, help) {
    const input = el('input', { type: 'checkbox', checked: state[key] });
    input.addEventListener('change', () => { state[key] = input.checked; state.tplLimit = 24; update(); });
    return el('label', { class: 'toggle', title: help }, input, el('span', { text: `${label} (${n})` }));
  }

  function renderFilters(base) {
    const count = (skip, test) => base.filter((x) => tplPasses(x.t, skip) && test(x.t)).length;
    const appCounts = new Map();
    for (const x of base) if (tplPasses(x.t, 'apps')) for (const a of x.t.apps) appCounts.set(a, (appCounts.get(a) || 0) + 1);
    const apps = [...appCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([a, n]) => ({ value: a, label: a, n }));
    for (const a of state.apps) if (!appCounts.has(a)) apps.unshift({ value: a, label: a, n: 0 });

    const box = $('#filters');
    box.replaceChildren(
      facet('Category', catalog.categories.map((c) => ({ value: c.id, label: `${c.icon} ${c.name}`, n: count('cat', (t) => t.categoryIds.includes(c.id)) })), 'cat'),
      facet('Starts with', TRIGGERS.map((k) => ({ value: k, label: k, help: TRIGGER_HELP[k], n: count('trig', (t) => t.triggers.includes(k)) })).filter((x) => x.n || state.trig === x.value), 'trig'),
      facet('Apps', apps, 'apps', { multi: true, limit: 10 }),
      facet('Size', SIZES.map((s) => ({ value: s.id, label: s.name, n: count('size', (t) => sizeOf(t).id === s.id) })), 'size'),
      el('div', { class: 'facet' }, el('h3', { text: 'Only' }),
        toggle('Uses AI', 'ai', count('ai', (t) => t.ai), 'Has an AI agent, chain or model node'),
        toggle('Runs on this n8n', 'runs', count('runs', (t) => !t.missingNodes.length), 'Every node exists on this instance')));
  }

  function renderActive() {
    const box = $('#active-filters');
    box.replaceChildren();
    const pill = (label, clear) => box.append(el('button', { type: 'button', 'aria-label': `Remove filter ${label}`, onclick: () => { clear(); update(); } }, `${label} ✕`));
    if (state.cat !== null) pill(catName.get(state.cat) || 'Category', () => { state.cat = null; });
    if (state.trig) pill(state.trig, () => { state.trig = null; });
    for (const a of state.apps) pill(a, () => { state.apps = state.apps.filter((x) => x !== a); });
    if (state.size) pill(SIZES.find((s) => s.id === state.size).name, () => { state.size = null; });
    if (state.ai) pill('Uses AI', () => { state.ai = false; });
    if (state.runs) pill('Runs on this n8n', () => { state.runs = false; });
    if (box.childElementCount > 1) {
      box.append(el('button', { class: 'clear', type: 'button', text: 'Clear all', onclick: () => {
        Object.assign(state, { cat: null, trig: null, apps: [], size: null, ai: false, runs: false });
        update();
      } }));
    }
  }

  function renderSource() {
    for (const b of document.querySelectorAll('#source .chip')) b.setAttribute('aria-selected', String(b.dataset.source === state.source));
    $('#sort').parentElement.hidden = state.source !== 'local';
  }

  function renderTemplates() {
    renderSource();
    $('#ask').hidden = false;
    $('#ask-text').textContent = state.q
      ? `Describe “${state.q}” to the Assistant and it builds the workflow for you.`
      : 'Describe what you want to automate and the Assistant builds the workflow for you.';
    if (state.source === 'n8nio') {
      if (remote.key !== remoteKey()) fetchRemote(false);
      else renderRemote();
      return;
    }
    const base = searched();
    renderFilters(base);
    renderActive();
    const list = base.filter((x) => tplPasses(x.t));
    const sort = state.sort === 'relevance' && !tokens().length ? 'name' : state.sort;
    const by = {
      relevance: (a, b) => b.score - a.score || a.t._name.localeCompare(b.t._name),
      name: (a, b) => a.t._name.localeCompare(b.t._name),
      newest: (a, b) => (b.t.createdAt || '').localeCompare(a.t.createdAt || ''),
      simplest: (a, b) => a.t.nodeCount - b.t.nodeCount || a.t._name.localeCompare(b.t._name),
    }[sort];
    list.sort(by);

    const grid = $('#tpl-grid');
    grid.replaceChildren(...list.slice(0, state.tplLimit).map((x) => templateCard(x.t)));
    if (!list.length) grid.append(el('p', { class: 'empty', text: 'No templates match these filters.' }));
    const more = $('#tpl-more');
    more.hidden = list.length <= state.tplLimit;
    more.textContent = `Show ${Math.min(24, list.length - state.tplLimit)} more (${list.length - state.tplLimit} left)`;
    $('#tpl-count').textContent = list.length === catalog.templates.length ? String(list.length) : `${list.length} of ${catalog.templates.length}`;

  }

  // --- URL state --------------------------------------------------------------
  function readUrl() {
    const p = new URLSearchParams(location.search);
    state.q = p.get('q') || '';
    const topic = p.get('topic');
    state.group = p.get('group') || (topic && TOPIC_GROUP[topic]) || 'all';
    if (!ideaData.groups.some((g) => g.id === state.group)) state.group = 'all';
    const cat = Number(p.get('cat'));
    state.cat = catalog.categories.some((c) => c.id === cat) ? cat : null;
    state.trig = TRIGGERS.includes(p.get('trigger')) ? p.get('trigger') : null;
    state.apps = p.getAll('app');
    state.size = SIZES.some((s) => s.id === p.get('size')) ? p.get('size') : null;
    state.ai = p.get('ai') === '1';
    state.runs = p.get('runs') === '1';
    state.sort = ['relevance', 'name', 'newest', 'simplest'].includes(p.get('sort')) ? p.get('sort') : 'relevance';
    state.source = p.get('source') === 'n8nio' ? 'n8nio' : 'local';
    remote.category = p.get('ncat') || null;
    const n8nio = /^\d{1,9}$/.test(p.get('n8nio') || '') ? p.get('n8nio') : null;
    return { template: p.get('template'), idea: p.get('idea'), n8nio };
  }

  function writeUrl(open) {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.group !== 'all') p.set('group', state.group);
    if (state.cat !== null) p.set('cat', String(state.cat));
    if (state.trig) p.set('trigger', state.trig);
    for (const a of state.apps) p.append('app', a);
    if (state.size) p.set('size', state.size);
    if (state.ai) p.set('ai', '1');
    if (state.runs) p.set('runs', '1');
    if (state.sort !== 'relevance') p.set('sort', state.sort);
    if (state.source !== 'local') p.set('source', state.source);
    if (state.source === 'n8nio' && remote.category) p.set('ncat', remote.category);
    if (open && open.n8nio) p.set('n8nio', String(open.n8nio));
    if (open && open.template) p.set('template', String(open.template));
    if (open && open.idea) p.set('idea', open.idea);
    const qs = p.toString();
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
  }

  let openItem = null;
  function update() {
    renderIdeas();
    renderTemplates();
    writeUrl(openItem);
  }

  // --- clipboard, toast, Assistant hand-off -------------------------------------
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

  function sendToAssistant(prompt) {
    const text = prompt.trim();
    window.open(links.assistant(text), '_blank', 'noopener');
    copy(text).then((ok) => toast(ok
      ? 'Opening the Assistant with your prompt. It is also on the clipboard.'
      : 'Opening the Assistant with your prompt.'));
  }

  // --- workflow diagram ---------------------------------------------------------
  const W = 56;
  const H = 56;

  function diagram(wf, t) {
    const nodes = (wf.nodes || []).filter((n) => n.type !== 'n8n-nodes-base.stickyNote' && Array.isArray(n.position));
    if (!nodes.length) return null;
    const meta = new Map(t.nodes.map((n) => [n.name, n]));
    const pos = new Map(nodes.map((n) => [n.name, { x: n.position[0], y: n.position[1], n }]));
    const xs = nodes.map((n) => n.position[0]);
    const ys = nodes.map((n) => n.position[1]);
    const pad = 40;
    const padX = 80; // room for labels wider than a node at either end
    const minX = Math.min(...xs) - padX;
    const minY = Math.min(...ys) - pad;
    const width = Math.max(...xs) - minX + W + padX;
    const height = Math.max(...ys) - minY + H + 34 + pad;

    const edges = svg('g');
    for (const [src, outputs] of Object.entries(wf.connections || {})) {
      const a = pos.get(src);
      if (!a) continue;
      for (const [kind, lists] of Object.entries(outputs || {})) {
        for (const list of lists || []) {
          for (const c of list || []) {
            const b = pos.get(c.node);
            if (!b) continue;
            let d;
            if (kind === 'main') {
              const x1 = a.x - minX + W, y1 = a.y - minY + H / 2, x2 = b.x - minX, y2 = b.y - minY + H / 2;
              const dx = Math.max(40, Math.abs(x2 - x1) / 2);
              d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
            } else {
              // AI sub-nodes (model, memory, tools) sit under the node they serve.
              const x1 = a.x - minX + W / 2, y1 = a.y - minY, x2 = b.x - minX + W / 2, y2 = b.y - minY + H;
              const dy = Math.max(30, Math.abs(y1 - y2) / 2);
              d = `M${x1},${y1} C${x1},${y1 - dy} ${x2},${y2 + dy} ${x2},${y2}`;
            }
            edges.append(svg('path', { d, class: kind === 'main' ? 'edge' : 'edge ai' }));
          }
        }
      }
    }

    const group = svg('g');
    for (const { x, y, n } of pos.values()) {
      const m = meta.get(n.type) || { displayName: n.type.split('.').pop() };
      const trigger = /trigger$/i.test(n.type) || n.type.endsWith('.webhook');
      const missing = t.missingNodes.includes(n.type);
      const g = svg('g', { class: `node${trigger ? ' trigger' : ''}${missing ? ' missing' : ''}`, transform: `translate(${x - minX},${y - minY})` },
        svg('title', {}, document.createTextNode(`${n.name} (${m.displayName})`)),
        svg('rect', { width: W, height: H, rx: trigger ? 22 : 12 }));
      if (m.iconPath) {
        g.append(svg('image', { href: m.iconPath, x: 12, y: 12, width: 32, height: 32, class: m.iconPathDark ? 'light has-dark' : 'light' }));
        if (m.iconPathDark) g.append(svg('image', { href: m.iconPathDark, x: 12, y: 12, width: 32, height: 32, class: 'dark' }));
      } else if (glyphPaths(m)) {
        const gl = glyphSvg(glyphPaths(m), 28);
        gl.setAttribute('x', 14);
        gl.setAttribute('y', 14);
        g.append(gl);
      } else {
        const txt = svg('text', { x: W / 2, y: H / 2 + 5, 'text-anchor': 'middle', class: 'mono' });
        txt.textContent = initials(m.displayName);
        g.append(txt);
      }
      const label = svg('text', { x: W / 2, y: H + 18, 'text-anchor': 'middle' });
      label.textContent = n.name.length > 24 ? `${n.name.slice(0, 23)}…` : n.name;
      g.append(label);
      group.append(g);
    }
    const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'diagram', role: 'img', 'aria-label': `Diagram of ${t.name}, ${nodes.length} nodes` }, edges, group);
    root.style.minWidth = `${Math.min(Math.max(520, width * 0.55), 1800)}px`;
    return root;
  }

  // --- detail dialog ------------------------------------------------------------
  const dialog = $('#detail');

  function showDialog(eyebrow, title, body, open) {
    $('#detail-eyebrow').textContent = eyebrow;
    $('#detail-title').textContent = title;
    $('#detail-body').replaceChildren(...body);
    openItem = open;
    writeUrl(openItem);
    if (!dialog.open) dialog.showModal();
    $('#detail-body').scrollTop = 0;
  }

  dialog.addEventListener('close', () => { openItem = null; writeUrl(null); });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  $('#detail-close').addEventListener('click', () => dialog.close());

  function promptEditor(prompt, placeholder) {
    const ta = el('textarea', { class: 'prompt-box', 'aria-label': 'Prompt for the Assistant', placeholder });
    ta.value = prompt;
    const send = el('button', { class: 'btn primary', type: 'button', text: 'Send to the Assistant', onclick: () => {
      if (!ta.value.trim()) { ta.focus(); toast('Write what you want first.'); return; }
      sendToAssistant(ta.value);
    } });
    const copyBtn = el('button', { class: 'btn', type: 'button', text: 'Copy prompt', onclick: () => copy(ta.value).then((ok) => toast(ok ? 'Prompt copied.' : 'Could not copy; select the text and copy it.')) });
    return [
      el('div', {}, el('h3', { class: 'label', text: 'Prompt' }), ta),
      el('div', { class: 'actions' }, send, copyBtn),
      el('p', { class: 'hint', text: 'Opens the Assistant in a new tab with this text typed in. Nothing is sent until you press Enter there.' }),
    ];
  }

  function relatedTemplates(list) {
    if (!list.length) return null;
    return el('div', {}, el('h3', { class: 'label', text: `Or start from a template (${list.length})` }),
      el('div', { class: 'related' }, list.slice(0, 6).map((t) => el('button', { class: 'card', type: 'button', onclick: () => openTemplate(t) },
        cardIcons(t, 4), el('h3', { text: t.name }),
        el('div', { class: 'card-foot' }, el('span', { class: 'tag', text: `${t.nodeCount} nodes` }), t.ai ? el('span', { class: 'tag ai', text: 'AI' }) : null)))));
  }

  function openIdea(idea) {
    const group = ideaData.groups.find((g) => g.id === idea.group);
    showDialog(group ? group.name : 'Idea', idea.title, [
      el('p', { class: 'desc', text: idea.summary }),
      el('div', { class: 'meta-row' },
        el('span', { class: `tag level-${idea.level}`, text: idea.level }),
        el('span', { class: 'tag', text: idea.trigger, title: TRIGGER_HELP[idea.trigger] }),
        idea.apps.map((a) => el('span', { class: 'tag', text: a }))),
      ...promptEditor(idea.prompt),
      relatedTemplates(idea._templates),
    ].filter(Boolean), { idea: idea.id });
  }

  function openAsk() {
    const q = state.q.trim();
    const prompt = q ? `Build an n8n workflow for: ${q}. Ask me for anything you need to know before you start.` : '';
    showDialog('Assistant', q ? `Build “${q}”` : 'Describe your workflow', [
      el('p', { class: 'desc', text: 'Say what should start it, what it should do, and where the result goes. Mention the apps you use; the Assistant uses the credentials already on this n8n.' }),
      ...promptEditor(prompt, 'Example: every Friday at 16:00, collect this week’s new rows from my Leads sheet and email me a summary.'),
    ], null);
  }

  function openTemplate(t) {
    const fromN8nio = t.source === 'n8nio';
    const cats = t.categoryIds.map((id) => catName.get(id)).filter(Boolean).join(' · ');
    const diagramBox = el('div', { class: 'diagram-wrap' }, el('p', { class: 'empty', text: 'Loading the diagram…' }));
    const fitIdeas = ideaData.ideas.filter((i) => i._templates.includes(t));

    const adapt = () => {
      const prompt = `Make a copy of my workflow "${t.name}" (ID ${t.workflowId}) and change it so that `;
      showDialog('Adapt with the Assistant', t.name, [
        el('p', { class: 'desc', text: 'Finish the sentence with what you want changed: other apps, a different trigger, extra steps. The Assistant copies the workflow first, so the template stays as it is.' }),
        ...promptEditor(prompt),
        el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', text: '← Back to the template', onclick: () => openTemplate(t) })),
      ], { template: t.id });
    };

    const copyJson = () => {
      fetch(`api/workflows/templates/${t.id}`).then((r) => r.json()).then((data) => {
        const wf = data.workflow || {};
        return copy(JSON.stringify({ name: t.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings }, null, 2));
      }).then((ok) => toast(ok ? 'Workflow JSON copied. Paste it onto an empty canvas in n8n.' : 'Could not copy the workflow.'),
        () => toast('Could not load the workflow.'));
    };

    const body = [
      el('div', { class: 'meta-row' },
        t.triggers.map((k) => el('span', { class: 'tag', text: k, title: TRIGGER_HELP[k] })),
        el('span', { class: 'tag', text: `${t.nodeCount} nodes` }),
        t.ai ? el('span', { class: 'tag ai', text: 'AI' }) : null,
        t.apps.map((a) => el('span', { class: 'tag', text: a }))),
      t.missingNodes.length ? missingNotice(t.missingNodes, (type) => type.split('.').pop()) : null,
      el('div', { class: 'actions' },
        el('a', { class: 'btn primary', href: links.template(t.id), target: '_blank', rel: 'noopener', text: 'Use this template' }),
        // A stored n8n.io template has a workflow here only once it was imported and build.py has run.
        t.workflowId ? el('button', { class: 'btn', type: 'button', text: 'Adapt with the Assistant', onclick: adapt }) : null,
        t.workflowId ? el('a', { class: 'btn', href: links.workflow(t.workflowId), target: '_blank', rel: 'noopener', text: fromN8nio ? 'Open your imported copy' : 'Open the original' }) : null,
        fromN8nio ? el('a', { class: 'btn', href: `https://n8n.io/workflows/${t.id}`, target: '_blank', rel: 'noopener noreferrer', text: 'View on n8n.io' }) : null,
        el('button', { class: 'btn', type: 'button', text: 'Copy workflow JSON', onclick: copyJson })),
      fromN8nio ? el('p', { class: 'hint', text: `Stored from the n8n.io library${t.author ? `, by ${t.author}` : ''}. Written by the n8n community: read its Code and HTTP Request nodes before you run it. To remove it from this page, delete templates-api/library/${t.id}.json.` }) : null,
      diagramBox,
      t.needsCredentials.length ? el('div', {}, el('h3', { class: 'label', text: 'Connect before it runs' }),
        el('div', { class: 'meta-row' }, t.needsCredentials.map((a) => el('span', { class: 'tag', text: a })))) : null,
      el('div', {}, el('h3', { class: 'label', text: 'About' }), t.description ? markdown(t.description)
        : el('p', { class: 'desc', text: t.flow.length ? `No description. It runs: ${t.flow.join(' → ')}.` : 'This template has no description.' })),
      fitIdeas.length ? el('div', {}, el('h3', { class: 'label', text: 'Ideas it fits' }),
        el('div', { class: 'meta-row' }, fitIdeas.map((i) => el('button', { class: 'chip', type: 'button', text: i.title, onclick: () => openIdea(i) })))) : null,
    ].filter(Boolean);
    showDialog(cats || 'Template', t.name, body, { template: t.id });

    fetch(`api/workflows/templates/${t.id}`).then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then((data) => {
      const d = diagram(data.workflow || {}, t);
      diagramBox.replaceChildren(d || el('p', { class: 'empty', text: 'No nodes to draw.' }));
    }, () => diagramBox.replaceChildren(el('p', { class: 'empty', text: 'The diagram could not be loaded.' })));
  }

  // --- stored n8n.io templates ----------------------------------------------------
  function reloadCatalog() {
    return fetch('api/local/catalog').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then((cat) => {
      catalog = cat;
      catName.clear();
      prepare();
      subtitle();
      update();
    });
  }

  // Runs alongside the import link, which opens the editor in a new tab.
  function saveToLibrary(id) {
    fetch(`api/local/library/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then((r) => r.json().then((d) => (r.ok ? d : Promise.reject(new Error(d.message || `HTTP ${r.status}`)))))
      .then((d) => {
        toast(d.stored ? `Imported, and “${d.name}” is now on this page under From n8n.io.` : 'Imported. It was already on this page.');
        return reloadCatalog();
      })
      .catch((err) => toast(`Imported, but not stored on this page: ${err.message}.`));
  }

  // --- n8n.io library -------------------------------------------------------------
  const remote = { key: null, list: [], page: 0, total: null, loading: false, error: '', categories: [], category: null };

  function remoteKey() { return `${state.q}|${remote.category || ''}`; }

  function views(n) {
    if (n >= 10000) return `${Math.round(n / 1000)}k views`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k views`;
    return `${n} view${n === 1 ? '' : 's'}`;
  }

  function resolveType(type) { return customMap[type] || type; }

  function isMissing(type) {
    return type !== STICKY && Object.keys(localTypes).length > 0 && !localTypes[resolveType(type)];
  }

  // What to do about one node type this n8n lacks, as a list item with a link.
  function missingHelp(type, name) {
    if (MISSING_HELP[type]) return el('li', { text: `${MISSING_HELP[type]}.` });
    if (type.startsWith('CUSTOM.')) {
      const short = type.slice('CUSTOM.'.length);
      return el('li', {}, el('strong', { text: name }),
        ` was a custom node on the author's machine. Find its community package on `,
        el('a', { href: `https://www.npmjs.com/search?q=${encodeURIComponent(`keywords:n8n-community-node-package ${short}`)}`, target: '_blank', rel: 'noopener noreferrer', text: 'npm' }),
        ', install it under Settings → Community nodes, run ', el('code', { text: 'python3 -I templates-api/build.py' }),
        ', then import again: the node is then mapped to the installed one.');
    }
    const pkg = type.slice(0, type.lastIndexOf('.'));
    return el('li', {}, el('strong', { text: name }), ': install the community package ',
      el('a', { href: `https://www.npmjs.com/package/${pkg}`, target: '_blank', rel: 'noopener noreferrer' }, el('code', { text: pkg })),
      ' under Settings → Community nodes, then run ', el('code', { text: 'python3 -I templates-api/build.py' }), '.');
  }

  function missingNotice(types, nameOf) {
    return el('div', { class: 'notice' },
      el('strong', { text: 'Not on this n8n. ' }), 'The template imports, but these nodes stay unrecognized and the workflow will not run until they are installed:',
      el('ul', { class: 'help-list' }, types.map((t) => missingHelp(t, nameOf(t)))));
  }

  // An n8n.io node, with this n8n's icon when it has one (n8n.io's own as a fallback).
  function remoteNode(n) {
    const local = localTypes[resolveType(n.name)] || {};
    const out = {
      name: n.name, displayName: n.displayName || local.displayName || String(n.name).split('.').pop(),
      icon: local.icon || n.icon, iconPath: local.iconPath, iconPathDark: local.iconPathDark,
    };
    const data = n.iconData && n.iconData.type === 'file' ? String(n.iconData.fileBuffer || '') : '';
    if (!out.iconPath && /^data:image\/(svg\+xml|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(data)) out.iconPath = data;
    return out;
  }

  function fetchRemote(more) {
    const key = remoteKey();
    if (!more) Object.assign(remote, { key, list: [], page: 0, total: null });
    const page = remote.page + 1;
    remote.loading = true;
    remote.error = '';
    renderRemote();
    const p = new URLSearchParams({ q: state.q, page: String(page), rows: '24' });
    if (remote.category) p.set('category', remote.category);
    fetch(`api/n8nio/search?${p}`)
      .then((r) => r.json().then((d) => (r.ok ? d : Promise.reject(new Error(d.message || `HTTP ${r.status}`)))))
      .then((d) => {
        if (remote.key !== key) return; // a newer search has started
        remote.list = remote.list.concat(d.workflows || []);
        remote.total = d.total || 0;
        remote.page = page;
        if (!remote.category) remote.categories = d.categories || [];
        remote.loading = false;
        renderRemote();
      }, (err) => {
        if (remote.key !== key) return;
        remote.loading = false;
        remote.error = err.message;
        renderRemote();
      });
  }

  function remoteCard(w) {
    const nodes = (w.nodes || []).map(remoteNode);
    const missing = (w.nodes || []).some((n) => isMissing(n.name));
    return el('button', { class: 'card', type: 'button', onclick: () => openRemote(String(w.id)) },
      cardIcons({ nodes }, 6),
      el('h3', { text: w.name }),
      el('p', { class: 'snippet', text: plain(w.description).slice(0, 220) || 'No description.' }),
      el('div', { class: 'card-foot' },
        el('span', { class: 'tag', text: views(w.totalViews || 0) }),
        w.author ? el('span', { class: 'tag', text: w.author }) : null,
        w.price ? el('span', { class: 'tag warn', text: 'Paid' }) : null,
        missing ? el('span', { class: 'tag warn', text: 'Needs a missing node' }) : null));
  }

  function renderRemote() {
    const box = $('#filters');
    const cats = remote.categories.slice().sort((a, b) => b.count - a.count);
    if (remote.category && !cats.some((c) => c.value === remote.category)) cats.unshift({ value: remote.category, count: 0 });
    const ul = el('ul', {}, cats.map((c) => {
      const pressed = remote.category === c.value;
      return el('li', {}, el('button', {
        type: 'button', 'aria-pressed': String(pressed),
        onclick: () => { remote.category = pressed ? null : c.value; update(); },
      }, el('span', { text: c.value }), el('span', { class: 'n', text: c.count ? c.count.toLocaleString() : '' })));
    }));
    box.replaceChildren(
      el('div', { class: 'facet' }, el('h3', { text: 'n8n.io category' }), ul),
      el('p', { class: 'hint', text: 'From n8n.io’s public library, fetched through this machine. Searches here are sent to n8n.io.' }));
    $('#active-filters').replaceChildren(...(remote.category ? [el('button', {
      type: 'button', 'aria-label': `Remove filter ${remote.category}`,
      onclick: () => { remote.category = null; update(); },
    }, `${remote.category} ✕`)] : []));

    const grid = $('#tpl-grid');
    grid.replaceChildren(...remote.list.map(remoteCard));
    if (remote.error) {
      grid.append(el('div', { class: 'empty' }, `Could not reach the n8n.io library: ${remote.error}. `,
        el('button', { class: 'btn', type: 'button', text: 'Try again', onclick: () => fetchRemote(remote.list.length > 0) })));
    } else if (remote.loading && !remote.list.length) {
      grid.append(el('p', { class: 'empty', text: 'Searching n8n.io…' }));
    } else if (!remote.list.length) {
      grid.append(el('p', { class: 'empty', text: 'No n8n.io templates match.' }));
    }
    const more = $('#tpl-more');
    more.hidden = remote.loading || remote.error || remote.total === null || remote.list.length >= remote.total;
    more.textContent = `Show more (${(remote.total - remote.list.length).toLocaleString()} left)`;
    $('#tpl-count').textContent = remote.total === null ? '' : `${remote.total.toLocaleString()} on n8n.io`;
  }

  function stripForPaste(wf, name) {
    const nodes = (wf.nodes || []).map((n) => {
      const copyNode = { ...n };
      delete copyNode.credentials; // the author's credentials mean nothing here
      return copyNode;
    });
    return { name, nodes, connections: wf.connections || {}, settings: { executionOrder: 'v1' } };
  }

  function openRemote(id) {
    showDialog('n8n.io library', 'Loading…', [el('p', { class: 'empty', text: 'Loading the template from n8n.io…' })], { n8nio: id });
    fetch(`api/templates/workflows/${id}`)
      .then((r) => r.json().then((d) => (r.ok ? d : Promise.reject(new Error(d.message || `HTTP ${r.status}`)))))
      .then((d) => {
        if (!openItem || openItem.n8nio !== id) return;
        const w = d.workflow || {};
        const wf = w.workflow || {};
        const types = [...new Set((wf.nodes || []).map((n) => n.type))].filter((t) => t !== STICKY);
        const upstreamNodes = new Map((w.nodes || []).map((n) => [n.name, n]));
        const nodes = types.map((t) => remoteNode(upstreamNodes.get(t) || { name: t }));
        const missing = types.filter(isMissing);
        const shape = { name: w.name || `Template ${id}`, nodes, missingNodes: missing };
        const count = (wf.nodes || []).filter((n) => n.type !== STICKY).length;
        const cats = (w.categories || []).map((c) => c.name).filter(Boolean);
        const author = w.user && (w.user.name || w.user.username);
        const created = w.createdAt ? new Date(w.createdAt) : null;
        const paid = (w.price || 0) > 0 || !!w.purchaseUrl;
        // Unknown node types have no display name on n8n.io: use the node's name in the workflow.
        const nameOf = (t) => {
          const up = upstreamNodes.get(t);
          if (up && up.displayName) return up.displayName;
          const inWf = (wf.nodes || []).find((n) => n.type === t);
          return inWf ? inWf.name : t.split('.').pop();
        };
        const stored = catalog.templates.find((t) => t.templateId === Number(id));
        const actions = el('div', { class: 'actions' });
        const importLink = () => el('a', { class: 'btn primary', href: links.importTemplate(id), target: '_blank', rel: 'noopener', text: missing.length ? 'Import anyway' : 'Import into n8n', onclick: () => saveToLibrary(id) });
        const fillActions = () => actions.replaceChildren(...[
          paid ? null : (missing.length
            ? el('button', { class: 'btn primary', type: 'button', text: 'Import into n8n…', onclick: confirmImport })
            : importLink()),
          paid ? null : el('a', { class: 'btn', href: links.template(id), target: '_blank', rel: 'noopener', text: 'Preview in n8n' }),
          el('a', { class: 'btn', href: `https://n8n.io/workflows/${id}`, target: '_blank', rel: 'noopener noreferrer', text: 'View on n8n.io' }),
          paid ? null : el('button', { class: 'btn', type: 'button', text: 'Copy workflow JSON', onclick: copyJson }),
          stored ? el('button', { class: 'btn', type: 'button', text: 'Open in your templates', onclick: () => openTemplate(stored) }) : null,
        ].filter(Boolean));
        // A template with missing nodes imports, then fails with "Unrecognized node type": say so first.
        function confirmImport() {
          actions.replaceChildren(el('div', { class: 'confirm' },
            el('p', {}, el('strong', { text: `${missing.length} node type${missing.length > 1 ? 's are' : ' is'} not installed. ` }),
              'Install them first (see above) and the workflow runs as it is. Imported now, it opens with those nodes unrecognized.'),
            el('div', { class: 'actions' }, importLink(), el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: fillActions }))));
        }

        const copyJson = () => {
          fetch(`api/workflows/templates/${id}`).then((r) => r.json())
            .then((x) => copy(JSON.stringify(stripForPaste(x.workflow || {}, shape.name), null, 2)))
            .then((ok) => toast(ok ? 'Workflow JSON copied, without credentials. Paste it onto an empty canvas.' : 'Could not copy the workflow.'),
              () => toast('Could not load the workflow.'));
        };

        fillActions();
        const diagramBox = el('div', { class: 'diagram-wrap' });
        diagramBox.append(diagram(wf, shape) || el('p', { class: 'empty', text: 'No nodes to draw.' }));
        $('#detail-eyebrow').textContent = ['n8n.io library', ...cats].join(' · ');
        $('#detail-title').textContent = shape.name;
        $('#detail-body').replaceChildren(...[
          el('div', { class: 'meta-row' },
            el('span', { class: 'tag', text: `${count} nodes` }),
            el('span', { class: 'tag', text: views(w.totalViews || 0) }),
            author ? el('span', { class: 'tag', text: `by ${author}` }) : null,
            created && !isNaN(created) ? el('span', { class: 'tag', text: created.toLocaleDateString() }) : null),
          paid ? el('div', { class: 'notice' }, el('strong', { text: 'Paid template. ' }), 'Buy it on n8n.io; it cannot be imported from here.') : null,
          missing.length ? missingNotice(missing, nameOf) : null,
          actions,
          el('p', { class: 'hint', text: stored
            ? 'Written by the n8n community. Already on this page under From n8n.io. Import creates a new, inactive workflow; read its Code and HTTP Request nodes before you run it.'
            : 'Written by the n8n community. Import creates a new, inactive workflow and keeps the template on this page under From n8n.io; read its Code and HTTP Request nodes before you run it.' }),
          diagramBox,
          el('div', {}, el('h3', { class: 'label', text: 'About' }), w.description ? markdown(w.description) : el('p', { class: 'empty', text: 'No description.' })),
        ].filter(Boolean));
      }, (err) => {
        if (!openItem || openItem.n8nio !== id) return;
        $('#detail-title').textContent = `Template ${id}`;
        $('#detail-body').replaceChildren(el('p', { class: 'empty', text: `Could not load it from n8n.io: ${err.message}.` }),
          el('div', { class: 'actions' }, el('a', { class: 'btn', href: `https://n8n.io/workflows/${id}`, target: '_blank', rel: 'noopener noreferrer', text: 'View on n8n.io' })));
      });
  }

  // --- start --------------------------------------------------------------------
  function prepare() {
    for (const c of catalog.categories) catName.set(c.id, c.name);
    for (const t of catalog.templates) {
      t.triggers = t.triggers || [];
      t.apps = t.apps || [];
      t.needsCredentials = t.needsCredentials || [];
      t.missingNodes = t.missingNodes || [];
      t.flow = t.flow || [];
      const nodeNames = t.nodes.map((n) => n.displayName).join(' ');
      t._name = t.name.toLowerCase();
      t._apps = `${t.apps.join(' ')} ${nodeNames}`.toLowerCase();
      t._rest = `${plain(t.description)} ${t.triggers.join(' ')}`.toLowerCase();
      // Ideas match on what a template is called and uses; descriptions mention too much.
      t._hay = `${t.name} ${t.apps.join(' ')} ${nodeNames}`;
    }
    const groupName = new Map(ideaData.groups.map((g) => [g.id, g.name]));
    for (const i of ideaData.ideas) {
      i._title = i.title.toLowerCase();
      i._rest = `${i.summary} ${i.apps.join(' ')} ${i.prompt} ${groupName.get(i.group) || ''} ${i.trigger}`.toLowerCase();
      i._match = (i.match || []).map((m) => new RegExp(m, 'i'));
      i._templates = i._match.length ? ideaTemplates(i) : [];
    }
  }

  function subtitle() {
    const host = new URL(EDITOR).host;
    $('#sub').textContent = `${ideaData.ideas.length} ideas to build with the Assistant and ${catalog.templates.length} templates from n8n at ${host}.`;
  }

  function start() {
    subtitle();
    $('#link-editor').href = EDITOR;
    $('#link-assistant').href = links.assistant('');

    const open = readUrl();
    const q = $('#q');
    q.value = state.q;
    $('#sort').value = state.sort;
    update();

    let timer = null;
    q.addEventListener('input', () => {
      // A pasted n8n.io template link opens that template, ready to import.
      const pasted = /n8n\.io\/workflows\/(\d+)/.exec(q.value);
      if (pasted) {
        q.value = '';
        state.q = '';
        update();
        openRemote(pasted[1]);
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => { state.q = q.value.trim(); state.tplLimit = 24; update(); }, state.source === 'n8nio' ? 350 : 120);
    });
    for (const b of document.querySelectorAll('#source .chip')) {
      b.addEventListener('click', () => { state.source = b.dataset.source; state.tplLimit = 24; update(); });
    }
    q.addEventListener('keydown', (e) => { if (e.key === 'Escape' && q.value) { q.value = ''; state.q = ''; update(); } });
    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (e.key === '/' && !typing && !dialog.open) { e.preventDefault(); q.focus(); q.select(); }
    });
    $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; update(); });
    $('#ideas-more').addEventListener('click', () => { state.ideasAll = true; renderIdeas(); });
    $('#tpl-more').addEventListener('click', () => {
      if (state.source === 'n8nio') fetchRemote(true);
      else { state.tplLimit += 24; renderTemplates(); }
    });
    $('#ask-btn').addEventListener('click', openAsk);
    const ft = $('#filter-toggle');
    ft.addEventListener('click', () => {
      const openNow = $('#filters').classList.toggle('open');
      ft.setAttribute('aria-expanded', String(openNow));
    });

    if (open.n8nio) {
      openRemote(open.n8nio);
    } else if (open.template) {
      const t = catalog.templates.find((x) => String(x.id) === open.template);
      if (t) openTemplate(t);
    } else if (open.idea) {
      const i = ideaData.ideas.find((x) => x.id === open.idea);
      if (i) openIdea(i);
    }
  }

  Promise.all([
    fetch('api/local/catalog').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`catalog: HTTP ${r.status}`)))),
    fetch('ideas.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`ideas: HTTP ${r.status}`)))),
    fetch('api/local/node-types').then((r) => (r.ok ? r.json() : { types: {} }), () => ({ types: {} })),
  ]).then(([cat, ideas, nodeTypes]) => {
    catalog = cat;
    ideaData = ideas;
    localTypes = nodeTypes.types || {};
    customMap = nodeTypes.customMap || {};
    prepare();
    start();
  }).catch((err) => {
    $('main').replaceChildren(el('p', { class: 'empty', text: `Could not load the gallery data (${err.message}). Run python3 -I templates-api/build.py, then reload.` }));
  });
})();
