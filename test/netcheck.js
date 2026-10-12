// Upload check for "ssl/tls alert bad record mac" (docs/issues.md item 3).
//
// Sends 2 MB POSTs of the letter "a", without credentials, to each host and
// counts dropped connections. A 401 or 404 answer is a pass: the server
// received the whole body intact. Exits 1 if any request failed.
//
//   node test/netcheck.js [count] [host ...]
//   docker exec -i n8n-n8n-1 node - [count] [host ...] < test/netcheck.js
//
// Defaults: 15 requests each to api.linkedin.com and api.github.com.
// It only tells you something while the failures are happening.
'use strict';

const https = require('node:https');

const SIZE = 2 * 1024 * 1024;
const args = process.argv.slice(2).filter((a) => a !== '-');
const count = /^\d+$/.test(args[0] || '') ? Number(args.shift()) : 15;
const hosts = args.length ? args : ['api.linkedin.com', 'api.github.com'];
const body = Buffer.alloc(SIZE, 97);

function post(host) {
  return new Promise((resolve) => {
    const req = https.request(
      { host, path: '/x', method: 'POST', timeout: 30000, agent: false, headers: { 'content-length': SIZE } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(null));
      },
    );
    req.on('error', (err) => resolve(err));
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.end(body);
  });
}

(async () => {
  let total = 0;
  for (const host of hosts) {
    const reasons = new Map();
    for (let i = 0; i < count; i++) {
      const err = await post(host);
      if (err) {
        const why = (err.code || err.message || 'error').toString().slice(0, 80);
        reasons.set(why, (reasons.get(why) || 0) + 1);
      }
    }
    const failed = [...reasons.values()].reduce((a, b) => a + b, 0);
    total += failed;
    const detail = failed ? ` (${[...reasons].map(([w, n]) => `${n}x ${w}`).join(', ')})` : '';
    console.log(`${host} 2MB x${count}: ${failed} failed${detail}`);
  }
  process.exitCode = total ? 1 : 0;
})();
