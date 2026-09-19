# n8n-local

Self-hosted [n8n](https://n8n.io) (Community edition) on Docker, installed with
n8n's official one-line installer and driven by `n8nctl.sh`, a small bash
wrapper that adds the safety rails the raw `curl | sh` flow lacks:

- the installer is downloaded to a file, hashed, compared with the last hash in
  `n8nctl.log`, and offered for review before it runs. It is never piped into a shell
- every install and upgrade is pinned to an explicit n8n version
- the AI Assistant model key is entered on a hidden prompt (or piped on stdin)
  and written straight to `n8n/.env`, never to a command line or the log
- backups pause n8n for a consistent SQLite snapshot and keep `.env` (which
  holds the encryption key) together with the data tarball
- restore, upgrade and uninstall all take a snapshot first, and downgrades are refused

The n8n Assistant is a bring-your-own-key feature: Anthropic, OpenAI, or
OpenRouter. n8n itself is free; the model provider is the only cost.

## Requirements

Docker with the `docker compose` v2 plugin, `curl`, and bash 3.2+ (Linux or macOS).
On Windows use WSL with Docker Desktop's WSL2 integration.

## Quick start

```bash
./n8nctl.sh preflight                     # check Docker, compose v2, port 5678
./n8nctl.sh install --version 2.35.3      # pinned install; review the installer when asked
./n8nctl.sh set-key                       # hidden prompt for the Assistant model key
./n8nctl.sh status                        # health, versions, key present?
```

Then open <http://localhost:5678>, create the owner account, and pick the
provider and model under the instance AI settings in the UI.

## Everyday commands

| Task | Command |
| --- | --- |
| Start / stop / follow logs | `./n8nctl.sh start` · `stop` · `logs [service]` |
| Snapshot | `./n8nctl.sh backup` |
| List snapshots | `./n8nctl.sh backups` |
| Check a snapshot | `./n8nctl.sh verify n8n-backups/<timestamp>` |
| Keep only the newest N snapshots | `./n8nctl.sh backups --prune N` |
| Roll back | `./n8nctl.sh restore n8n-backups/<timestamp>` |
| Upgrade (backs up first) | `./n8nctl.sh upgrade --version X.Y.Z` |
| Remove everything | `./n8nctl.sh uninstall` |
| Skip prompts | add `-y` / `--yes` |

`upgrade` and `uninstall` accept `--skip-backup`; `restore` accepts
`--no-safety-backup`. `install` and `upgrade` accept `--no-start`.

## Two providers: a partner key and a fallback

The Assistant uses one model at a time, but you can keep a key on file for
each provider and switch between them in one command. n8n reads the generic
`N8N_INSTANCE_AI_MODEL_API_KEY` if set, otherwise the active provider's own
variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`). n8n has
no automatic failover, so the fallback is a manual switch:

```bash
./n8nctl.sh set-key --provider anthropic     # primary
./n8nctl.sh set-key --provider openrouter    # partner / fallback
./n8nctl.sh set-key --remove                 # clear the generic key so per-provider keys apply
./n8nctl.sh status                           # shows "keys on file" and the active model

./n8nctl.sh set-model openrouter/anthropic/claude-opus-4-8   # switch when the primary is down
./n8nctl.sh set-model anthropic/claude-opus-4-8              # and back
```

OpenRouter alone already routes each model across several upstream providers,
so an OpenRouter key is the simplest single-key redundancy. The model name
must be one the provider offers; check the provider's model list.

## Local-only binding and other customizations

`n8n/compose.override.yml` holds local changes to the stack. The upstream
installer never touches it, the wrapper passes it to every compose call, and
`backup` includes it. The copy in [examples/compose.override.yml](examples/compose.override.yml)
binds n8n to `127.0.0.1` so nothing else on the network can reach it:

```bash
cp examples/compose.override.yml n8n/compose.override.yml
./n8nctl.sh start        # recreates the n8n container with the new binding
```

Remove the `127.0.0.1:` prefix only if you deliberately want LAN access, and
prefer a TLS reverse proxy for anything beyond that.

## Nightly backups (macOS launchd)

[launchd/com.n8nctl.backup.plist](launchd/com.n8nctl.backup.plist) runs
`backup` every night at 03:30 and then prunes to the newest 14 snapshots.
Edit the paths inside if the project moves, then:

```bash
cp launchd/com.n8nctl.backup.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.n8nctl.backup.plist
launchctl kickstart -k gui/$(id -u)/com.n8nctl.backup     # run it once now
```

Output goes to `n8n-backups/launchd.log`. To remove it:

```bash
launchctl bootout gui/$(id -u)/com.n8nctl.backup
```

n8n pauses for a few seconds during each snapshot.

## Layout

```
.
├── n8nctl.sh            # the wrapper; the only code we own
├── n8nctl.log           # append-only: installer hashes, installs, upgrades, backups
├── n8n/                 # created by the upstream installer; treat as generated
│   ├── compose.yml      # do not hand-edit; use compose.override.yml next to it
│   ├── .env             # secrets (chmod 600)
│   └── searxng-settings.yml
└── n8n-backups/<timestamp>/
    ├── n8n-data.tar.gz  # the Docker data volume
    ├── manifest         # version, volume name, tarball sha256, reason
    └── compose.yml, .env, searxng-settings.yml
```

Data lives in a Docker volume named `*n8n-data`, not in `./n8n`. The wrapper
auto-detects it; set `N8N_VOLUME` to override. `N8N_BASE_DIR` and
`N8N_BACKUP_DIR` move the install and backup locations.

## Notes

- Only port 5678 is published. It listens on all interfaces, so on anything
  other than a personal machine put a firewall or an authenticated TLS reverse
  proxy in front before sharing the URL.
- The Assistant is in Preview. Review generated workflows before production use.
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
from `test/fixtures/`. CI runs the same on Linux and macOS.
