# Open issues

What needs attention on this n8n install, most urgent first. Each item says
why it matters, how to fix it, and how to tell it is fixed. Checked on
2026-10-09 against n8n 2.42.6; times are UTC, as in `n8nctl.log`.
[learn.md](learn.md) explains the background; section numbers below refer
to it.

When an item is done, delete it here and mention it in the commit message.

## Summary

| # | Issue | Priority | Effort |
| --- | --- | --- | --- |
| 1 | About 705 emails passed over without labels (cause fixed) | Optional | 15 min |
| 2 | 20 blank Notion pages; 8 business emails to re-send | Now | 15 min |
| 3 | Large uploads fail with `bad record mac` (home network) | Soon | 15 min |
| 4 | Wrapper's module list is stale (2.35.3) | Soon | 15 min |
| 5 | Version numbers in README and CLAUDE.md are stale | Soon | 10 min |
| 6 | Scheduled workflows will skip missed runs (2.36 change) | Before activating them | 5 min |
| 7 | No repeatable template import command | Later | 1-2 h |
| 8 | Templates not imported, or imported with missing nodes | Optional | varies |
| 9 | Housekeeping: duplicates, old exports, backup pruning | Later | 10 min |
| 10 | Accepted risks to re-check | Review | none |
| 11 | Two n8n.io imports need community nodes (`CUSTOM.scrapeNinja`, Blotato) | Before running them | 15 min |

## 1. About 705 emails passed over without labels

**Status:** open, optional. The cause is fixed.

**What:** between 21:21 and 22:31 UTC on 2026-10-09, *Auto-label incoming
Gmail messages with AI* failed 72 times, first because OpenAI rejected the
key, then because the template only handled one email per run while the
trigger was working through a backlog of ten at a time. The trigger had
already marked those emails as seen, so about 705 emails were passed over
without labels. They are still in Gmail, just unlabelled.

Fixed on 2026-10-09: new OpenAI key in the *OpenAI account* credential;
the label steps now map each email to its own label IDs (one *Map labels
to IDs* Code node replaced *Split out*, *Merge* and *Aggregate*, and *Get
all labels* runs once per run). First run after the fix labelled 3 of 8
emails, the rest needed no label. Undo point: `n8n-backups/20261009-223039`.

**To do, if wanted:** a one-off relabelling run over those emails, the
same way as the Notion backfill in item 2. Ask for it.

## 2. Blank pages in Notion and 8 business emails not saved

**Status:** open; the cause is fixed.

**What:** *Gmail Inbox Triage* read the subject as `subject`, but the Gmail
trigger sends `Subject`, so every subject was empty. Notion then created
each page with a blank title, and n8n's Notion node crashed reading that
title (`Cannot read properties of undefined (reading 'plain_text')`). That
left **20 untitled pages** under *n8n Email Inbox* in Notion (created
17:20 to 18:13 EDT on 2026-10-09), and **8 business emails** were never
saved, because each crash stopped its run part-way.

Fixed on 2026-10-09 at 22:13 UTC: *Classify Email* reads `Subject`, and
*Save To Notion* falls back to `(no subject)`. First run after the fix
succeeded. Undo point: `n8n-backups/20261009-221316`.

**To do:** delete the 20 untitled pages in Notion. Do **not** use
*Retry* on the failed executions to fill the gap: a retry resumes at the
failed node with the data it already had, empty subjects included, so it
only adds `(no subject)` pages. A proper backfill is a one-off run over the
28 affected emails, 20 with a blank page and 8 with none (their Gmail
message IDs are in the stored executions):
fetch each message, then create its Notion page. Ask for it if those emails
matter; the trigger will not pick them up again on its own, because it
already marked them as seen.

## 3. Large uploads fail with `bad record mac`

**Status:** open. Not an n8n, Docker or LinkedIn fault.

**What:** on 2026-10-11 at 05:24 and 05:25 UTC a workflow's LinkedIn node
failed four times with `ssl/tls alert bad record mac ... SSL alert number
20` (the stack goes through `linkedInApiRequest`, `requestOAuth2`). The
server received encrypted data that did not match its checksum, i.e. bytes
were damaged on the way. Tested the same day with 2 MB POSTs, 15 per host:

| From | api.linkedin.com | api.github.com |
| --- | --- | --- |
| the Mac | 1 failed | 2 failed |
| the n8n container | 1 failed | 3 failed |

Requests of 64 KB never failed; 1-5 MB ones failed to every host tried,
Anthropic included. So the fault is between the Mac and the internet. No
VPN, proxy or network extension is active. The Mac is on Wi-Fi `en1`
(802.11ax, 6 GHz, 160 MHz channel, signal -42 dBm) behind the router at
`10.0.0.1`. Restarting n8n does not help. Large Assistant requests (long
conversations) can fail the same way.

Re-tested at about 14:15 UTC the same day: 0 of 60 failed, from both sides.
So it comes and goes, and a passing check proves little on its own.

One lead: the Mac's network counters show no bad packets, so the bytes
were probably damaged before the Mac checksummed them, not in transit.
`en1` has TCP segmentation offload on (`TSO4,TSO6`), a known cause of this.
Testing it only means something while failures are happening.

**Fix, easiest first:** while it is failing, turn TSO off
(`sudo sysctl -w net.inet.tcp.tso=0`, undone by a reboot or `=1`) and
re-run the check below; if that clears it, make the setting permanent.
Otherwise restart the router; move the Mac to the 5 GHz band; try Ethernet
or a phone hotspot to find which link is at fault. As a workaround that
does not fix the cause, set **Retry On Fail** on the LinkedIn node
(Settings tab: 3 tries, about 5 s apart).

On 2026-10-12 TSO was turned off on this Mac (until the next reboot);
the check has not been run since.

**Done when:** this check reports `0 failed` from the Mac and from the
container on several days, and the LinkedIn node stops failing:

```bash
node test/netcheck.js
docker exec -i n8n-n8n-1 node - < test/netcheck.js
```

[test/netcheck.js](../test/netcheck.js) sends 2 MB of the letter `a` with
no credentials, 15 times to each host; servers answer 401 or 404, which
counts as a pass. Only a dropped connection counts as a failure, and the
script exits 1 if there was one. Arguments change the count and hosts:
`node test/netcheck.js 30 api.anthropic.com`.

## 4. Wrapper's module list is stale

**Status:** open.

**What:** `KNOWN_MODULES` in `n8nctl.sh` (line 48) mirrors n8n 2.35.3. n8n
2.42.6 has five more: `promotions`, `engine-v2`, `policy-infrastructure`,
`type-availability-policies`, `instance-reporting`. `./n8nctl.sh modules
--enable type-availability-policies` (needed for 2.42's restricted-node
panel) is refused as unknown, though n8n would accept it.

**Fix:** copy the list from the running version:

```bash
docker exec n8n-n8n-1 sh -c 'cat $(find /usr/local/lib/node_modules/n8n/node_modules/@n8n/backend-common/dist -name modules.config.js | head -1)' | sed -n '/MODULE_NAMES = \[/,/\];/p'
```

Update `KNOWN_MODULES`, add a `check` line in `test/smoke.sh` for one new
module, and change "2.35.3" to "2.42.6" where the docs describe the list
(CLAUDE.md line 79; README lines 160 and 168). Run
`bash -n n8nctl.sh && shellcheck n8nctl.sh && test/smoke.sh`.

**Done when:** the smoke test passes and `modules --enable
type-availability-policies` is accepted (then disable it again unless
wanted).

## 5. Stale version numbers in the docs

**Status:** open. `docs/learn.md` is already updated.

| File | Line | Says | Should say |
| --- | --- | --- | --- |
| CLAUDE.md | 43, 63 | `--version 2.35.3` in examples | `2.42.7` |
| CLAUDE.md | 79 | `KNOWN_MODULES` "mirrors `modules.config.ts` at 2.35.3" | after item 4, `2.42.7` |
| README.md | 68, 355 | `2.39.8` in install and upgrade examples | `2.42.7` |
| README.md | 160, 168 | module list "at 2.35.3" | after item 4, `2.42.7` |
| README.md | 430 | "n8n 2.35 ships English only" | "n8n ships English only" |
| README.md | Security notes, Layout | loopback binding as the setup | mention this install's LAN mode (learn.md 17) |

**Done when:** `grep -n '2\.35\|2\.39' README.md CLAUDE.md` shows only
historical log examples.

## 6. Scheduled workflows will skip missed runs

**Status:** no action needed while they are off.

**What:** since 2.36 a Schedule Trigger skips runs missed while n8n was
down or the Mac slept, unless the trigger is set to coalesce them. Three of
your workflows use one, all inactive today: *Weekly Content Generator
(Monday)*, *Daily LinkedIn Poster*, *Weekly Content Pipeline (Gemini →
LinkedIn)*. Since 2026-10-11 the Mac does not sleep on AC power
(`pmset -c sleep 0`), but it still sleeps after 1 minute on UPS power, and
n8n is down whenever the Mac is off or restarting.

**Fix, before activating any of them:** in the trigger's options, choose to
catch up on missed runs if they must not be skipped.

## 7. No repeatable template import

**Status:** open, improvement.

**What:** the 157 templates were imported with one-off scripts that were not
kept. A second import would mean redoing that by hand (learn.md section 19).

Single n8n.io templates can now be imported from the ideas page
(README, "Ideas page"); this item is about batches and files.

**Fix:** add `./n8nctl.sh import <file|folder> [--tag NAME]` to the wrapper.
It should clean each file (strip credentials, fresh `id` and `webhookId`,
`active: false`, tags), skip deprecated node types and invalid JSON with a
reason, create new tags before the batch, take a backup first, log one
line, and report counts. Add smoke tests with a fixture template. Consider a
`templates` subcommand that runs `templates-api/build.py`, and a
`Templates:` line in `status` showing the gallery's health.

## 8. Templates left out or incomplete

**Status:** optional; import by hand if wanted (learn.md section 19).

**Refused by n8n 2.42** (deprecated Function or LangChain Code nodes):

- Create dynamic Twitter profile banner
- OpenAI-powered tweet generator
- LangChain - Example - Code Node Example

**Imported, but a node is missing** until its community package is
installed (Settings, Community nodes):

- Enrich a Google Sheet of companies with EU business register data (Apify)
- GCF Token Optimization — Encode API Data, Decode Losslessly (GCF)
- ⚡AI-Powered YouTube Video Summarization & Analysis (YouTube transcription)

**Foreign-language sample text kept on purpose.** All 157 templates were
checked for language on 2026-10-09, and four Italian ones were translated
(see learn.md section 19). Two keep non-English text because it is what
the workflow works on; translating it would break them. Change only if the
purpose changes:

- *Translate audio using AI*: a French sample sentence, spoken by
  ElevenLabs and then translated back to English.
- *Send daily translated Calvin and Hobbes Comics to Discord*: asks the
  model for the original plus a Korean translation, with a Korean example.
  To use another language, edit the OpenAI node's prompt.

**Broken in the source repo** (invalid JSON, could be reported upstream):

- `OpenAI_and_LLMs/AI-Driven Lead Management and Inquiry Automation with ERPNext & n8n.json`
- `OpenAI_and_LLMs/lemlist __ GPT-3_ Supercharge your sales workflows.json`

## 9. Housekeeping

- **Duplicate workflows:** three called *Auto-label incoming Gmail messages
  with AI*; one active, two archived. Delete the archived two once you are
  sure the active one is the right one.
- **Exports pile up:** `exports/` holds full copies of every workflow, and
  each `templates-api/build.py` run adds one. Delete old ones when no longer
  needed; they are gitignored but readable on disk.
- **Snapshots:** the nightly job prunes to the newest 14 automatically. `20261009-174000` is the only snapshot at n8n 2.35.3, the
  one an upgrade rollback would need; move it to `~/n8n-backups-keep/`
  if you want to keep that option past the next 14 snapshots.
- **Config lives outside git:** `n8n/compose.override.yml` and `n8n/.env`
  (LAN access, the gallery service, `N8N_SECURE_COOKIE`, `N8N_TEMPLATES_HOST`)
  are under the gitignored `n8n/`. Snapshots carry them; git does not.
- **Gallery data is not backed up:** `templates-api/data/` is generated.
  After any `restore`, run `python3 -I templates-api/build.py`.
- **Old OpenRouter key:** the Assistant moved to Anthropic (OpenAI as
  the second key) on 2026-10-11 and `OPENROUTER_API_KEY` was removed from
  `.env`. Snapshots taken before then still hold it in their `.env`, until
  pruned. Revoke it at openrouter.ai if no longer needed, and delete any
  OpenRouter credential under Overview, Credentials that no workflow uses.
- **Newer n8n:** on 2.42.7 since 2026-10-13. Patches now install nightly;
  2.43 is in beta and becomes stable in about a week. When the nightly
  notification says it is out, read the 2.43 release notes, then follow
  learn.md section 11.

## 10. Accepted risks to re-check

Chosen deliberately on 2026-10-09. Re-check if the network or the use
changes.

- **n8n depends on `runtime/force-http1.cjs`** (2026-10-10). It is
  preloaded into n8n to stop the Assistant's `The session has been
  destroyed` errors (HTTP/2 under Node 26). After every n8n upgrade, check
  `./n8nctl.sh logs n8n | grep n8n-local` says `fetch uses HTTP/1.1`. If a
  later n8n fixes the HTTP/2 problem itself, remove the preload (README,
  Troubleshooting).
- **The project lives on the Seagate USB drive, and Docker reads files
  from it.** `runtime/` (n8n), `templates-api/` (gallery) and
  `searxng-settings.yml` are bind mounts. On 2026-10-11 all three had gone
  dead inside the running containers (`ls: ... Bad file descriptor`); the
  gallery answered HTTP 500, and n8n kept going only because it had already
  loaded `force-http1.cjs`. The power log showed the Mac sleeping and waking
  on a USB connect event that morning. `./n8nctl.sh stop` then `start`
  recreated the containers and fixed it. To prevent it, set the same day:
  `pmset -a disksleep 0` and `pmset -c sleep 0` (check with
  `pmset -g custom`; the `Disk sleep should be non-zero` warning for UPS
  Power is expected). Check the mounts with
  `docker exec n8n-n8n-1 ls /opt/n8n-local`. Moving the project to the
  internal disk would remove the risk.
- **Plain HTTP on the home network** (learn.md 17). `N8N_SECURE_COOKIE=false`,
  port 5678 open on every interface, macOS firewall off. Logins and
  sessions are readable by anything on the network. Safer options: a
  pf firewall rule allowing only known machines, an HTTPS reverse proxy, or
  Tailscale.
- **Templates gallery without a login** (learn.md 20). Port 5690 serves
  every workflow tagged `template` to anyone on the network. Today that is
  only public templates; never tag a private workflow.
- **The browser sends n8n's cookies to the gallery.** Both share the host
  name, and the editor makes gallery requests with credentials. `server.py`
  reads only `Origin` and `Host`, to decide whether to send CORS headers,
  and never logs headers; keep it that way when changing it.
- **A script from the gallery runs inside the editor** (2026-10-12).
  `EXTERNAL_FRONTEND_HOOKS_URLS` loads `templates-api/web/editor-hook.js`
  into every editor page, with the editor's full privileges, over the same
  plain HTTP as the editor. Keep it small: no network requests, no reading
  of n8n data. It types a prompt into the Assistant only when the tab was
  opened from the ideas page, and never sends it. Whoever can edit the repo
  can change what runs in the editor.
- **The gallery server talks to n8n.io for any LAN client** (2026-10-12).
  Searches on the n8n.io tab and every non-local template id go to
  `api.n8n.io` (no browser headers, one host, 4-hour cache, 8 MB cap).
  Imported n8n.io templates are community code: read before running.
  `TEMPLATES_UPSTREAM: ''` in the override turns it off.
- **`localhost` webhook and OAuth URLs** (learn.md 17). Connect OAuth
  credentials only from this Mac; replace `localhost` in webhook URLs when
  calling them from another machine.
- **Owner account reset** (learn.md 18). The reset on 2026-10-09 removed
  the old account's settings and any MFA. If MFA was in use, turn it back on
  under Settings, Personal.

## 11. Two n8n.io imports need community nodes

**Status:** open, waiting for the packages to be installed.

**What:** two templates imported from the n8n.io library on 2026-10-13
(00:07 and 00:09 UTC) use nodes this n8n does not have. Running the first
fails with `Problem running workflow. Unrecognized node type:
CUSTOM.scrapeNinja`.

| Workflow | ID | Nodes it lacks |
| --- | --- | --- |
| Scrape any web page into structured JSON data with ScrapeNinja and AI (n8n.io 2812) | `aKElXQarE96OY3Ch` | 3 x `CUSTOM.scrapeNinja` |
| Generate AI viral videos with NanoBanana & VEO3, shared on socials via Blotato | `hJLR8b5GhnKP7V3F` | 10 x `@blotato/n8n-nodes-blotato.blotato` |

`CUSTOM.<name>` is the type n8n gives nodes loaded from a local custom-nodes
folder, so the template's author had ScrapeNinja installed by hand. The npm
package `n8n-nodes-scrapeninja` (0.4.1, last release 2025-02-06) has the
same node, `scrapeNinja` version 1, with every operation the template uses
(`scrape`, `cleanup-html`, `extract-custom`), but installed it is called
`n8n-nodes-scrapeninja.scrapeNinja`. Installing the package is not enough;
the three nodes also need the new type. Blotato's nodes already carry their
package name, so installing that package is all they need.

Both packages are third-party code that runs inside n8n. ScrapeNinja bundles
jsdom, cheerio, `@n8n/vm2` (to run the generated extraction code) and
pg-promise.

**Fix, ScrapeNinja:**

1. Settings, Community nodes, Install: `n8n-nodes-scrapeninja`.
2. `./n8nctl.sh backup` as an undo point.
3. Give the three nodes the installed type and re-import the workflow under
   its own ID:

   ```bash
   docker exec -u node n8n-n8n-1 n8n export:workflow --id=aKElXQarE96OY3Ch --output=/tmp/scrape.json
   docker exec -u node n8n-n8n-1 sed -i 's/"CUSTOM\.scrapeNinja"/"n8n-nodes-scrapeninja.scrapeNinja"/g' /tmp/scrape.json
   docker exec -u node n8n-n8n-1 n8n import:workflow --input=/tmp/scrape.json
   docker exec -u node n8n-n8n-1 rm /tmp/scrape.json
   ```

4. `python3 -I templates-api/build.py`, so the gallery knows the package:
   from then on, n8n.io templates using `CUSTOM.scrapeNinja` are imported
   with the installed type (README, "Ideas page").
5. Add a ScrapeNinja API credential and a Google Gemini credential to the
   nodes that ask for them.

**Fix, Blotato:** install `@blotato/n8n-nodes-blotato` the same way and run
`build.py`, or delete the workflow if it is not wanted.

**Done when:** both workflows open without unrecognized nodes, a manual run
of the ScrapeNinja one gets past the scrape step, and
`curl -s http://Maliks-Mac-Studio.local:5690/api/local/node-types | grep -o '"customMap":{[^}]*}'`
lists `CUSTOM.scrapeNinja`. Item 8 covers older templates with missing
nodes.
