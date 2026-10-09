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
| 1 | Gmail credential expired; two active workflows failing every minute | Now | 2 min |
| 2 | Nightly backups need Full Disk Access for bash | Now | 2 min |
| 3 | Wrapper's module list is stale (2.35.3) | Soon | 15 min |
| 4 | Version numbers in README and CLAUDE.md are stale | Soon | 10 min |
| 5 | Scheduled workflows will skip missed runs (2.36 change) | Before activating them | 5 min |
| 6 | No repeatable template import command | Later | 1-2 h |
| 7 | Templates not imported, or imported with missing nodes | Optional | varies |
| 8 | Housekeeping: duplicates, old exports, backup pruning | Later | 10 min |
| 9 | Accepted risks to re-check | Review | none |

## 1. Gmail credential expired

**Status:** open. Last checked 2026-10-09 18:47 UTC: 21 failures in the
previous 10 minutes.

**What:** the two active workflows, *Gmail Inbox Triage* and *Auto-label
incoming Gmail messages with AI* (the active copy), fail on every poll with:

```
Access could not be refreshed because the connected account has revoked access,
the refresh token expired, or the account password or permissions changed.
```

No email is triaged or labelled until this is fixed.

**Fix:** on this Mac (the OAuth callback is `localhost`, so it cannot be done
from another machine), open <http://localhost:5678>, go to Credentials, open
the Gmail credential, click **Connect my account**, allow access. If the
Google Cloud consent screen is still in *Testing* mode, publish it; Testing
mode expires refresh tokens every seven days and this will recur.

**Done when:** `./n8nctl.sh logs n8n 2>&1 | grep -c 'could not be refreshed'`
stops increasing over ten minutes.

## 2. Nightly backups need one permission

**Status:** fixed except for one macOS permission (2026-10-09).

**What:** the original 03:30 job never ran: launchd could not open its log
on the external drive (`spawn failed`, exit 78). The job now runs at 23:00
and logs to `~/Library/Logs/n8nctl-backup.log`
([backup-plan.md](backup-plan.md)). Its test run through launchd failed
with `bash: ./n8nctl.sh: Operation not permitted`, because macOS stops bash
started by launchd from touching the Seagate drive.

**Fix:** System Settings, Privacy & Security, Full Disk Access, **+**, press
Cmd+Shift+G, type `/bin/bash`, add it and switch it on. Then run the job
once:

```bash
launchctl kickstart -k gui/$(id -u)/com.n8nctl.backup
```

**Done when:** `launchctl print gui/$(id -u)/com.n8nctl.backup | grep 'last
exit code'` shows `0`, the log ends with `+ Backup written to ...`, and
`./n8nctl.sh backups` lists the new snapshot. Then delete this item.

## 3. Wrapper's module list is stale

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
(CLAUDE.md line 79; README lines 159 and 167). Run
`bash -n n8nctl.sh && shellcheck n8nctl.sh && test/smoke.sh`.

**Done when:** the smoke test passes and `modules --enable
type-availability-policies` is accepted (then disable it again unless
wanted).

## 4. Stale version numbers in the docs

**Status:** open. `docs/learn.md` is already updated.

| File | Line | Says | Should say |
| --- | --- | --- | --- |
| CLAUDE.md | 43, 63 | `--version 2.35.3` in examples | `2.42.6` |
| CLAUDE.md | 79 | `KNOWN_MODULES` "mirrors `modules.config.ts` at 2.35.3" | after item 3, `2.42.6` |
| README.md | 67, 354 | `2.39.8` in install and upgrade examples | `2.42.6` |
| README.md | 159, 167 | module list "at 2.35.3" | after item 3, `2.42.6` |
| README.md | 421 | "n8n 2.35 ships English only" | "n8n ships English only" |
| README.md | Security notes, Layout | loopback binding as the setup | mention this install's LAN mode (learn.md 17) |

**Done when:** `grep -n '2\.35\|2\.39' README.md CLAUDE.md` shows only
historical log examples.

## 5. Scheduled workflows will skip missed runs

**Status:** no action needed while they are off.

**What:** since 2.36 a Schedule Trigger skips runs missed while n8n was
down or the Mac slept, unless the trigger is set to coalesce them. Three of
your workflows use one, all inactive today: *Weekly Content Generator
(Monday)*, *Daily LinkedIn Poster*, *Weekly Content Pipeline (Gemini →
LinkedIn)*. The Mac's sleep is currently held off by other apps, which is
not a guarantee.

**Fix, before activating any of them:** in the trigger's options, choose to
catch up on missed runs if they must not be skipped. To keep the Mac awake
for good: System Settings, Energy, "Prevent automatic sleeping when the
display is off".

## 6. No repeatable template import

**Status:** open, improvement.

**What:** the 157 templates were imported with one-off scripts that were not
kept. A second import would mean redoing that by hand (learn.md section 19).

**Fix:** add `./n8nctl.sh import <file|folder> [--tag NAME]` to the wrapper.
It should clean each file (strip credentials, fresh `id` and `webhookId`,
`active: false`, tags), skip deprecated node types and invalid JSON with a
reason, create new tags before the batch, take a backup first, log one
line, and report counts. Add smoke tests with a fixture template. Consider a
`templates` subcommand that runs `templates-api/build.py`, and a
`Templates:` line in `status` showing the gallery's health.

## 7. Templates left out or incomplete

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

## 8. Housekeeping

- **Duplicate workflows:** three called *Auto-label incoming Gmail messages
  with AI*; one active, two archived. Delete the archived two once you are
  sure the active one is the right one.
- **Exports pile up:** `exports/` holds full copies of every workflow, and
  each `templates-api/build.py` run adds one. Delete old ones when no longer
  needed; they are gitignored but readable on disk.
- **Snapshots:** the nightly job prunes to the newest 14 once it runs
  (item 2). `20261009-174000` is the only snapshot at n8n 2.35.3, the
  one an upgrade rollback would need; move it to `~/n8n-backups-keep/`
  if you want to keep that option past the next 14 snapshots.
- **Config lives outside git:** `n8n/compose.override.yml` and `n8n/.env`
  (LAN access, the gallery service, `N8N_SECURE_COOKIE`, `N8N_TEMPLATES_HOST`)
  are under the gitignored `n8n/`. Snapshots carry them; git does not.
- **Gallery data is not backed up:** `templates-api/data/` is generated.
  After any `restore`, run `python3 -I templates-api/build.py`.
- **Newer n8n:** 2.43.x images exist (2.43.3 on 2026-10-09). Read the 2.43
  release notes before moving; follow learn.md section 11.

## 9. Accepted risks to re-check

Chosen deliberately on 2026-10-09. Re-check if the network or the use
changes.

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
  never reads or logs headers; keep it that way when changing it.
- **`localhost` webhook and OAuth URLs** (learn.md 17). Connect OAuth
  credentials only from this Mac; replace `localhost` in webhook URLs when
  calling them from another machine.
- **Owner account reset** (learn.md 18). The reset on 2026-10-09 removed
  the old account's settings and any MFA. If MFA was in use, turn it back on
  under Settings, Personal.
