# Learning n8n-local

A guided tour for someone who has never run n8n, or never used this wrapper.
[README.md](README.md) is the reference; this file is the path through it.
Each how-to says what to type and what you should see. Commands are run from
the project folder.

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
17. [How the wrapper works inside](#17-how-the-wrapper-works-inside)
18. [Glossary](#18-glossary)
19. [FAQ](#19-faq)
20. [Further reading](#20-further-reading)

## 1. What you have here

```
 your browser ──► http://localhost:5678 ──► n8n (the editor and the engine)
                                              │
                    ┌─────────────────────────┼──────────────────────────┐
                    │                         │                          │
              runners                    sandbox-api               searxng
        (runs your Code nodes)     + sandbox-runner-1          (private web
                                 (the Assistant's own            search for the
                                  place to run code)             Assistant)
                    └─────────────── all inside Docker, not reachable from outside ───┘

 n8n_n8n-data   Docker volume: SQLite database, encryption key, uploaded files
 n8n/.env       versions, secrets, model, keys       (chmod 600, never printed)
 n8nctl.sh      the wrapper you type commands into
 n8nctl.log     what the wrapper did, and the hash of every installer it ran
```

Five containers, one published port, one data volume. Everything the wrapper
does is a thin layer over three tools: the upstream installer script,
`docker compose`, and `tar`.

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
Assistant and Agents are Preview in 2.35. Expect UI changes between releases.

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
./n8nctl.sh install --version 2.39.8
```

Expected, in order:

1. A plan block naming the version and directory, and a `[y/N]` prompt.
2. `Downloading installer`, then its version, line count and sha256, and
   `First time seeing this installer`. Answer `y` to review it in `less`
   (press `q` to leave) and `y` again to run it.
3. The upstream script's own output: image pulls, `Started n8n 2.39.8`,
   `Waiting for n8n to become ready ... ✓`.
4. `+ Installed n8n 2.39.8` and a numbered list of next steps.

Now open <http://localhost:5678>. The first page asks you to create the
owner account. That account is local to this install.

Then bind n8n to this machine only, so nothing else on your network can reach it:

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
n8nctl 1.3.0  base: /path/to/n8n-local
Install:    /path/to/n8n-local/n8n
n8n:        2.39.8    sandbox service: 1.3.4     ← from .env; upgrade changes these
.env:       mode 600                             ← anything else is a warning
Model:      anthropic/claude-opus-4-8 (n8n default)  ← what the Assistant uses
Assistant:  OFF, no model key ...                ← or "keys on file: anthropic openrouter"
Web search: bundled SearXNG                      ← or Brave when that key is set
Modules:    (unset; n8n defaults)                ← N8N_ENABLED_MODULES
Agents:     not in N8N_ENABLED_MODULES ...       ← or "enabled (Preview)"
Volume:     n8n_n8n-data                         ← where your data is

NAME              IMAGE                    STATUS          PORTS
n8n-n8n-1         docker.io/n8nio/n8n:...  Up 2 minutes    127.0.0.1:5678->5678/tcp
...                                                        ← five containers, only n8n has a port

+ Healthy: http://localhost:5678/healthz
Last backup: /path/to/n8n-backups/20260919-175103 (n8n 2.35.3)
```

Rules of thumb: `Healthy` plus five `Up` containers means n8n is fine. A key
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

## 9. How-to: a fallback provider

n8n runs one Assistant model at a time and does not fail over by itself. The
practical setup is two keys on file and a one-line switch.

```bash
./n8nctl.sh set-key --provider anthropic      # primary
./n8nctl.sh set-key --provider openrouter     # partner
./n8nctl.sh set-key --remove                  # clear the generic key, if you ever set one
./n8nctl.sh status | grep Assistant
```

Expected: `Assistant:  keys on file: anthropic openrouter`. If the line also
says `generic`, that key overrides both, and the switch below would send the
wrong key; the `--remove` step fixes it.

When the primary is down:

```bash
./n8nctl.sh set-model openrouter/anthropic/claude-opus-4.8
```

Note the dot: OpenRouter's id for that model is `claude-opus-4.8`, while
Anthropic's own API calls it `claude-opus-4-8`. Each provider's spelling
applies. And back with `set-model anthropic/claude-opus-4-8`. Agents keep their own
per-agent credential and are not affected; to move an agent, edit its model
in the Agent Builder and publish again.

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

Automate it on macOS with the launchd job in the README. It runs at 03:30
and keeps fourteen snapshots.

## 11. How-to: upgrade and roll back

```bash
./n8nctl.sh upgrade                       # no version: shows the latest and asks
./n8nctl.sh upgrade --version 2.40.0      # or pin one
```

Expected: a plan block (`n8n: 2.39.8 -> 2.40.0`, `backup: yes`), the
installer hash check, a backup, the upstream upgrade output, `+ Upgraded n8n
2.39.8 -> 2.40.0` and a line `Rollback: ./n8nctl.sh restore .../<timestamp>`.

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
proxy with TLS and authentication in front of it. Never remove the
`127.0.0.1:` prefix in `compose.override.yml` to get there.

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

## 17. How the wrapper works inside

Reading order for [n8nctl.sh](n8nctl.sh), top to bottom:

- **Constants**: paths, the key and module variable names, the provider and
  module lists copied from n8n's source at 2.35.3.
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
| Loopback binding | The editor reachable by anyone on the same Wi-Fi |

To change the wrapper: edit, then `bash -n n8nctl.sh && shellcheck n8nctl.sh
&& test/smoke.sh`. The smoke test runs every command against fake `docker`
and `curl` in about ten seconds, and CI repeats it on Linux and macOS.

## 18. Glossary

- **Agent Builder**: the editor for an agent: model, instructions, tools,
  skills, memory, schedules, channels.
- **Assistant**: the n8n Assistant, module `instance-ai`. Helps build.
- **Channel**: a place people talk to a published agent: Slack, Telegram, Linear.
- **compose.override.yml**: your local changes to the stack, merged over the
  installer's `compose.yml`.
- **Daytona**: a cloud sandbox service n8n uses for agent knowledge bases on
  self-hosted installs.
- **Episodic memory**: agent memory across sessions; needs an OpenAI credential.
- **Execution**: one run of a workflow.
- **Generic key**: `N8N_INSTANCE_AI_MODEL_API_KEY`; overrides per-provider keys.
- **Manifest**: the small file in a snapshot with version, volume, reason and
  the tarball's sha256.
- **Module**: a feature unit in n8n; `agents` is opt-in, `instance-ai` is default.
- **Preview** (feature label): works, changes often. Also the button that
  test-chats with an agent draft.
- **Publish**: freeze an agent draft into the version that runs.
- **Sandbox**: where the Assistant runs code; two privileged containers here.
- **SearXNG**: the bundled private web search used by the Assistant.
- **Session**: one stored conversation with an agent.
- **Snapshot**: a backup folder made by `backup`.
- **Volume**: the Docker volume `n8n_n8n-data` holding the database.
- **WEBHOOK_URL**: the public base URL n8n puts into webhook addresses.

## 19. FAQ

**Is n8n free?** The Community edition is free to self-host. The only cost
here is the model provider.

**Do I need an n8n account?** No. The owner account you create is local.

**Why is the UI in another language?** Your browser is translating it. n8n
2.35 ships English only. Choose "Show original" in the address bar.

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

## 20. Further reading

- n8n one-line setup: <https://docs.n8n.io/deploy/host-n8n/install-options/one-line-setup>
- Set up the n8n Assistant, including Enable agents: <https://docs.n8n.io/deploy/host-n8n/configure-n8n/set-up-n8n-assistant>
- Build and manage agents: <https://docs.n8n.io/build/build-and-manage-agents>
- Manage execution data: <https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/manage-execution-data/>
- Release notes: <https://docs.n8n.io/release-notes/>
- Upstream installer source and history: <https://github.com/n8n-io/n8n/commits/master/docker/get-n8n.sh>
