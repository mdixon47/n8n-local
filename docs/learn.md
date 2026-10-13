# Learning n8n-local

A guided tour for someone who has never run n8n, or never used this wrapper.
[README.md](../README.md) is the reference; this file is the path through it.
[issues.md](issues.md) lists what currently needs attention on this install.
Each how-to says what to type and what you should see. Commands are run from
the project folder (the one holding `n8nctl.sh`), not from `docs/`.

## Contents

1. [What you have here](#1-what-you-have-here)
2. [Concepts in five minutes](#2-concepts-in-five-minutes)
3. [How-to: first run](#3-how-to-first-run)
4. [How-to: read `status`](#4-how-to-read-status)
5. [How-to: turn on the Assistant](#5-how-to-turn-on-the-assistant)
6. [How-to: your first workflow](#6-how-to-your-first-workflow)
7. [How-to: let the Assistant build one](#7-how-to-let-the-assistant-build-one)
8. [How-to: your first agent](#8-how-to-your-first-agent)
9. [How-to: a fallback provider](#9-how-to-a-fallback-provider)
10. [How-to: the backup drill](#10-how-to-the-backup-drill)
11. [How-to: upgrade and roll back](#11-how-to-upgrade-and-roll-back)
12. [How-to: reach n8n from the internet without opening it up](#12-how-to-reach-n8n-from-the-internet-without-opening-it-up)
13. [How-to: keep the database small](#13-how-to-keep-the-database-small)
14. [How-to: read the log](#14-how-to-read-the-log)
15. [How-to: uninstall cleanly](#15-how-to-uninstall-cleanly)
16. [How-to: move workflows to n8n Cloud](#16-how-to-move-workflows-to-n8n-cloud)
17. [How-to: open n8n to your home network](#17-how-to-open-n8n-to-your-home-network)
18. [How-to: reset the owner password](#18-how-to-reset-the-owner-password)
19. [How-to: import templates from GitHub](#19-how-to-import-templates-from-github)
20. [How-to: your own Templates gallery](#20-how-to-your-own-templates-gallery)
21. [How the wrapper works inside](#21-how-the-wrapper-works-inside)
22. [Glossary](#22-glossary)
23. [FAQ](#23-faq)
24. [Further reading](#24-further-reading)

## 1. What you have here

```
 your browser ──► http://localhost:5678 ──► n8n (the editor and the engine)
   (or, from      or http://<this-mac>.local:5678    │
   another                                          │
   machine) ──► :5690 templates-api                 │
                (your Templates gallery,            │
                 section 20)                        │
                    ┌───────────────────────────────┼──────────────────────────┐
                    │                               │                          │
              runners                          sandbox-api               searxng
        (runs your Code nodes)           + sandbox-runner-1          (private web
                                       (the Assistant's own            search for the
                                        place to run code)             Assistant)
                    └──────────── inside Docker, never published ──────────────┘

 n8n_n8n-data   Docker volume: SQLite database, encryption key, uploaded files
 n8n/.env       versions, secrets, model, keys       (chmod 600, never printed)
 n8nctl.sh      the wrapper you type commands into
 n8nctl.log     what the wrapper did, and the hash of every installer it ran
 templates-api/ the gallery server and its build script (section 20)
 docs/          this guide and issues.md
```

Six long-running containers (plus a one-shot `sandbox-certs` that exits after
start), one data volume, and two published ports: 5678 for n8n and 5690 for
the Templates gallery. A fresh install publishes only 5678 and binds it to
this machine; this install deliberately opens both to the home network
(sections 17 and 20). Everything the wrapper does is a thin layer over three
tools: the upstream installer script, `docker compose`, and `tar`.

## 2. Concepts in five minutes

**Workflow.** A graph of nodes. It starts at a trigger (a schedule, a webhook,
a manual click, a chat message) and each node transforms or sends data. A
workflow is deterministic: the same input follows the same path.

**Node.** One step. Hundreds exist: HTTP Request, Slack, Notion, Code, IF,
Set. A node that talks to a service needs a credential.

**Credential.** A saved login or API key for a service, stored encrypted in
the database. The encryption key lives in the data volume and in `.env`.
Lose both and every credential is unreadable.

**Execution.** One run of a workflow, with the data at every step. Stored in
the database until pruned.

**Three AI things that are easy to confuse:**

| Thing | What it is | Where its key lives |
| --- | --- | --- |
| n8n Assistant | A helper in the editor that builds and explains workflows and agents for you. Runs in the sandbox containers. | `n8n/.env`, set with `set-key` |
| AI Agent node | A node inside a workflow that calls a model with tools. Part of the workflow. | A credential you attach to the node |
| Agents (Preview) | Standalone agents in the Agents tab with their own instructions, tools, memory and schedule. Used from chat, workflows, or Slack. | A credential you pick in the Agent Builder |

**Module.** n8n ships features as modules. Most load by default. `agents` is
opt-in: it has to be named in `N8N_ENABLED_MODULES`. The wrapper's
`modules` command does that.

**Preview.** n8n's label for features that work but change often. Both the
Assistant and Agents are still Preview in 2.42. Expect UI changes between
releases; in 2.40 the AI Assistant was renamed "n8n Assistant", names only.

**Template.** A workflow meant to be copied, not run. Here, any workflow
tagged `template`. The editor's Templates page lists them, and "Use template"
creates a fresh copy you then wire to your own credentials.

**Snapshot.** What `backup` makes: the data volume as a tarball plus the
config files, in a timestamped folder. `restore` puts one back.

## 3. How-to: first run

Prerequisite: Docker Desktop installed. Time: ten minutes, mostly image pulls.

```bash
open -a Docker              # macOS. Wait until the whale icon stops animating.
./n8nctl.sh preflight
```

Expected: a list of `+` lines and one `!` about port 5678 being published
on all interfaces, ending in `+ Preflight passed`. A `!` on the Docker daemon
means Docker Desktop is not up yet.

```bash
./n8nctl.sh install --version 2.42.6
```

Expected, in order:

1. A plan block naming the version and directory, and a `[y/N]` prompt.
2. `Downloading installer`, then its version, line count and sha256, and
   `First time seeing this installer`. Answer `y` to review it in `less`
   (press `q` to leave) and `y` again to run it.
3. The upstream script's own output: image pulls, `Started n8n 2.42.6`,
   `Waiting for n8n to become ready ... ✓`.
4. `+ Installed n8n 2.42.6` and a numbered list of next steps.

Now open <http://localhost:5678>. The first page asks you to create the
owner account. That account is local to this install, and there is no
"Forgot password" email until SMTP is set up: store the password in a
password manager. Section 18 covers what to do if it is lost anyway.

Then bind n8n to this machine only, so nothing else on your network can reach
it. This is the right default on a laptop; section 17 is the deliberate
opposite, for sharing with other machines at home:

```bash
cp examples/compose.override.yml n8n/compose.override.yml
./n8nctl.sh start
docker ps --filter name=n8n-n8n-1 --format '{{.Ports}}'
```

Expected last line: `127.0.0.1:5678->5678/tcp`.

## 4. How-to: read `status`

```bash
./n8nctl.sh status
```

Annotated output:

```
n8nctl 1.4.0  base: /path/to/n8n-local
Install:    /path/to/n8n-local/n8n
n8n:        2.42.6    sandbox service: 1.3.4     ← from .env; upgrade changes these
.env:       mode 600                             ← anything else is a warning
Model:      anthropic/claude-opus-4-8 (n8n default)  ← what the Assistant uses
Assistant:  OFF, no model key ...                ← or "keys on file: anthropic openai"
Web search: bundled SearXNG                      ← or Brave when that key is set
Modules:    (unset; n8n defaults)                ← N8N_ENABLED_MODULES
Agents:     not in N8N_ENABLED_MODULES ...       ← or "enabled (Preview)"
Volume:     n8n_n8n-data                         ← where your data is

NAME                  IMAGE                    STATUS               PORTS
n8n-n8n-1             docker.io/n8nio/n8n:...  Up 2 minutes         127.0.0.1:5678->5678/tcp
n8n-templates-api-1   ...python:3.13.15-alpine Up 2 minutes (healthy) 0.0.0.0:5690->8080/tcp
...                                                      ← the rest have no published port

+ Healthy: http://localhost:5678/healthz
Last backup: /path/to/n8n-backups/20261009-181207 (n8n 2.42.6)
```

The n8n `PORTS` column reads `0.0.0.0:5678->5678/tcp` once the network is
opened up (section 17). Rules of thumb: `Healthy` plus every service `Up`
means n8n is fine. A key
listed under `Assistant:` but the sidebar silent usually means the model name
does not exist at that provider. `Last backup: none` is the thing to fix
before you build anything you care about.

## 5. How-to: turn on the Assistant

You need one API key from Anthropic, OpenAI, or OpenRouter. The README's
"Getting a model key" section says where each dashboard is. Then:

```bash
./n8nctl.sh set-key --provider anthropic
```

Expected: `API key for anthropic (input hidden):`. Paste, press Enter. Nothing
echoes. Then `+ Saved ANTHROPIC_API_KEY to .../n8n/.env (mode 600)`,
`Applying to the running stack ...`, `+ Applied.`, and a `Keys on file:`
summary with the active model.

Reload the editor. The Assistant sidebar should answer a question such as
"what does this instance run?". If it does not, run `status` and check that
`Model:` names the provider whose key you just added. To use a different
model:

```bash
./n8nctl.sh set-model anthropic/claude-opus-4-8
```

Do not paste the key anywhere else. The prompt is hidden precisely so it
never lands in shell history, a log, or a chat window.

## 6. How-to: your first workflow

A workflow that fetches the n8n repository's star count and shapes the
result. No credentials needed.

1. In the editor, create a new workflow. Name it `GitHub stars`.
2. Add the first step: choose **Manual Trigger** (called "Trigger manually").
3. Add a node after it: **HTTP Request**. Method `GET`, URL
   `https://api.github.com/repos/n8n-io/n8n`. Leave authentication off.
4. Add an **Edit Fields** (Set) node. Add one field, name `stars`, value
   `{{ $json.stargazers_count }}`. The double braces are an expression;
   `$json` is the output of the previous node.
5. Click **Execute workflow**. Each node shows a green check and an item
   count. Open the last node: the output is one item with a `stars` field.
6. Save.

What you learned: a trigger, a node that calls the outside world, an
expression that reads the previous node's output, and an execution you can
inspect. Every execution is now in the database; section 13 covers pruning.

## 7. How-to: let the Assistant build one

With the Assistant on, open its sidebar in the editor and describe a task in
plain words. Two examples that work without extra credentials:

- "Create a workflow that runs every Monday at 9:00, fetches
  https://api.github.com/repos/n8n-io/n8n and keeps only the stargazers_count."
- "Explain what the GitHub stars workflow does and where it could fail."

The Assistant proposes nodes and wires them. Before you activate anything it
built, do three things: read every node's parameters, run it once manually,
and check that any credential it asks for is one you meant to give it. It is
in Preview and it will sometimes pick a wrong field name or an old node
version. Treat its output as a draft from a fast junior colleague.

## 8. How-to: your first agent

Agents are opt-in. Turn the module on, then build in the UI.

```bash
./n8nctl.sh modules --enable agents
./n8nctl.sh status | grep Agents
```

Expected: `+ N8N_ENABLED_MODULES: agents`, `Applying to the running stack`,
and the status line `Agents:     enabled (Preview)`. Reload the editor.

In the editor:

1. Select your project in the left menu, open the **Agents** tab, select
   **Create Agent**. The Agent Builder opens with a blank draft.
2. In the **Agent** tab give it a name, for example `Release watcher`.
3. In the **Model** field pick a provider and model. n8n asks for a
   credential for that provider the first time. This credential is separate
   from the Assistant key in `.env`.
4. In **Instructions** write the job in a few sentences: "You track releases
   of the n8n-io/n8n repository. When asked, fetch the latest release from
   the GitHub API, summarise the notable changes in five bullets, and say
   whether an upgrade looks safe. Never claim a change you did not read."
5. In **Capabilities** enable **Web search** if your model offers it, or add
   an **HTTP Request** tool pointed at
   `https://api.github.com/repos/n8n-io/n8n/releases/latest`.
6. Use **Preview** to chat with the draft. Ask "what changed in the latest
   release?" and watch it call the tool.
7. **Publish**. The published version is what runs from a workflow, a
   schedule or a channel; the draft stays editable.

Then look at the **Sessions** tab: every conversation is stored there with
the tools that were called. For any tool that writes somewhere (send a
message, create a page), require approval when you add it, so the agent
pauses and asks before acting.

Things that need more than this local install: episodic memory (an OpenAI
credential), a knowledge base (a Daytona account), and channels such as Slack
(a public URL, see section 12). The README's Agents section has the details.

### Connecting third-party credentials

The Monday workflow needs Google Sheets, Google Gemini and LinkedIn. Each
is a credential in n8n, created from Overview, Credentials, Create. Three
rules save most of the trouble:

- An OAuth2 credential (Google Sheets, LinkedIn, Gmail) is not connected
  until you click **Connect my account** and allow in the popup. Saving the
  Client ID and Secret alone stores nothing usable; the node then reports
  "Error fetching options".
- Never open the callback address
  `http://localhost:5678/rest/oauth2-credential/callback` yourself. Paste
  it into the provider's app settings as the redirect URL, and let the
  login round trip land on it.
- API-key credentials (Gemini, OpenAI) keep their default Host. Paste only
  the key.

Provider specifics: LinkedIn needs Organization Support and Legacy off
unless the app has Community Management approval, and its tokens expire
after 60 days. Google needs the Sheets and Drive APIs enabled on the Cloud
project that owns the OAuth client. The README's troubleshooting section
lists the exact error texts and fixes.

Two more that bite later rather than on day one:

- **Connect from the Mac that runs n8n.** The callback address says
  `localhost`, so "Connect my account" only completes in a browser on this
  Mac. Started from another machine (section 17), the popup lands on that
  machine's `localhost` and fails.
- **A credential that worked last week stops.** Active Gmail workflows then
  log, once per poll, `Access could not be refreshed because the connected
  account has revoked access, the refresh token expired ...`. Open the
  credential, click **Connect my account** again, and the trigger resumes on
  its next poll. A Google consent screen left in Testing mode does this
  every seven days; publishing it stops the cycle. Watch for it with
  `./n8nctl.sh logs n8n | grep 'could not be refreshed'`.

## 9. How-to: a fallback provider

n8n runs one Assistant model at a time and does not fail over by itself. The
practical setup is two keys on file and a one-line switch.

```bash
./n8nctl.sh set-key --provider anthropic      # primary
./n8nctl.sh set-key --provider openai         # partner
./n8nctl.sh set-key --remove                  # clear the generic key, if you ever set one
./n8nctl.sh status | grep Assistant
```

Expected: `Assistant:  keys on file: anthropic openai`. If the line also
says `generic`, that key overrides both, and the switch below would send the
wrong key; the `--remove` step fixes it.

When the primary is down:

```bash
./n8nctl.sh set-model openai/gpt-5.5
```

And back with `set-model anthropic/claude-opus-4-8`. Each provider's own
model id applies: Anthropic writes `claude-opus-4-8` with dashes, while
OpenRouter, if you use it as the partner instead, writes
`anthropic/claude-opus-4.8` with a dot. Agents keep their own
per-agent credential and are not affected; to move an agent, edit its model
in the Agent Builder and publish again.

This install switched on 2026-10-11 from OpenRouter to Anthropic plus
OpenAI. The order that keeps the Assistant working throughout: add the new
keys, `set-model` to the new provider, try the sidebar, then
`set-key --provider openrouter --remove`.

## 10. How-to: the backup drill

Do this once so that the first real restore is not the first time you try it.

```bash
./n8nctl.sh backup
```

Expected: `Stopping the n8n service briefly`, `Archiving volume n8n_n8n-data`,
`Waiting for n8n to become ready ... ready`, `+ Backup written to
.../n8n-backups/<timestamp> (7.1M)`. n8n was unavailable for a few seconds.

```bash
./n8nctl.sh backups
./n8nctl.sh verify n8n-backups/<timestamp>
```

Expected: a table with the snapshot, its n8n version, size and reason, then
ten `+` lines from `verify` ending in `+ Snapshot looks good`.

Now break something on purpose: in the editor, delete the `GitHub stars`
workflow. Then:

```bash
./n8nctl.sh restore n8n-backups/<timestamp>
```

Expected: a restore plan, two `!` warnings, a `[y/N]` prompt, then a
pre-restore backup, `Stopping the stack`, `Preparing containers and volume`,
`Restoring data`, `Waiting for n8n to become ready ... ready`, and
`+ Restored from ...`. Reload the editor: the workflow is back. The
pre-restore snapshot holds the state you just replaced, in case the drill
itself was the mistake.

Automate it on macOS with the launchd job in the README. On this install it
runs every night at 23:00 and keeps fourteen snapshots; [backup-plan.md](backup-plan.md)
has the schedule, the weekly checks, and how to recover a single workflow
without restoring everything.

## 11. How-to: upgrade and roll back

Before upgrading, read the release notes for every minor version you will
cross, looking for behaviour changes in nodes you use. Then:

```bash
./n8nctl.sh upgrade                       # no version: shows the latest and asks
./n8nctl.sh upgrade --version 2.42.6      # or pin one
```

Expected: a plan block (`n8n: 2.35.3 -> 2.42.6`, `backup: yes`), the
installer hash check (`+ Installer unchanged since it was last run`, or a
review prompt when upstream changed it), a backup, the upstream upgrade
output, `+ Upgraded n8n 2.35.3 -> 2.42.6` and a line
`Rollback: ./n8nctl.sh restore .../<timestamp>`. From a script or another
tool with no terminal, put `-y` before the command (`./n8nctl.sh -y upgrade
...`); it answers the plan prompt but never skips a changed installer's review.

Afterwards, `docker logs n8n-n8n-1 | grep -i migration` shows the database
migrations that ran; every `Starting migration` should have a matching
`Finished migration`.

Release-note items from 2.36 to 2.42 worth knowing on this install:

| Version | Change | What to do |
| --- | --- | --- |
| 2.36 | Schedule Trigger skips runs missed while n8n was off or the Mac slept, unless set to coalesce | Check schedules that must not miss a run |
| 2.37 | "Any workflow" sub-workflow caller policy deprecated | Switch to an explicit list before 3.0 |
| 2.40 | AI Assistant renamed "n8n Assistant" | Nothing; names only |
| 2.42 | Microsoft Teams activity notifications need the OAuth2 credential reconnected | Only if you add Teams |
| 2.42 | Deprecated nodes (Function, Function Item, old LangChain Code) are refused on import and create | See section 19 |

If the new version misbehaves, run that rollback line. It restores the
snapshot taken at the old version together with the old `.env`, so the old
image runs against the old database. The wrapper refuses `upgrade --version`
with a lower number for exactly this reason: database migrations only go
forward, and going back is a restore, not a downgrade.

Before n8n 3.0 in October 2026: take a backup, change any sub-workflow whose
caller policy is "Any workflow" to an explicit list, then upgrade.

## 12. How-to: reach n8n from the internet without opening it up

Webhooks from outside services, and agent channels such as Slack or Telegram,
need a public HTTPS URL. Keep the loopback binding and put a tunnel in front.
Cloudflare's quick tunnel needs no account:

```bash
brew install cloudflared
cloudflared tunnel --url http://127.0.0.1:5678
```

It prints a `https://<random>.trycloudflare.com` hostname. Tell n8n about it
so that generated webhook URLs use it:

```bash
printf 'WEBHOOK_URL=https://<random>.trycloudflare.com/\n' >> n8n/.env
./n8nctl.sh start
```

Quick tunnels change hostname each run and are for testing. For something
that stays up use a named Cloudflare Tunnel, Tailscale Funnel, or a reverse
proxy with TLS and authentication in front of it. Never forward ports 5678
or 5690 on your router to get there: the home-network setup in section 17
sends logins unencrypted and the gallery has no login at all.

Changing `WEBHOOK_URL` also changes the OAuth callback address n8n shows
(n8n builds it from `N8N_EDITOR_BASE_URL`, falling back to `WEBHOOK_URL`).
Credentials registered with the `localhost` callback (Google, LinkedIn)
need the new address added at the provider before they reconnect.

## 13. How-to: keep the database small

Every execution is stored, and every agent turn is an execution plus a stored
session. SQLite grows accordingly. Retention lives in `n8n/.env`:

```bash
cat >> n8n/.env <<'EOT'
GENERIC_TIMEZONE=Europe/Amsterdam
EXECUTIONS_DATA_MAX_AGE=168
EXECUTIONS_DATA_PRUNE_MAX_COUNT=5000
EOT
./n8nctl.sh start
```

That keeps seven days or five thousand executions, whichever is smaller, and
makes schedule triggers use local time. Appending with `>>` is safe here
because these names are not in the installer's `.env`; check with
`cut -d= -f1 n8n/.env` first if unsure. Watch the size over time with
`./n8nctl.sh backups`; the snapshot size is roughly the database size.

## 14. How-to: read the log

`n8nctl.log` is append-only, one line per state change, UTC timestamps,
never a secret value:

```
2026-09-18T16:02:45Z  installer  installer_sha256=b4a9...  script_version=1.4.0 source=https://get.n8n.io
2026-09-18T16:03:27Z  install  version=2.35.3 dir=/.../n8n no_start=0
2026-09-19T17:51:03Z  backup  path=/.../20260919-175103 reason=manual version=2.35.3 volume=n8n_n8n-data data_sha256=...
2026-09-19T20:12:40Z  set-key  var=OPENROUTER_API_KEY action=set
2026-09-19T20:13:02Z  modules  action=enable module=agents value=agents
```

Three uses. First, the `installer` lines are how the wrapper knows whether
the upstream script changed; if it warns about a new hash, compare it with
the previous line here and with the upstream commit history. Second,
`backup` lines with `reason=pre-upgrade-...` or `pre-restore` tell you which
snapshot to reach for after a bad change. Third, when something in n8n looks
different, the log says what was changed and when.

## 15. How-to: uninstall cleanly

```bash
./n8nctl.sh uninstall
```

Expected: two `!` warnings, a `[y/N]` prompt, a final backup
(`reason=pre-uninstall`), `docker compose down -v`, and `+ Uninstalled.
Backups: .../<timestamp>`. The containers, the data volume and the `n8n/`
folder are gone; the snapshots and the log stay. `./n8nctl.sh install`
followed by `restore` brings it all back.

## 16. How-to: move workflows to n8n Cloud

Your local account and an n8n Cloud account are separate and never sync.
Moving work is an export here and an import there.

```bash
./n8nctl.sh export
```

Expected: `Exporting workflows from the running container ...`, then
`+ Exported 3 workflow(s) to .../exports/<timestamp>` and two hint lines.
Inside the folder: `workflows/` with one JSON file per workflow,
`all-workflows.json`, and a `README.txt`.

On n8n Cloud:

1. Create the credentials the workflows need first (Slack, Notion, and so
   on). Credentials are never part of an export.
2. Open a workflow's menu and choose Import from File. Pick one file from
   `workflows/`. Repeat per workflow.
3. Open each imported workflow, check every node that shows a missing
   credential, pick the Cloud one, run it once manually, then activate it.
   Imports always arrive deactivated.

Two cautions. Webhook URLs change: a Webhook node's public address on Cloud
is different, so update anything that calls it. And the export folder is
gitignored on purpose; workflow JSON can contain hard-coded values, so do
not commit it or paste it into a chat.

## 17. How-to: open n8n to your home network

Section 3 binds n8n to this machine. To use the editor from other computers
on a network you trust (your home, not a café or office Wi-Fi), two changes
are needed, and both are in place on this install.

**1. Publish the port on every interface.** In `n8n/compose.override.yml`:

```yaml
services:
  n8n:
    ports: !override
      - '5678:5678'          # was '127.0.0.1:5678:5678'
```

**2. Allow sign-in over plain HTTP.** n8n marks its login cookie *Secure*,
and browsers only send Secure cookies over HTTPS, except to `localhost`. So
another machine can load the login page but never stays signed in. Add one
line to `n8n/.env` (`cut -d= -f1 n8n/.env` first, to check it is not there):

```bash
printf 'N8N_SECURE_COOKIE=false\n' >> n8n/.env
./n8nctl.sh start
```

Check:

```bash
docker port n8n-n8n-1 5678                     # expect 0.0.0.0:5678 and [::]:5678
curl -s http://$(scutil --get LocalHostName).local:5678/healthz   # expect {"status":"ok"}
```

Then, from another machine, open `http://<LocalHostName>.local:5678` (here
`http://Maliks-Mac-Studio.local:5678`). Use the `.local` name rather than an
IP address: the router can hand this Mac a new IP, the name stays. Windows
10 and later, macOS and iOS resolve `.local` names out of the box; some Linux
desktops need Avahi.

What you give up: the password and the session cookie cross the network
unencrypted, readable by anything else on it. The macOS firewall is off on
this Mac, so nothing else filters the port. If the Mac sleeps, other
machines lose n8n until it wakes.

Leave `WEBHOOK_URL` unset. The OAuth callback stays
`http://localhost:5678/rest/oauth2-credential/callback`, which Google and
LinkedIn accept; they do not accept a `.local` name or a private IP. The
cost: webhook URLs n8n displays say `localhost`, so a machine on the
network calling one must swap in the `.local` name, and OAuth "Connect my
account" must be done on this Mac (section 8).

To undo: put `127.0.0.1:` back in front of the port, delete the
`N8N_SECURE_COOKIE` line, `./n8nctl.sh start`.

## 18. How-to: reset the owner password

n8n's "Forgot password" link sends an email, and that needs SMTP. Without
it, the only way back in is n8n's own reset command, which removes the
owner's login rather than changing the password:

| Kept | Lost |
| --- | --- |
| All workflows, credentials, executions, tags | The owner's email, password, name and settings |
| The encryption key and Assistant key in `.env` | Two-factor (MFA) set up on that account |
| | Every other user account, if there were any |

```bash
./n8nctl.sh backup                                        # undo point
docker exec -u node n8n-n8n-1 n8n user-management:reset
docker compose -f n8n/compose.yml -f n8n/compose.override.yml restart n8n
```

Expected from the reset: `Successfully reset the database to default user
state.` A line about the Confluence node's "Unknown credential name" may
appear first; it is harmless startup noise. Open the editor: the owner setup
screen is back. Enter an email and a new password, and everything you had
belongs to that new owner. `curl -s http://localhost:5678/rest/settings`
shows `"showSetupOnFirstLoad":true` until you do.

To restore the old account instead (old password included), restore the
backup you just took. To avoid needing any of this, set up SMTP so "Forgot
password" works. The variables are `N8N_EMAIL_MODE=smtp`, `N8N_SMTP_HOST`,
`N8N_SMTP_PORT`, `N8N_SMTP_USER`, `N8N_SMTP_PASS`, `N8N_SMTP_SENDER` and
`N8N_SMTP_SSL` in `n8n/.env`, then `./n8nctl.sh start`. Edit `.env` in an
editor for the password, not with `printf` on the command line, so it stays
out of shell history.

## 19. How-to: import templates from GitHub

Ready-made workflows are JSON files. This install has 157 of them from
[mdixon47/awesome-n8n-templates](https://github.com/mdixon47/awesome-n8n-templates),
a fork of `enescingoz/awesome-n8n-templates`, each tagged `template` plus a
category tag such as `tpl: Gmail & Email`, all switched off. In the
Workflows list, filter by tag to see them.

**One template, by hand.** Open the JSON file on GitHub, choose *Raw*, and
download it. In the editor, create a workflow, then use its menu's
*Import from File*. Before saving, open each node that shows a credential
warning and pick your own credential. Read any Code node. Add the tags
`template` and a `tpl: ...` category if it should appear in the gallery
(section 20).

**Many at once.** There is no wrapper command for this yet; it is listed in
[issues.md](issues.md). The 2026-10-09 import was done with n8n's CLI
importer, and these are the rules it taught, in the order they matter:

1. **Refresh the fork first.** `gh repo sync mdixon47/awesome-n8n-templates
   --branch main` fast-forwards it to upstream (it was 175 commits behind,
   288 files then 369 after). Clone it into a temporary folder, not into
   this project.
2. **Back up.** `./n8nctl.sh backup`.
3. **Clean every file before importing:**
   - Remove `credentials` from every node. A credential with no id is
     matched to one of yours by name and type, so a template could end up
     wired to your real Gmail without you choosing it.
   - Give each workflow a fresh `id` (16 letters and digits). In 2.42.6 a
     single-file import without one fails with `NOT NULL constraint failed:
     workflow_entity.id`, and an id that matches an existing workflow
     overwrites it.
   - Set `active` to `false` and replace `webhookId` values, so nothing
     starts listening and no two workflows share a webhook.
   - Set `tags` to `[{"name": "template"}, {"name": "tpl: <Category>"}]`.
4. **Skip what n8n refuses.** 2.42 blocks deprecated node types (Function,
   Function Item, the old LangChain Code node). One such file fails the
   whole batch with `Rejected deprecated nodes`; nothing is imported. Two
   files in the repo are not valid JSON at all.
5. **Create new tags with a single workflow first.** A batch where several
   workflows introduce the same new tag fails with `UNIQUE constraint
   failed: tag_entity.name`, because the importer reads the tag list once.
   Import one workflow per new tag on its own, then the rest in a batch.
6. **Import.** Copy the cleaned folder into the container and run
   `docker exec -u node n8n-n8n-1 n8n import:workflow --separate
   --input=/tmp/<folder>`. Expected: `Successfully imported N workflows.`
   Delete the folder from the container afterwards.

A failed batch is rolled back as a whole, so a retry starts clean. Check the
count afterwards in the Workflows list.

**Check the language.** Collections mix languages. Four of the imported
templates were Italian: *01 - Website lead → Log + Notifications*,
*02 - Invoice payment reminders*, *03 - Morning email digest with AI*, and
the prompt and sheet columns of *HR-focused automation pipeline with AI*.
They were translated in full: workflow and node names, setup notes, AI
prompts, email and message text, code comments and variable names, form
fields and sheet columns. Renaming a node means updating the `connections`
entries and every `$('Old name')` reference too, or the workflow breaks.
Re-importing a translated file with the same `id` replaces the original
in place. Afterwards, rebuild the gallery (section 20). The setup notes list
the English column and field names the translated templates now expect, for
example `Number | Customer | Email | Amount | DueDate | Status`. Templates that use a community node
(Apify, GCF, YouTube transcription) import, but that node shows as missing
until the package is installed.

Before switching any template on: pick your own credentials, read its Code
nodes, run it once by hand. Many of these templates were written for older
n8n versions.

## 20. How-to: your own Templates gallery

The editor's **Templates** link (sidebar, command bar, the empty-canvas
buttons) normally opens n8n.io's library in a new tab. On this install it
opens n8n's built-in Templates page, filled with your own workflows tagged
`template`, grouped by their `tpl: ...` tags.

How it works: n8n has a setting for where template data comes from,
`N8N_TEMPLATES_HOST`. When it points anywhere other than n8n.io, the editor
switches to its in-app gallery and the *browser* fetches the data from that
address. The `templates-api` container answers in the same format as n8n.io:

```
your browser ── loads editor ──► n8n           :5678
             └─ fetches gallery ► templates-api :5690  (reads templates-api/data/)
```

```
N8N_TEMPLATES_HOST=http://Maliks-Mac-Studio.local:5690/api/     # n8n/.env
```

Because the browser makes that call, the address must resolve on every
machine that opens n8n, which is why it uses the `.local` name and not
`localhost`.

**Refresh** after tagging, untagging or importing:

```bash
python3 -I templates-api/build.py
```

Expected: the wrapper's export output, then `Built 157 templates in 5
categories from .../exports/<timestamp>`, a count per category, and
`node metadata: from n8n`. Reload the Templates page; no restart is needed.

**Check** when something looks wrong:

```bash
curl -s http://Maliks-Mac-Studio.local:5690/api/health          # {"status": "OK"}
docker exec n8n-n8n-1 printenv N8N_TEMPLATES_HOST
./n8nctl.sh logs templates-api
```

- The link still opens n8n.io: the editor read its settings before the
  change. Reload the tab with Cmd+Shift+R.
- The page says templates are unavailable: the editor's health check gave up
  (it allows two seconds). Either `templates-api` is down, or that machine
  cannot resolve the `.local` name.

**No login on the gallery.** Anyone who can reach port 5690 can read every
template. `build.py` strips credentials, pinned data, static data and
webhook ids, but node parameters are served as they are. Never tag a
workflow `template` if its nodes contain anything private.

To return to n8n.io's library: delete `N8N_TEMPLATES_HOST` from `.env`,
remove the `templates-api` service from `compose.override.yml`, and run
`./n8nctl.sh start`.

**The ideas page.** One link that `N8N_TEMPLATES_HOST` does not change is
the Assistant's **See all**, under its suggestions; it always goes to
n8n.io. Here it opens `http://Maliks-Mac-Studio.local:5690/` instead: ideas
with ready prompts, and the same templates with filters, diagrams and
warnings for nodes this n8n lacks. n8n has a setting,
`EXTERNAL_FRONTEND_HOOKS_URLS`, that adds scripts to the editor page; it
loads `templates-api/web/editor-hook.js` from the gallery service, and that
script rewrites the link.

```
Assistant "See all" ──► editor-hook.js ──► ideas page :5690
ideas page "Send to the Assistant" ──► :5678/assistant ──► prompt typed in, not sent
```

Check it: `curl -s http://localhost:5678/ | grep editor-hook` shows the
`<script>` tag. If the link still goes to n8n.io, reload the editor tab
with Cmd+Shift+R. To add or change ideas, edit `templates-api/web/ideas.json`
and reload the page; `match` holds patterns that pick related templates by
name, apps and node names.

**Importing from n8n.io.** On the ideas page, switch the templates to
**n8n.io library**, search, open one and click **Import into n8n**; or
paste an `n8n.io/workflows/<id>-...` link into the search box. The editor
opens `/workflows/templates/<id>` and asks the templates host for that id.
The host is the gallery server, which does not have it, so it fetches it from
`api.n8n.io` and hands it over unchanged:

```
Import into n8n ──► :5678/workflows/templates/<id> ──► :5690 ──► api.n8n.io
```

The workflow arrives as a new, inactive workflow, with the author's
credential slots empty. Connect your own credentials, read any Code and
HTTP Request nodes, then activate it. Check the pass-through:
`curl -s http://Maliks-Mac-Studio.local:5690/api/workflows/templates/15369 | head -c 200`.

## 21. How the wrapper works inside

Reading order for [n8nctl.sh](../n8nctl.sh), top to bottom:

- **Constants**: paths, the key and module variable names, the provider and
  module lists copied from n8n's source at 2.35.3. n8n 2.42.6 knows five
  more modules than that list; [issues.md](issues.md) tracks the update.
- **Helpers**: `ok`, `warn`, `die`, `log`, `confirm`. `confirm` returns yes
  under `-y`, asks on a terminal, and refuses otherwise, which is why
  destructive commands cannot run by accident from a script.
- **Portability**: `sha256_file`, `file_mode`, `version_lt`. These exist
  because macOS ships BSD tools and bash 3.2.
- **Docker**: `compose` adds `compose.override.yml` when it exists (a bare
  `-f` would otherwise ignore it), `detect_volume` finds `*n8n-data`,
  `wait_healthy` polls `/healthz`.
- **.env**: `env_get`, `env_is_set`, `env_set`, `env_unset`. `env_set` passes
  the value through the environment into awk rather than into program text,
  so a key with any characters is written verbatim and never appears in a
  command line.
- **Installer**: `fetch_installer` downloads to a private temp file, checks
  the shebang and the trailing `main "$@"` line that guards against a
  truncated download, hashes, compares with the log, offers review, logs.
  `run_installer` runs that file with `N8N_DIR` pointed at `n8n/`.
- **Backup core**: `do_backup` is shared by `backup`, `upgrade`, `restore`
  and `uninstall`. A trap restarts n8n if the archive step fails.
- **Commands**: one `cmd_<name>` per subcommand, dispatched by the `case` at
  the bottom.

Why each rail exists, in one line each:

| Rail | Failure it prevents |
| --- | --- |
| Download, hash, review, then run | A changed or truncated upstream script running unseen |
| Pinned versions, no downgrade | A floating tag silently migrating the database on a restart |
| Hidden key prompt, name-only log | A key in shell history, a log, a terminal scrollback or a commit |
| Pause n8n during backup | A SQLite file copied mid-write |
| `.env` travels with the tarball | A restore whose credentials cannot be decrypted |
| Module names validated | An unknown module name stopping n8n from booting |
| Loopback binding (the default; this install opts out, section 17) | The editor reachable by anyone on the same Wi-Fi |

The Templates gallery lives outside the wrapper: `templates-api/server.py`
(a standard-library Python server, run by the `templates-api` compose
service) and `templates-api/build.py` (turns an `export` into its data).
The wrapper still starts, stops and lists it, because it is part of the
same compose project.

To change the wrapper: edit, then `bash -n n8nctl.sh && shellcheck n8nctl.sh
&& test/smoke.sh`. The smoke test runs every command against fake `docker`
and `curl` in about ten seconds, and CI repeats it on Linux and macOS.

## 22. Glossary

- **Agent Builder**: the editor for an agent: model, instructions, tools,
  skills, memory, schedules, channels.
- **Assistant**: the n8n Assistant, module `instance-ai`. Helps build.
- **Channel**: a place people talk to a published agent: Slack, Telegram, Linear.
- **compose.override.yml**: your local changes to the stack, merged over the
  installer's `compose.yml`.
- **Daytona**: a cloud sandbox service n8n uses for agent knowledge bases on
  self-hosted installs.
- **Deprecated node**: an old node type (Function, Function Item) that n8n
  2.42 refuses to import or create; replace it with a Code node.
- **Error workflow**: a workflow set in another workflow's settings to run
  when that one fails. Deleting it silently stops the error handling.
- **Episodic memory**: agent memory across sessions; needs an OpenAI credential.
- **Execution**: one run of a workflow.
- **Generic key**: `N8N_INSTANCE_AI_MODEL_API_KEY`; overrides per-provider keys.
- **Manifest**: the small file in a snapshot with version, volume, reason and
  the tarball's sha256.
- **`.local` name**: this Mac's network name (`scutil --get LocalHostName`
  plus `.local`), found by other machines without a DNS server.
- **Module**: a feature unit in n8n; `agents` is opt-in, `instance-ai` is default.
- **N8N_SECURE_COOKIE**: `false` lets browsers on other machines stay signed
  in over plain HTTP (section 17).
- **N8N_TEMPLATES_HOST**: where the editor's Templates page gets its data;
  points at `templates-api` here (section 20).
- **Preview** (feature label): works, changes often. Also the button that
  test-chats with an agent draft.
- **Publish**: freeze an agent draft into the version that runs.
- **Sandbox**: where the Assistant runs code; two privileged containers here.
- **SearXNG**: the bundled private web search used by the Assistant.
- **Session**: one stored conversation with an agent.
- **Snapshot**: a backup folder made by `backup`.
- **Template**: a workflow tagged `template`, listed in the Templates
  gallery; `tpl: <Category>` tags group them.
- **templates-api**: the compose service on port 5690 that serves the gallery.
- **Volume**: the Docker volume `n8n_n8n-data` holding the database.
- **WEBHOOK_URL**: the public base URL n8n puts into webhook addresses.

## 23. FAQ

**Is n8n free?** The Community edition is free to self-host. The only cost
here is the model provider.

**Do I need an n8n account?** No. The owner account you create is local.

**Why is the UI in another language?** Your browser is translating it. n8n
ships English only. Choose "Show original" in the address bar.

**I forgot the owner password.** Without SMTP there is no reset email; see
section 18.

**Another computer shows the login page but never stays signed in.**
`N8N_SECURE_COOKIE=false` is missing from `.env`, or n8n was not restarted
after adding it (section 17).

**A workflow I did not delete is gone.** Check the archive first (Workflows
list, archived filter). If it was deleted outright, every snapshot taken
before the deletion still holds it. [backup-plan.md](backup-plan.md) shows
how to bring back one workflow without restoring everything.

**The Templates link opens n8n.io again.** Reload the editor tab; if it
persists, `N8N_TEMPLATES_HOST` is missing from `.env` (section 20).

**Where is the key created?** At the provider's dashboard, not in n8n. See
the README's key table.

**How do I connect my local account to n8n Cloud?** You cannot; they are
separate systems. Register the Community edition for free extras (Settings,
Usage and plan, Unlock), and move workflows with `export` (section 16).

**Can two providers run at once?** For the Assistant, one model at a time
with a manual switch (section 9). Agents each carry their own credential.

**Does `stop` lose data?** No. Data is in the volume. Only `uninstall` and
`restore` replace it, and both snapshot first.

**Why does backup pause n8n?** For a consistent SQLite copy. A few seconds.

**Can I hand-edit `compose.yml`?** Do not; the installer owns it. Put changes
in `compose.override.yml`.

**Why does the wrapper refuse to downgrade?** Migrations are one-way. Roll
back with `restore` from a snapshot at the older version.

**What happens in n8n 3.0?** Docker becomes the only install path, and the
"Any workflow" caller policy is removed. This repo is already Docker-only.

## 24. Further reading

- n8n one-line setup: <https://docs.n8n.io/deploy/host-n8n/install-options/one-line-setup>
- Set up the n8n Assistant, including Enable agents: <https://docs.n8n.io/deploy/host-n8n/configure-n8n/set-up-n8n-assistant>
- Build and manage agents: <https://docs.n8n.io/build/build-and-manage-agents>
- Manage execution data: <https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/manage-execution-data/>
- Release notes: <https://docs.n8n.io/release-notes/>
- Upstream installer source and history: <https://github.com/n8n-io/n8n/commits/master/docker/get-n8n.sh>
- Template collection (your fork): <https://github.com/mdixon47/awesome-n8n-templates>,
  upstream <https://github.com/enescingoz/awesome-n8n-templates>
- What needs attention on this install: [issues.md](issues.md)
- How it is backed up and recovered: [backup-plan.md](backup-plan.md)
