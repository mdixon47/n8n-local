# n8n-local

A safe local install of n8n for building workflows, the n8n Assistant, and
n8n Agents.

Self-hosted [n8n](https://n8n.io) (Community edition) on Docker, installed with
n8n's official one-line installer and driven by `n8nctl.sh`, a single-file bash
wrapper that adds the safety rails the raw `curl | sh` flow lacks:

- the installer is downloaded to a file, hashed, compared with the last hash in
  `n8nctl.log`, and offered for review before it runs. It is never piped into a shell
- every install and upgrade is pinned to an explicit n8n version; downgrades are refused
- Assistant model keys are entered on a hidden prompt (or piped on stdin) and
  written straight to `n8n/.env`, never to a command line or the log
- backups pause n8n for a consistent SQLite snapshot and keep `.env` (which
  holds the encryption key) together with the data tarball
- restore, upgrade and uninstall all take a snapshot first
- every state change is appended to `n8nctl.log`

The n8n Assistant is a bring-your-own-key feature: Anthropic, OpenAI, or
OpenRouter. n8n itself is free; the model provider is the only cost.

This file is the reference. New to n8n or to this setup? Start with
[docs/learn.md](docs/learn.md): concepts, step-by-step how-tos with expected output,
a backup drill, a first workflow and a first agent, and a glossary. What
currently needs attention on this install is in [docs/issues.md](docs/issues.md).

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Getting a model key](#getting-a-model-key)
- [Keys and models](#keys-and-models)
- [Agents (Preview)](#agents-preview)
- [Two providers: a partner key and a fallback](#two-providers-a-partner-key-and-a-fallback)
- [Everyday commands](#everyday-commands)
- [Running day to day](#running-day-to-day)
- [Backups, verify, restore](#backups-verify-restore)
- [Exporting workflows](#exporting-workflows-for-n8n-cloud-or-another-instance)
- [Local Templates gallery](#local-templates-gallery)
- [Upgrading](#upgrading)
- [Local-only binding and other customizations](#local-only-binding-and-other-customizations)
- [Nightly backups (macOS launchd)](#nightly-backups-macos-launchd)
- [Troubleshooting](#troubleshooting)
- [Layout](#layout)
- [Environment overrides](#environment-overrides)
- [Security notes](#security-notes)
- [Developing the wrapper](#developing-the-wrapper)
- [Learning guide](docs/learn.md)
- [Open issues](docs/issues.md)
- [Backup plan](docs/backup-plan.md)

## Requirements

- Docker with the `docker compose` v2 plugin. The legacy `docker-compose`
  binary does not work. On macOS that means Docker Desktop, started and idle.
- `curl`, `bash` 3.2 or newer, and coreutils. Linux and macOS are supported.
  On Windows use WSL with Docker Desktop's WSL2 integration.
- Port 5678 free.

`./n8nctl.sh preflight` checks all of this and reports what is missing.

## Quick start

```bash
open -a Docker                            # macOS: start Docker Desktop first
./n8nctl.sh preflight                     # Docker, compose v2, curl, port 5678, .gitignore
./n8nctl.sh install --version 2.39.8      # pinned install; review the installer when asked
./n8nctl.sh set-key --provider anthropic  # hidden prompt for the Assistant model key
./n8nctl.sh modules --enable agents       # optional: turn on the Agents tab (Preview)
./n8nctl.sh status                        # health, versions, keys, active model, modules
```

Pick a current release for `--version`; `./n8nctl.sh upgrade` with no version
prints the latest. Agents are in Preview and change with nearly every release,
so for Agents newer is materially better.

Then open <http://localhost:5678>, create the owner account, and confirm the
Assistant sidebar responds. The first install pulls five images and takes a
few minutes.

The first run of `install` shows the installer's size, version and sha256 and
offers to open it in a pager. Answer yes to run it. Later runs only prompt
again if the upstream script has changed. `-y` skips every prompt, which is
meant for scripts, not for the first install.

## Getting a model key

The key is not created by n8n. It comes from the model provider's own
dashboard; n8n only stores it and sends requests with it. Pick one:

| Provider | Where to create it | Key prefix |
| --- | --- | --- |
| Anthropic | <https://console.anthropic.com> → API Keys → Create Key | `sk-ant-` |
| OpenAI | <https://platform.openai.com/api-keys> → Create new secret key | `sk-` |
| OpenRouter | <https://openrouter.ai/keys> → Create Key | `sk-or-` |

Each provider needs a payment method or prepaid credit before the key works.
The key is shown once at creation, so copy it right then. OpenRouter is one
key for many models, including Anthropic and OpenAI ones, and it routes each
model across several upstream providers.

Handling rules:

- paste the key only at the wrapper's hidden prompt, never as a command
  argument, never into a chat, never into a commit
- the wrapper writes it to `n8n/.env` (mode 600) and logs only the variable name
- every other secret in `n8n/.env` (runner tokens, sandbox keys, the SearXNG
  secret) was generated by the installer and needs no action

## Keys and models

How n8n picks the key (from its source, `instance-ai-settings.service.ts`):

1. `N8N_INSTANCE_AI_MODEL` selects the model in `provider/model` form.
   Default: `anthropic/claude-opus-4-8`. Providers: `anthropic`, `openai`,
   `openrouter`.
2. If the generic `N8N_INSTANCE_AI_MODEL_API_KEY` is set, it is used for
   whatever provider is active.
3. Otherwise n8n falls back to the provider's own variable:
   `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`.

The wrapper maps onto that directly:

| Task | Command |
| --- | --- |
| Store a provider's key | `./n8nctl.sh set-key --provider anthropic` (or `openai`, `openrouter`) |
| Store the generic key | `./n8nctl.sh set-key` (overrides every provider key) |
| Pipe a key instead of typing | `printf '%s\n' "$KEY" \| ./n8nctl.sh set-key --provider openai` |
| Remove a key | `./n8nctl.sh set-key --remove` or `set-key --provider X --remove` |
| Switch the active model | `./n8nctl.sh set-model openai/gpt-5.5` |
| See what is on file | `./n8nctl.sh status` → `Model:` and `Assistant: keys on file:` |
| Store another secret | `./n8nctl.sh set-key --var daytona` (knowledge-base sandbox) or `--var brave` (web search) |

`set-key` and `set-model` restart the stack when it is running so the change
applies immediately. `set-model` warns if no key exists for that provider.
Provider and model can also be set in the n8n UI under the instance AI
settings; keys stored there are encrypted in the database and take priority
over `.env`.

**What `.env` governs and what the credential store governs.** The keys above
are for the n8n Assistant only. Everything an agent or a workflow uses lives
in n8n's credential store, encrypted in the database with the key in `.env`:
each agent's own model credential (chosen when you create the agent), tool
credentials (Slack, Notion, GitHub and so on), and the OpenAI credential that
episodic memory requires. `set-key` and `set-model` never touch those.
The Brave variable is spelled `INSTANCE_AI_BRAVE_SEARCH_API_KEY`, without the
`N8N_` prefix the other variables have; the wrapper gets it right for you.

## Agents (Preview)

From n8n 2.32.3 the **Agents** tab lets you define an agent once (model,
instructions, tools, skills, knowledge, memory) and use it from a chat, from a
workflow through the *Message an Agent* node, on a schedule, as a sub-agent of
another agent, or from a channel such as Slack, Telegram or Linear. It is a
different thing from the *AI Agent node* inside a workflow and from the n8n
Assistant that helps you build. Agents are available on self-hosted Community
edition, not on self-hosted Enterprise yet.

**Turning it on.** At 2.35.3 the `agents` module is opt-in; the installer does
not enable it. The Assistant's own module, `instance-ai`, loads by default.

```bash
./n8nctl.sh modules --enable agents     # writes N8N_ENABLED_MODULES=agents and restarts
./n8nctl.sh status                      # "Agents:     enabled (Preview)"
```

`modules` validates the name against the list n8n 2.35.3 accepts, because an
unknown module name stops n8n from starting. Agents need regular mode, which
is what this install runs; queue mode is not supported for agents yet.

**What each agent needs.** Its own model credential, picked in the Agent
Builder when you choose a provider and model. The Assistant key in `.env` is
not used for agents, and `set-model` does not affect them.

**What works here without anything extra:** building agents by hand or with
the Assistant, chatting with them, *Message an Agent* in workflows, schedules,
sub-agents, sessions, and approvals on sensitive tools.

**What needs more than this local setup** (the repo's stance is to document
these rather than widen the install; see Security notes):

| Feature | Needs | Why it is out of the box here |
| --- | --- | --- |
| Episodic memory (recall across sessions) | An OpenAI credential in the UI, even if the agent runs on Anthropic | A UI step, no config change; just expect the prompt |
| Knowledge base (upload and search files) | `N8N_AGENTS_AI_SANDBOX_ENABLED=true`, `N8N_AGENTS_AI_SANDBOX_PROVIDER=daytona`, `DAYTONA_API_URL`, `DAYTONA_API_KEY` | Daytona is a cloud sandbox; the bundled `n8n-sandbox` cannot do this |
| Channels (Slack, Telegram, Linear) | A public HTTPS `WEBHOOK_URL` | This install binds to 127.0.0.1; put a tunnel in front, see Local-only binding |

To add the Daytona key safely: `./n8nctl.sh set-key --var daytona`, then put
the three other variables in `n8n/.env` and `./n8nctl.sh start`.

Every agent turn is one execution and every conversation is a stored session,
all of it in the data volume. Backups cover it; execution pruning (see
Environment overrides) matters more once agents are in use.

Upstream docs: [Build and manage agents](https://docs.n8n.io/build/build-and-manage-agents),
[Enable agents](https://docs.n8n.io/deploy/host-n8n/configure-n8n/set-up-n8n-assistant#enable-agents),
[Release notes](https://docs.n8n.io/release-notes/).

## Two providers: a partner key and a fallback

The Assistant uses one model at a time and n8n has no automatic failover.
Redundancy means keeping a key on file for each provider and switching in one
command when the primary is down:

This install runs Claude through Anthropic as the primary, with an OpenAI
key as the partner (since 2026-10-11; OpenRouter before that):

```bash
./n8nctl.sh set-key --provider anthropic     # primary
./n8nctl.sh set-key --provider openai        # partner / fallback
./n8nctl.sh set-key --remove                 # clear the generic key so per-provider keys apply
./n8nctl.sh status                           # "keys on file: anthropic openai"

./n8nctl.sh set-model openai/gpt-5.5             # switch when the primary is down
./n8nctl.sh set-model anthropic/claude-opus-4-8  # and back
```

Retiring a provider: switch the model away from it first, then
`set-key --provider <name> --remove`. Snapshots taken earlier keep the old
key in their `.env`, so revoke it at the provider too.

If the generic key is still set, `set-key --provider` warns you: the generic
key wins for every provider, so a model switch would send the wrong key.
The model name must be one the provider offers, spelled the provider's way:
Anthropic writes `claude-opus-4-8`, OpenRouter writes `anthropic/claude-opus-4.8`
with a dot. Check with `curl -s https://openrouter.ai/api/v1/models | grep -o '"id":"anthropic/[^"]*'`.
For Anthropic and OpenAI the list needs the key (`GET /v1/models` on
`api.anthropic.com` or `api.openai.com`).

Agents are unaffected by `set-model`. An agent's model is fixed per agent;
failing an agent over to another provider means editing the agent in the
Agent Builder and republishing it.

## Everyday commands

| Task | Command |
| --- | --- |
| Check prerequisites | `./n8nctl.sh preflight` |
| Fresh install (pinned) | `./n8nctl.sh install --version X.Y.Z` |
| Health and config | `./n8nctl.sh status` (also container health checks, bind mounts, the HTTP/1.1 preload, and backup age) |
| Start / stop / follow logs | `./n8nctl.sh start` · `stop` · `logs [service]` |
| Snapshot | `./n8nctl.sh backup` |
| Export all workflows as JSON | `./n8nctl.sh export` |
| List snapshots | `./n8nctl.sh backups` |
| Check a snapshot | `./n8nctl.sh verify n8n-backups/<timestamp>` |
| Keep only the newest N snapshots | `./n8nctl.sh backups --prune N` |
| Roll back | `./n8nctl.sh restore n8n-backups/<timestamp>` |
| Check for a newer n8n | `./n8nctl.sh check-update` |
| Upgrade (backs up first) | `./n8nctl.sh upgrade --version X.Y.Z` |
| Show or change modules | `./n8nctl.sh modules` · `modules --enable agents` · `modules --disable agents` |
| Store the Daytona or Brave key | `./n8nctl.sh set-key --var daytona` · `set-key --var brave` |
| Remove everything | `./n8nctl.sh uninstall` |
| Skip prompts | add `-y` / `--yes` |
| Help | `./n8nctl.sh help` |

`upgrade` and `uninstall` accept `--skip-backup`; `restore` accepts
`--no-safety-backup`; `install` and `upgrade` accept `--no-start`.
Anything destructive (`restore`, `uninstall`, `backups --prune`) asks first
and refuses to run without a terminal unless `-y` is given.

## Running day to day

- The stack keeps running in the background until `./n8nctl.sh stop`. Docker
  Desktop brings it back after a reboot if its "start on login" setting is on;
  otherwise run `./n8nctl.sh start`, which waits for the health endpoint.
- `./n8nctl.sh logs n8n` follows the main service. Other service names are
  `runners`, `sandbox-api`, `sandbox-runner-1`, and `searxng`.
- Workflows, credentials and executions live in the Docker volume
  `n8n_n8n-data`, not in the project folder, so `stop` never loses data.
- With the override from the next sections in place, n8n is reachable only
  from this machine at <http://localhost:5678>. Reaching it from other
  devices needs the LAN binding and, for anything public, a reverse proxy with
  TLS. Public webhooks additionally need a tunnel or a public hostname.
- The health endpoint is `http://localhost:5678/healthz`.

## Backups, verify, restore

`backup` stops only the `n8n` service, archives the data volume through a
helper container, restarts n8n and waits for it to be healthy, then copies
`.env`, `compose.yml`, `compose.override.yml` (if present) and
`searxng-settings.yml` next to the tarball with a `manifest` holding the
version, volume name, reason, the tarball's sha256 and size, and the pinned
helper image. Expect a few seconds
of downtime. Two snapshots in the same second get a `_2` suffix. It prints
the tarball's size and the change since the previous snapshot, and warns
when the data grew by more than half (and by at least 1 MB).

`verify <dir>` checks that all files are present, `.env` is mode 600, the
tarball hash matches the manifest, the n8n version agrees between manifest and
`.env`, and `database.sqlite` is inside the archive.

`restore <dir>` runs the same checks as `verify` and stops before touching
anything if one fails. It then snapshots the current state (skip with
`--no-safety-backup`), stops the stack, puts the config files back, lets
compose recreate the volume, wipes and extracts the data, then starts and
waits for health. Everything created after the snapshot is lost. The
encryption key travels in `.env`, which is why config and data are always
restored together.

`backups --prune N` deletes all but the newest N snapshots after confirmation.

Agent definitions, publish history, sessions, and every credential (agent
models, tool credentials, the episodic-memory OpenAI credential) live in the
data volume and are inside every snapshot. They are encrypted with the key in
`.env`, which is why a snapshot without its `.env` cannot be decrypted after
restore, and why the wrapper always keeps the two together.

## Exporting workflows (for n8n Cloud or another instance)

A self-hosted install and n8n Cloud do not share accounts and do not sync.
To move workflows, export them here and import them there:

```bash
./n8nctl.sh export
```

This runs n8n's own exporter inside the running container and writes to
`exports/<timestamp>/`, which is gitignored and mode 700:

- `workflows/<name>.json`, one file per workflow, for the n8n UI's
  *Import from File* (one workflow per import)
- `all-workflows.json`, everything in one file, for
  `n8n import:workflow --input=...` on another self-hosted instance
- `README.txt` with the version and the caveats below

Credentials are never exported. Create them on the target first, import the
workflows, check each node's credential field, then activate; imports arrive
deactivated. Exported JSON can contain webhook paths and hard-coded values,
so keep the folder out of git and out of chats. `N8N_EXPORT_DIR` moves it.

## Local Templates gallery

The editor's **Templates** link (sidebar, command bar, empty-canvas buttons)
opens n8n.io in a new tab by default. Here it opens n8n's built-in Templates
page instead, filled with this instance's own templates: every workflow tagged
`template`. Tags named `tpl: <Category>` become the gallery's categories.

How it works: when `N8N_TEMPLATES_HOST` is anything other than n8n's default,
the editor uses its in-app gallery and the browser fetches from that host. The
`templates-api` service in `n8n/compose.override.yml` (a stdlib Python server,
`templates-api/server.py`) answers the same endpoints as `api.n8n.io`:

```
N8N_TEMPLATES_HOST=http://Maliks-Mac-Studio.local:5690/api/   # in n8n/.env
```

The browser calls this address directly, so it must resolve on every machine
that opens n8n, the same as the n8n URL itself.

Refresh after tagging, untagging or importing workflows:

```bash
python3 -I templates-api/build.py      # runs ./n8nctl.sh export, rebuilds templates-api/data/
```

The server picks up the new catalog on its next request. `build.py` strips
credentials, pinned data, static data and webhook ids before serving, because
the gallery answers without a login: anyone who can reach port 5690 can read
every template. Do not tag a workflow `template` if its nodes hold anything
private. "Use template" creates a new, separate workflow from the template.

To go back to n8n.io's gallery, remove `N8N_TEMPLATES_HOST` from `.env` and the
`templates-api` service from the override, then `./n8nctl.sh start`.

### Ideas page

`http://Maliks-Mac-Studio.local:5690/` is a page of ideas and templates
served by the same service (`templates-api/web/`). The Assistant's **See all**
link under its suggestions, and every other editor link to
`n8n.io/workflows`, open it instead of n8n.io. What it adds over n8n.io's
library:

- **Ideas** (`templates-api/web/ideas.json`): ready prompts grouped by goal.
  **Send to the Assistant** opens the Assistant with the prompt typed in (not
  sent) and copies it to the clipboard.
- **Templates** with search, filters with counts (category, trigger, apps,
  size, uses AI, runs on this n8n), a diagram drawn from the workflow, the
  apps that need a credential, and a warning when a node is missing here
  (disabled in 2.x, removed, or from an uninstalled community package).
- Per template: **Use this template** (the in-app setup), **Adapt with the
  Assistant**, **Open the original**, **Copy workflow JSON** (paste onto a
  canvas). Filters and the open item are kept in the URL.
- **n8n.io library**: the **n8n.io library** switch above the templates
  searches n8n.io's public library (about 13,000 templates) by text and
  category. A template's **Import into n8n** opens the editor's own import
  route, `/workflows/templates/<id>`, which creates a new, inactive workflow.
  Pasting an `n8n.io/workflows/...` link into the search box opens that
  template, and so does clicking such a link inside the editor. Each one is
  flagged when it needs a node this n8n does not have; paid templates link
  to n8n.io instead.

How n8n.io imports work: the gallery server passes n8n.io's API through
(`TEMPLATES_UPSTREAM` in `n8n/compose.override.yml`, default
`https://api.n8n.io/api`). Any template id that is not a local one is
fetched from n8n.io, so the editor's import and preview pages work for the
whole library. Upstream calls carry no browser headers and are cached for 4
hours. Searches on the n8n.io tab are sent to n8n.io. Set
`TEMPLATES_UPSTREAM: ''` and run `./n8nctl.sh start` to turn it off.
Templates from n8n.io are written by its community: read Code and HTTP
Request nodes before running one.

**Missing nodes.** The template dialog names the npm package to install for
each node this n8n lacks, and **Import into n8n…** asks first when one is
missing. Some n8n.io templates use `CUSTOM.<name>`, a node the author loaded
by hand; once a community package with a node called `<name>` is installed
and `build.py` has run, the gallery server hands those templates over with
the installed type, so they import ready to run. After installing any
community package, run `python3 -I templates-api/build.py`.

How the link is redirected: `EXTERNAL_FRONTEND_HOOKS_URLS` in
`n8n/compose.override.yml` makes n8n add `templates-api/web/editor-hook.js`
to the editor page. The script rewrites links to `n8n.io/workflows`, and
types a prompt into the Assistant only when the tab was opened from the
ideas page. It makes no network requests. To turn it off, remove that line
and run `./n8nctl.sh start`. Rebuild with `build.py` as above; it also copies
the node icons into `templates-api/data/icons/`.

## Upgrading

```bash
./n8nctl.sh check-update                 # installed vs latest stable (exit 3 if behind)
./n8nctl.sh upgrade --version 2.42.7
./n8nctl.sh -y upgrade --patch-only      # what the nightly job runs
```

Patch releases are installed automatically: the nightly job
(`launchd/nightly.sh`, see [docs/backup-plan.md](docs/backup-plan.md)) runs
`upgrade --patch-only` after its backup, which takes the newest patch of the
installed minor version once it is a day old, refuses a changed installer,
and exits 4 if the post-upgrade checks fail. Minor and major versions stay
manual; the job sends one Mac notification per new one. `upgrade` without
`--version` never crosses to a new major version.

The wrapper fetches and (if changed) offers to review the installer, takes a
backup, runs the upstream `--upgrade --no-start` (which only updates `.env`),
pulls the images, starts the stack with `compose.override.yml`, waits for
health, checks bind mounts and the HTTP/1.1 preload, and prints the rollback
command. The installer never starts n8n itself, so n8n never runs without the
override. Downgrades are refused because database
migrations are one-way; going back means `restore` from a snapshot taken at
the older version. Without `--version` the latest release is looked up and
confirmed before anything happens.

**Before n8n 3.0 (October 2026).** Two things the release notes announce:
npm/npx installs stop working (Docker only, which this repo already is), and
the workflow setting "This workflow can be called by → Any workflow" is
removed. That setting is deprecated now and matters if you wire sub-workflows
as agent tools. Checklist: `./n8nctl.sh backup`, switch any sub-workflow off
"Any workflow" to an explicit caller list, then `./n8nctl.sh upgrade`.
Preview features such as Agents add database migrations, which is the reason
the wrapper refuses downgrades.

## Local-only binding and other customizations

`n8n/compose.override.yml` holds local changes to the stack. The upstream
installer never touches it, the wrapper passes it to every compose call, and
`backup` includes it. The copy in [examples/compose.override.yml](examples/compose.override.yml)
binds n8n to `127.0.0.1` so nothing else on the network can reach it:

```bash
cp examples/compose.override.yml n8n/compose.override.yml
./n8nctl.sh start        # recreates the n8n container with the new binding
docker ps --filter name=n8n-n8n-1 --format '{{.Ports}}'   # 127.0.0.1:5678->5678/tcp
```

Remove the `127.0.0.1:` prefix only if you deliberately want LAN access, and
prefer a TLS reverse proxy for anything beyond that. The same file is the
place to remap the port if 5678 is taken.

**Channels and public webhooks.** Agent channels (Slack, Telegram, Linear)
and any webhook that an outside service must call need a public HTTPS URL,
set in `n8n/.env` as `WEBHOOK_URL`. For a personal machine, keep the loopback
binding and put a tunnel in front of it: Cloudflare Tunnel, Tailscale Funnel,
or ngrok pointed at `http://127.0.0.1:5678`. Set `WEBHOOK_URL` to the tunnel's
`https://` hostname and `./n8nctl.sh start`. Do not widen the bind to get
there. Channels are documented to be unreliable in queue mode, which this
install does not use.

## Nightly backups (macOS launchd)

[launchd/com.n8nctl.backup.plist](launchd/com.n8nctl.backup.plist) runs
`backup` every night at 23:00 and then prunes to the newest 14 snapshots.
The full plan, with checks and recovery steps, is
[docs/backup-plan.md](docs/backup-plan.md). Edit the paths inside the plist
if the project or your home folder moves, then:

```bash
cp launchd/com.n8nctl.backup.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.n8nctl.backup.plist
launchctl kickstart -k gui/$(id -u)/com.n8nctl.backup     # run it once now
launchctl print gui/$(id -u)/com.n8nctl.backup | grep -E 'state|last exit code'   # 0 = success
```

Output goes to `~/Library/Logs/n8nctl-backup.log`, on the internal disk on
purpose: when the log path is on an external drive macOS can refuse it and
the job never starts. With the project on an external drive, macOS also
refuses a plain bash job access to it (`Operation not permitted`), so the
plist opens a small app, `~/Applications/n8nctl Backup.app`, built from
[launchd/n8nctl-backup.applescript](launchd/n8nctl-backup.applescript) and
allowed once to use removable volumes. Build steps are in the backup plan.
The job fails harmlessly if Docker or the drive is not available. To remove it:

```bash
launchctl bootout gui/$(id -u)/com.n8nctl.backup
```

## Troubleshooting

**The n8n UI appears in Dutch (or another language).** n8n 2.35 ships English
only and reports `defaultLocale: en`; the page is served with `lang="en"`.
What you are seeing is your browser's page-translation feature. Click the
translate icon in the address bar, choose "Show original", then "Never
translate this site". To confirm from outside the browser:

```bash
curl -s http://localhost:5678/setup | grep -o '<title>[^<]*</title>'
curl -s http://localhost:5678/rest/settings | tr ',' '\n' | grep defaultLocale
```

**`Docker daemon not reachable` in preflight.** Docker Desktop is not running.
`open -a Docker`, wait for the whale icon to settle, run preflight again.

**`something already answers on port 5678`.** Another service owns the port.
Stop it, or install with `--no-start`, remap the port in
`n8n/compose.override.yml`, then `./n8nctl.sh start`.

**Health check fails right after `backup` or `start`.** n8n takes a few
seconds to boot after a restart. Both commands now wait for the health
endpoint; if `status` still says "Not answering", run `./n8nctl.sh logs n8n`.

**Assistant says `API key is invalid` or `No output generated. Check the
stream for errors`.** The second is the first wrapped one layer up. Look at
`./n8nctl.sh logs n8n` for the provider URL and status: a 401 from
`api.anthropic.com` while `status` shows `keys on file: ... generic` means
the generic key is being sent to a provider it does not belong to. Fix with
`set-key --remove` and `set-model <provider>/<model>` for the provider whose
key is valid. A 404 or "model not found" from OpenRouter usually means the id
is spelled Anthropic's way; OpenRouter uses dots (`claude-opus-4.8`).

**Assistant sidebar is missing or silent.** `status` should list at least one
key under "keys on file" and a model whose provider has a key. If the generic
key is set together with provider keys, the generic one is used for every
provider. Check the model name exists at that provider.

**Assistant: `Failed after 3 attempts ... The session has been destroyed`.**
Node 26 (in the 2.42 image) makes `fetch` use HTTP/2, and the Assistant's
parallel requests to OpenRouter died on one shared HTTP/2 connection
(`ERR_HTTP2_INVALID_SESSION`); restarting only helped for a minute. Fixed
here by preloading [runtime/force-http1.cjs](runtime/force-http1.cjs) into
n8n (`NODE_OPTIONS` plus a read-only mount of `runtime/` in
`n8n/compose.override.yml`), which switches `fetch` to HTTP/1.1. Check it is
active with `./n8nctl.sh logs n8n | grep n8n-local`: expect
`fetch uses HTTP/1.1`. A line saying `not applied` means the script could
not find an `undici` 7 or 8 package in the n8n image (after an upgrade);
fetch then behaves as before. n8n will not start if `runtime/` is missing,
so keep it next to `n8n/`.

**`ssl/tls alert bad record mac ... SSL alert number 20`.** The server got
encrypted data that was damaged on the way. Here it hit uploads of about
1 MB and up (LinkedIn image posts, long Assistant conversations) from the
Mac and from containers alike, to every host tried, so the cause is the
network path, not n8n or Docker. Restarting n8n does not help. Restart the
router, change Wi-Fi band, or try another connection; meanwhile Retry On
Fail on the affected node gets most runs through.
[docs/issues.md](docs/issues.md) item 3 has the details;
`node test/netcheck.js` checks whether it is happening now.

**`Bad file descriptor` inside a container, gallery answers 500, or n8n
will not start with `Cannot find module '/opt/n8n-local/force-http1.cjs'`.**
Docker's bind mounts into the project folder have gone dead, usually after
the Mac slept or the external drive dropped off. The files are fine on the
Mac. Check with `docker exec n8n-n8n-1 ls /opt/n8n-local`; fix with
`./n8nctl.sh stop` then `./n8nctl.sh start`, which recreates the
containers. Keep the drive and the Mac from sleeping on AC power
(`sudo pmset -a disksleep 0`, `sudo pmset -c sleep 0`).

**Installer changed since last run.** The wrapper shows both hashes and offers
the file for review. Read the diff of the upstream script at
<https://github.com/n8n-io/n8n/commits/master/docker/get-n8n.sh> before
answering yes.

**No Agents tab.** Run `./n8nctl.sh status`. The `Agents:` line says whether
`agents` is in `N8N_ENABLED_MODULES` and whether the version is at least
2.32.3. Enable with `./n8nctl.sh modules --enable agents`. Agents are not
available on self-hosted Enterprise. The tab needs a fresh page load after the
restart.

**Knowledge upload fails, or a channel will not connect.** The knowledge base
needs the Daytona sandbox and channels need a public `WEBHOOK_URL`; the
bundled sandbox and the loopback binding cannot provide either. See
[Agents (Preview)](#agents-preview) for the variables and the tunnel approach.

**n8n will not start after editing modules.** An unknown name in
`N8N_ENABLED_MODULES` stops n8n. `./n8nctl.sh logs n8n` shows the name;
`./n8nctl.sh modules --disable <name>` removes it, or use `modules` to see the
accepted names. The wrapper only writes names it knows.

**Third-party credentials: LinkedIn, Google, OpenAI.** These live in n8n's
credential store, not in `.env`, and every failure below shows its real cause
in `./n8nctl.sh logs n8n`.

- *LinkedIn: `invalid_scope_error`, or a "Bummer, something went wrong"
  page.* n8n asked for a scope the app lacks. In the credential, turn
  Organization Support off (it adds `w_organization_social`, which needs
  LinkedIn's Community Management review) and Legacy off (it asks for
  retired scopes). The app itself needs the Share on LinkedIn and Sign In
  with LinkedIn using OpenID Connect products, and the redirect URL
  `http://localhost:5678/rest/oauth2-credential/callback` on its Auth tab.
- *LinkedIn node: "Error fetching options".* The credential has no token
  yet; the log says `Unable to sign without access token`. Open the
  credential and click **Connect my account** (n8n's button name), allow in
  the popup, then select the credential in the node. Standard LinkedIn
  tokens last 60 days with no refresh; reconnect before they expire.
- *`Insufficient parameters for OAuth2 callback`.* The callback address was
  opened by hand or from LinkedIn's OAuth tools. It only works as the
  landing point of a login started by Connect my account in n8n.
- *Google: `403 ... API has not been used in project N ... or it is
  disabled`.* Enable that API on that project in the Google Cloud console;
  the Google Sheets node needs both the Sheets API and the Drive API. A
  consent screen still in Testing mode expires refresh tokens after seven
  days; publish it for personal use.
- *Google Gemini credential "Couldn't connect".* The Host field must be
  `https://generativelanguage.googleapis.com`, its default. The OAuth
  callback URL does not belong there; it is for OAuth2 credentials such as
  Google Sheets.
- *OpenAI 401 "Incorrect API key provided" in a workflow.* A credential
  holds a bad key. Open Overview, Credentials, the OpenAI account, and
  replace it. `set-key` does not touch workflow credentials.
- *OpenRouter 402 "exceed your available credits" or "requires more
  credits, or fewer max_tokens".* The Assistant reserves 65,536 output
  tokens per call at the model's price; the account balance is too small
  for that. Top up at openrouter.ai, or `set-model` to a cheaper model.

**Which volume holds my data?** `status` prints it. If several `*n8n-data`
volumes exist, set `N8N_VOLUME` to the right one.

## Layout

```
.
├── n8nctl.sh                 # the wrapper; the only code we own
├── n8nctl.log                # append-only: installer hashes, installs, upgrades, backups, key changes
├── README.md                 # this file: reference
├── docs/
│   ├── learn.md              # concepts, how-tos, drills, glossary
│   ├── issues.md             # what needs attention on this install
│   └── backup-plan.md        # schedule, checks, recovery
├── CLAUDE.md                 # working rules for the repo (also read by Claude Code)
├── examples/
│   └── compose.override.yml  # binds n8n to 127.0.0.1
├── launchd/
│   └── com.n8nctl.backup.plist   # nightly backup + prune (macOS)
├── templates-api/
│   ├── server.py             # local Templates gallery API + ideas page (compose service templates-api)
│   ├── build.py              # export -> data/ from workflows tagged `template`
│   ├── web/                  # ideas page (index.html, app.js, app.css, ideas.json) + editor-hook.js
│   └── data/                 # generated by build.py (gitignored): catalog, workflows, icons
├── test/
│   ├── smoke.sh              # offline checks for every command
│   ├── stubs/docker, curl    # fake docker and curl used by the test
│   └── fixtures/             # vendored upstream installer + compose file
├── .github/workflows/ci.yml  # bash -n, shellcheck, fixture hash, smoke test on Linux + macOS
├── n8n/                      # created by the upstream installer; treat as generated (gitignored)
│   ├── compose.yml           # do not hand-edit; use compose.override.yml next to it
│   ├── compose.override.yml  # ours: local customizations
│   ├── .env                  # secrets (chmod 600): versions, keys, model, generated tokens
│   └── searxng-settings.yml
├── exports/<timestamp>/      # gitignored: workflows/*.json, all-workflows.json, README.txt
└── n8n-backups/<timestamp>/  # gitignored
    ├── n8n-data.tar.gz       # the Docker data volume
    ├── manifest              # version, volume name, tarball sha256 and size, reason
    └── compose.yml, compose.override.yml, .env, searxng-settings.yml
```

The stack the installer starts: `n8n` (port 5678), `runners` (Code node
sandbox), `sandbox-api` and `sandbox-runner-1` (the Assistant's privileged
Docker-in-Docker sandbox), and `searxng` (private web search). Only 5678 is
published. Data lives in the Docker volume `n8n_n8n-data`, database is SQLite.

Log line format:

```
2026-09-19T17:51:03Z  backup  path=... reason=manual version=2.35.3 volume=n8n_n8n-data data_sha256=...
```

## Environment overrides

| Variable | Purpose | Default |
| --- | --- | --- |
| `N8N_BASE_DIR` | Directory containing `./n8n` | `$PWD` |
| `N8N_BACKUP_DIR` | Backup destination | `$N8N_BASE_DIR/n8n-backups` |
| `N8N_VOLUME` | Data volume name | auto-detect `*n8n-data` |
| `N8N_EXPORT_DIR` | Workflow export destination | `$N8N_BASE_DIR/exports` |

n8n variables this setup touches, all set in `n8n/.env` and applied with
`./n8nctl.sh start`:

| Variable | Purpose |
| --- | --- |
| `N8N_ENABLED_MODULES` | Opt-in modules, comma separated; `agents` for the Agents tab. Managed by `modules` |
| `N8N_DISABLED_MODULES` | Turns a default module off, e.g. `instance-ai` to disable the Assistant |
| `N8N_INSTANCE_AI_MODEL`, `N8N_INSTANCE_AI_MODEL_API_KEY`, `*_API_KEY` | Assistant model and keys; see Keys and models |
| `N8N_AGENTS_AI_SANDBOX_ENABLED`, `N8N_AGENTS_AI_SANDBOX_PROVIDER` | Agent knowledge base; `true` and `daytona` |
| `DAYTONA_API_URL`, `DAYTONA_API_KEY` | Daytona account for the knowledge base sandbox |
| `WEBHOOK_URL` | Public HTTPS URL for channels and external webhooks |
| `GENERIC_TIMEZONE` | Timezone for schedule triggers, e.g. `Europe/Amsterdam` |
| `EXECUTIONS_DATA_PRUNE` | `true` to prune old executions (default on) |
| `EXECUTIONS_DATA_MAX_AGE` | Hours to keep executions; default 336 (14 days) |
| `EXECUTIONS_DATA_PRUNE_MAX_COUNT` | Maximum executions kept; default 10000 |

Every agent turn is an execution and stores a session, so the SQLite database
grows faster with agents in use. A retention such as `EXECUTIONS_DATA_MAX_AGE=168`
(7 days) and `EXECUTIONS_DATA_PRUNE_MAX_COUNT=5000` keeps it in check on a
laptop. Documented at
[Manage execution data](https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/manage-execution-data/).

## Security notes

- Never print, `cat`, log or commit `n8n/.env` or anything under
  `n8n-backups/`. To inspect `.env`, list variable names only:
  `cut -d= -f1 n8n/.env`.
- `.gitignore` excludes `n8n/`, `n8n-backups/`, `exports/` and `n8nctl.log`;
  `install` and `export` add the entries if missing and `preflight` checks them.
- With the example override, port 5678 is bound to loopback. Without it, the
  port listens on all interfaces; on anything other than a personal machine
  put a firewall or an authenticated TLS reverse proxy in front.
- The sandbox runner is privileged Docker-in-Docker. Never publish its ports.
- The Assistant and Agents are in Preview. Review generated workflows before
  production use.
- Agents act on your behalf. Mark write-capable tools (send, post, delete,
  pay) as requiring approval in the Agent Builder, review the Sessions tab to
  see which tools were called, and treat anything an agent reads from Slack,
  Notion, email or the web as untrusted text that may try to steer it.
- The knowledge base is an opt-in that sends uploaded files to a Daytona
  cloud sandbox. Enable it deliberately, with `set-key --var daytona` for the
  key, and know that those files leave the machine.
- The bundled sandbox and SQLite are for local use. For production n8n
  recommends Daytona for the sandbox and Postgres for the database.
- From n8n 3.0 (October 2026), npm/npx installs stop working; Docker is the
  only distribution path.

See [CLAUDE.md](CLAUDE.md) for the working rules (secrets, generated files,
destructive operations) and links to the upstream docs.

## Developing the wrapper

```bash
bash -n n8nctl.sh && shellcheck n8nctl.sh
test/smoke.sh
```

`test/smoke.sh` runs every command offline against stub `docker` and `curl`
scripts in `test/stubs/`, with the upstream installer and compose file served
from `test/fixtures/`. It passes on macOS with only `/usr/bin` on `PATH`
(BSD grep, bash 3.2) and on Ubuntu with GNU tools. CI runs syntax checks,
shellcheck on all scripts, a hash check on the vendored installer, and the
smoke test on `ubuntu-24.04` and `macos-15`. Validate workflow edits with
`actionlint` before pushing. Add a `check` line to the smoke test for any new
behaviour.

Design rules for `n8nctl.sh`: one `cmd_<name>` function per subcommand
dispatched from the `case` at the bottom; `ok` / `warn` / `die` / `log`
helpers; anything that changes state gets a `log` line; never pipe a download
into a shell; portable across GNU and BSD tools (dual `stat`, `sha256sum` /
`shasum`, `${arr[@]+"${arr[@]}"}` for bash 3.2).
