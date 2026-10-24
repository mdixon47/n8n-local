# CLAUDE.md

Context for Claude Code when working in this repo.

## What this project is

A self-hosted n8n (Community edition) instance installed via n8n's official one-line installer, plus `n8nctl.sh`, a bash wrapper that adds review-before-run, version pinning, safe key handling, backups, and rollback.

The n8n AI Assistant (a.k.a. n8n Assistant, module name `instance-ai`) is enabled with a bring-your-own model key: Anthropic, OpenAI, or OpenRouter. n8n itself is free; the model provider is the only cost.

## Layout

```
.
├── n8nctl.sh            # the wrapper; the only code we own
├── README.md            # reference
├── docs/                # learn.md: guided tour; issues.md: open items; improvements.md: planned changes; backup-plan.md: schedule, checks, recovery
├── n8nctl.log           # append-only: installer hashes, installs, upgrades, backups
├── test/                # smoke.sh + stub docker/curl + vendored installer fixtures
├── examples/            # compose.override.yml template (binds n8n to 127.0.0.1)
├── launchd/             # nightly LaunchAgent (23:00) -> n8nctl-backup.applescript app -> nightly.sh: backup, keep 14, patch upgrade, update check, save pinned chats, alert on failing triggers (status: `Triggers:`); log in ~/Library/Logs
├── templates-api/       # local Templates gallery + ideas page + prompt generator (/prompts -> ai-prompt-generator webhook): server.py, build.py, web/; data/ generated, library/ (n8n.io templates stored on import, the server's only writable mount), both gitignored
├── runtime/             # force-http1.cjs: preloaded into n8n (NODE_OPTIONS) so fetch uses HTTP/1.1; n8n will not start without it
├── n8n/                 # CREATED BY THE UPSTREAM INSTALLER - treat as generated
│   ├── compose.yml
│   ├── compose.override.yml  # ours: local customizations, picked up by the wrapper
│   ├── .env             # secrets: encryption key, model API key. chmod 600.
│   └── searxng-settings.yml
├── exports/<timestamp>/ # n8nctl export: workflows/*.json + all-workflows.json, gitignored
├── chats/               # n8nctl chats save: AI Assistant chats as Markdown, one file per chat, gitignored, 700/600
└── n8n-backups/<timestamp>/
    ├── n8n-data.tar.gz  # tar of the Docker data volume
    └── compose.yml, .env, searxng-settings.yml
```

Data lives in a Docker volume (`n8n-data`, possibly prefixed by the compose project name), not in `./n8n`. Database is SQLite inside that volume.

## Commands

Always go through the wrapper rather than raw `curl | sh`:

| Task | Command |
| --- | --- |
| Check prerequisites | `./n8nctl.sh preflight` |
| Fresh install (pinned) | `./n8nctl.sh install --version 2.35.3` |
| Set the AI Assistant key | `./n8nctl.sh set-key [--provider anthropic\|openai\|openrouter]` (hidden prompt, or pipe the key on stdin); `--remove` deletes it |
| Switch the Assistant model | `./n8nctl.sh set-model <provider>/<model>` |
| Store the Daytona / Brave key | `./n8nctl.sh set-key --var daytona` · `--var brave` |
| Show / enable / disable modules | `./n8nctl.sh modules [--enable agents \| --disable agents]` (edits `N8N_ENABLED_MODULES` only) |
| Health and config check | `./n8nctl.sh status` |
| Start / stop / logs | `./n8nctl.sh start` · `stop` · `logs [service]` |
| Snapshot | `./n8nctl.sh backup` |
| Export all workflows as JSON (no credentials) | `./n8nctl.sh export` → `exports/<timestamp>/` |
| List / save / pin Assistant chats | `./n8nctl.sh chats` · `chats save [--pinned \| ID...]` → `chats/` · `chats pin\|unpin ID...` (pin flag `n8nLocalPinned` in the chat's metadata; also from the Assistant UI via editor-hook.js) |
| List snapshots | `./n8nctl.sh backups` |
| Check a snapshot | `./n8nctl.sh verify n8n-backups/<timestamp>` |
| Prune to newest N | `./n8nctl.sh backups --prune N` (deletes; confirm first) |
| Roll back | `./n8nctl.sh restore n8n-backups/<timestamp>` |
| Check for a newer n8n | `./n8nctl.sh check-update` (exit 3 if a stable update exists) |
| Upgrade (backs up first) | `./n8nctl.sh upgrade --version X.Y.Z` |
| Newest patch, unattended | `./n8nctl.sh -y upgrade --patch-only` (nightly job; same X.Y, a day old, known installer only; exit 4 if checks fail) |
| Skip prompts | add `-y` / `--yes` |

Raw upstream equivalents, for reference only:

```bash
curl -fsSL https://get.n8n.io | sh                                   # install
curl -fsSL https://get.n8n.io | sh -s -- --upgrade --version 2.35.3  # upgrade
docker compose -f ./n8n/compose.yml up -d                            # start / apply .env changes
docker compose -f ./n8n/compose.yml down                             # stop (keeps data)
```

The separator before `--upgrade` is two ASCII hyphens (`--`). Blog posts and forum copies often render it as an en dash (`–`), which breaks the command. Fix it if you see it.

Upstream installer flags: `--version [X]`, `--no-start`, `--upgrade`, `--help`. The installer is idempotent: rerunning it against an existing `./n8n` changes nothing. `--upgrade` only bumps the version; data and customizations are untouched.

## Verified facts (n8n docs, Sept 2026)

- Requires Docker with the `docker compose` v2 plugin. The legacy `docker-compose` binary does not work. Podman/Colima need the docker CLI + compose plugin with `DOCKER_HOST` pointed at their socket.
- Windows: run under WSL with Docker Desktop's WSL2 integration. Git Bash is unverified upstream.
- The stack includes n8n, a bundled code sandbox (`n8n-sandbox`), a bundled private web search (SearXNG), and a task-runners sidecar. Only port `5678` is published; the rest stay on the internal network.
- The Assistant stays off until a model key exists. Generic key variable: `N8N_INSTANCE_AI_MODEL_API_KEY` in `./n8n/.env`; when it is empty n8n falls back to the active provider's own variable: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`. The generic key overrides all of them. The model is `N8N_INSTANCE_AI_MODEL` in `provider/model` form (default `anthropic/claude-opus-4-8`; providers: anthropic, openai, openrouter). Model ids follow the provider's spelling: OpenRouter uses `anthropic/claude-opus-4.8` (dot), Anthropic uses `claude-opus-4-8` (dash); a wrong spelling gives "model not found", not an auth error. One model is active at a time; there is no automatic failover. Keys can also be set in the UI under the instance AI settings.
- Assistant chats are deleted once idle for `N8N_INSTANCE_AI_THREAD_TTL_DAYS` days (default 30, checked hourly; `0` = never; read from n8n's `instance-ai.config.js` at 2.44.6). Set to `0` in `.env` on 2026-10-23 after nine chats from Sept 18-19 were pruned; they were copied back from snapshot `20261016-030006`.
- Optional: `INSTANCE_AI_BRAVE_SEARCH_API_KEY` in `.env` switches web search from the bundled tool to Brave. No `N8N_` prefix.
- **Agents (Preview)**, from n8n 2.32.3, self-hosted Community only (not Enterprise). Module `agents` is opt-in via `N8N_ENABLED_MODULES`; the installer does not set it. `instance-ai` is a default module (loads without being listed; only `N8N_DISABLED_MODULES` turns it off). Unknown names in `N8N_ENABLED_MODULES` stop n8n from starting; `KNOWN_MODULES` in the wrapper mirrors `modules.config.ts` at 2.35.3. Each agent has its own model credential in the UI; the Assistant key and `set-model` do not apply to agents. Episodic memory needs an OpenAI credential. Knowledge base needs Daytona: `N8N_AGENTS_AI_SANDBOX_ENABLED=true`, `N8N_AGENTS_AI_SANDBOX_PROVIDER=daytona`, `DAYTONA_API_URL`, `DAYTONA_API_KEY`. Channels need a public HTTPS `WEBHOOK_URL`. Queue mode unsupported for agents.
- Execution pruning: `EXECUTIONS_DATA_PRUNE`, `EXECUTIONS_DATA_MAX_AGE` (hours, default 336), `EXECUTIONS_DATA_PRUNE_MAX_COUNT` (default 10000). Timezone: `GENERIC_TIMEZONE`.
- n8n 3.0 also removes the "Any workflow" caller policy on sub-workflows (deprecated now).
- Health endpoint: `http://localhost:5678/healthz`.
- Templates: `N8N_TEMPLATES_ENABLED`, `N8N_TEMPLATES_HOST` (default `https://api.n8n.io/api/`). Any non-default host makes the editor's Templates link open the in-app gallery, fetched by the browser from that host (cross-origin, with credentials). Here it points at the `templates-api` service (port 5690); `python3 -I templates-api/build.py` rebuilds it from workflows tagged `template`. The Assistant's "See all" link ignores the templates host and always targets `https://n8n.io/workflows/`.
- `EXTERNAL_FRONTEND_HOOKS_URLS` (`;`-separated script URLs) is injected into the editor's `index.html` as `<script nonce=...>` tags at startup; needs an n8n restart. Here it loads `templates-api/web/editor-hook.js`, which sends n8n.io/workflows links to the ideas page at port 5690. Node icons under `/icons/...` on 5678 need a login, so `build.py` copies them into `templates-api/data/icons/`.
- n8n.io's template API (`https://api.n8n.io/api`): `/templates/search?page&rows&search&category=<name>` (category by name; `sort=` values other than the editor's are rejected), `/templates/categories`, `/templates/workflows/<id>` (details), `/workflows/templates/<id>` (importable workflow). The editor's import route is `/workflows/templates/:id`; it reads from the templates host, which here passes unknown ids through to n8n.io (`TEMPLATES_UPSTREAM`).
- Node type `CUSTOM.<name>` means a node loaded from a custom-nodes folder on the template author's machine; it never exists here. The same node from an npm community package is `<package>.<name>`, so a workflow needs its types changed after the package is installed (see docs/issues.md item 11). The gallery server maps `CUSTOM.<name>` to the one installed community type ending in `.<name>`, never to a built-in node.
- The Assistant is in **Preview**. Generated workflows must be reviewed before production use.
- The bundled sandbox and SQLite are positioned for local/dev. For production, n8n recommends Daytona for the sandbox and Postgres for the database (see the "Install using Docker Compose" and "Set up n8n Assistant" docs).
- From n8n 3.0 (October 2026), npm/npx installs stop working. Docker is the only distribution path.

Do not invent environment variable names, compose service names, or image tags. If something isn't listed here, read `./n8n/compose.yml` and `./n8n/.env` (variable names only) or check docs.n8n.io.

## Rules for working here

**Secrets**
- Never print, `cat`, log, or commit the contents of `n8n/.env` or anything under `n8n-backups/`. To inspect `.env`, list keys only: `cut -d= -f1 n8n/.env`.
- Never put an API key in a command line argument, a commit, or this file. Use `./n8nctl.sh set-key`.
- `.gitignore` must contain `n8n/`, `n8n-backups/`, `exports/`, `chats/`, and `n8nctl.log`. Never commit or print anything under `exports/` or `chats/` either; workflow JSON can hold webhook paths and hard-coded values, and chats can hold anything said to the Assistant.

**Generated files**
- Do not hand-edit `n8n/compose.yml`. The upstream installer owns it and future upgrades assume its shape. Put customizations in a `compose.override.yml` next to it, after reading the real service names from `compose.yml`.
- Editing `n8n/.env` is fine; apply with `docker compose -f ./n8n/compose.yml up -d`.

**Destructive operations: ask the user first**
- `./n8nctl.sh uninstall`, `./n8nctl.sh restore`, `docker compose down -v`, `docker volume rm`, and `rm -rf n8n` all destroy data. Never run them unprompted, and never pass `-y` to them on your own initiative.
- Never upgrade with `--skip-backup` unless the user asks.
- Patch upgrades happen on their own: the nightly job runs `upgrade --patch-only` (same X.Y only). Minor and major upgrades are the user's call; `upgrade` without `--version` refuses a new major version. n8n's stable channel is GitHub releases without `prerelease`, excluding the 1.x maintenance line; `release_list` in the wrapper reads it.
- Downgrading means `restore` from a backup taken at the older version. Do not point a newer database at an older n8n image; migrations are one-way.

**Backups**
- The encryption key in `.env` must travel with the database. A data tarball without its `.env` cannot decrypt stored credentials. This is why `restore` puts back config and data together.
- `backup` stops n8n briefly for a consistent SQLite snapshot, then restarts it. Expect a few seconds of downtime.

**Network exposure**
- Port 5678 is reachable from other machines by default. On anything other than a personal laptop, put a firewall rule or an authenticated reverse proxy with TLS in front of it before sharing the URL.

## Editing `n8nctl.sh`

- Bash, `set -euo pipefail`. Keep it a single file with no dependencies beyond `docker`, `curl`, and coreutils. Must work on Linux and macOS (note the dual `stat` and `sha256sum`/`shasum` handling; empty-array expansion uses the `${arr[@]+"${arr[@]}"}` form for macOS bash 3.2).
- One `cmd_<name>` function per subcommand, dispatched from the `case` at the bottom. Update `cmd_help` when adding one.
- Use the `ok` / `warn` / `die` / `log` helpers. Anything that changes state gets a `log` line.
- Never pipe a download into a shell. Go through `fetch_installer`, which downloads, hashes, compares with the last logged hash, and offers review.
- Verify after changes: `bash -n n8nctl.sh`, `shellcheck n8nctl.sh`, and `test/smoke.sh` (offline; stub `docker`/`curl` in `test/stubs/`, fixtures in `test/fixtures/`). Add a `check` line to `test/smoke.sh` for any new behaviour.
- Known assumption: the data volume name ends in `n8n-data`. `N8N_VOLUME` overrides auto-detection.

## Environment overrides

| Variable | Purpose | Default |
| --- | --- | --- |
| `N8N_BASE_DIR` | Directory containing `./n8n` | `$PWD` |
| `N8N_BACKUP_DIR` | Backup destination | `$N8N_BASE_DIR/n8n-backups` |
| `N8N_VOLUME` | Data volume name | auto-detect `*n8n-data` |
| `N8N_EXPORT_DIR` | Workflow export destination | `$N8N_BASE_DIR/exports` |
| `N8N_CHATS_DIR` | Saved Assistant chats | `$N8N_BASE_DIR/chats` |

## References

- One-line setup: https://docs.n8n.io/deploy/host-n8n/install-options/one-line-setup
- Set up n8n Assistant: https://docs.n8n.io/deploy/host-n8n/configure-n8n/set-up-n8n-assistant
- Docker Compose install (Postgres, production): https://docs.n8n.io/deploy/host-n8n/install-options/install-using-docker-compose
- Build and manage agents: https://docs.n8n.io/build/build-and-manage-agents
- Enable agents (self-hosted): https://docs.n8n.io/deploy/host-n8n/configure-n8n/set-up-n8n-assistant#enable-agents
- Manage execution data: https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/manage-execution-data/
- Release notes: https://docs.n8n.io/release-notes/
