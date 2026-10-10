// Preloaded into the n8n process (NODE_OPTIONS=--require, see n8n/compose.override.yml).
//
// Makes Node's built-in fetch use HTTP/1.1 instead of HTTP/2.
//
// Why: the n8n image runs Node 26, whose fetch negotiates HTTP/2 with hosts
// that offer it. The n8n Assistant sends several requests to OpenRouter at
// once over one shared HTTP/2 connection; when the server closes that
// connection, the retries reuse it and every attempt fails with
//   AI_APICallError: Cannot connect to API: The session has been destroyed
//   (ERR_HTTP2_INVALID_SESSION)
// Separate HTTP/1.1 connections do not have this failure mode. Found
// 2026-10-10 on n8n 2.42.6 (Node 26.7.0, undici 8.9.0).
//
// Never throws: if no usable undici package is found, n8n starts unchanged
// and a warning line is printed to its log.
'use strict';

const PNPM_DIR = '/usr/local/lib/node_modules/n8n/node_modules/.pnpm';

function versionOf(dirName) {
  const m = /^undici@(\d+)\.(\d+)\.(\d+)/.exec(dirName);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

try {
  const fs = require('node:fs');
  const path = require('node:path');

  // Newest undici 7.x or 8.x shipped with n8n (both speak the dispatcher
  // interface used by Node 26's built-in fetch).
  const candidates = fs
    .readdirSync(PNPM_DIR)
    .map((d) => ({ dir: d, v: versionOf(d) }))
    .filter((c) => c.v && (c.v[0] === 7 || c.v[0] === 8))
    .sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
  if (candidates.length === 0) throw new Error('no undici 7.x/8.x package found');

  const { Agent, setGlobalDispatcher } = require(path.join(PNPM_DIR, candidates[0].dir, 'node_modules', 'undici'));
  setGlobalDispatcher(new Agent({ allowH2: false }));
  // NODE_OPTIONS reaches every Node process in the container (CLI commands,
  // `docker exec ... node`), so confirm only in the main server: plain `n8n`
  // or `n8n start`. Failures below are always reported.
  const sub = process.argv[2];
  if (/(^|\/)n8n$/.test(process.argv[1] || '') && (sub === undefined || sub === 'start')) {
    process.stderr.write(`[n8n-local] fetch uses HTTP/1.1 (undici ${candidates[0].v.join('.')} dispatcher)\n`);
  }
} catch (err) {
  process.stderr.write(`[n8n-local] force-http1 not applied, fetch unchanged: ${err && err.message}\n`);
}
