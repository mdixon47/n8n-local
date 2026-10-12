#!/usr/bin/env bash
#
# n8nctl.sh - a safety wrapper around n8n's one-line installer (https://get.n8n.io)
#
# What it adds on top of `curl -fsSL https://get.n8n.io | sh`:
#   - never pipes a download into a shell: the installer is fetched to a temp
#     file, hashed, compared with the last hash in n8nctl.log, and offered for
#     review before it runs
#   - version pinning (install/upgrade always pass --version)
#   - hidden entry of the AI Assistant model key, written straight to n8n/.env
#   - consistent backups (n8n paused for the SQLite snapshot) and rollback
#   - an append-only log of every state change
#
# Single file. Needs docker (with the compose v2 plugin), curl, and coreutils.
# Works on Linux and macOS (bash 3.2+).
#
# Usage: ./n8nctl.sh <command> [options]    (see ./n8nctl.sh help)
set -euo pipefail

N8NCTL_VERSION="1.5.0"
INSTALLER_URL="https://get.n8n.io"
RELEASES_URL="https://api.github.com/repos/n8n-io/n8n/releases/latest"
N8N_PORT=5678
# Reads the data volume for backups and wipes it on restore, so pinned like
# everything else; recorded in each backup's manifest.
HELPER_IMAGE="alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6"

N8N_BASE_DIR="${N8N_BASE_DIR:-$PWD}"
N8N_DIR="$N8N_BASE_DIR/n8n"
N8N_BACKUP_DIR="${N8N_BACKUP_DIR:-$N8N_BASE_DIR/n8n-backups}"
N8N_EXPORT_DIR="${N8N_EXPORT_DIR:-$N8N_BASE_DIR/exports}"
LOG_FILE="$N8N_BASE_DIR/n8nctl.log"
GITIGNORE_FILE="$N8N_BASE_DIR/.gitignore"

# The variable n8n reads the Assistant's model key from (see CLAUDE.md).
KEY_VAR="N8N_INSTANCE_AI_MODEL_API_KEY"
MODEL_VAR="N8N_INSTANCE_AI_MODEL"
BRAVE_VAR="INSTANCE_AI_BRAVE_SEARCH_API_KEY"
DEFAULT_MODEL="anthropic/claude-opus-4-8"   # n8n's own default when MODEL_VAR is unset
PROVIDERS="anthropic openai openrouter"      # providers n8n documents for the Assistant

MODULES_VAR="N8N_ENABLED_MODULES"
AGENTS_MIN_VERSION="2.32.3"                  # Agents (Preview) available from this release
# Module names n8n 2.35.3 accepts in N8N_ENABLED_MODULES
# (packages/@n8n/backend-common/src/modules/modules.config.ts). An unknown
# name makes n8n refuse to start, so the wrapper validates against this list.
# Modules n8n 2.35.3 loads without being listed (module-registry.ts defaultModules).
# Removing one of these from N8N_ENABLED_MODULES does not turn it off.
DEFAULT_MODULES="insights external-secrets community-packages data-table oauth-server mcp provisioning breaking-changes source-control dynamic-credentials chat-hub sso-oidc sso-saml log-streaming ldap quick-connect workflow-builder favorites redaction instance-registry otel token-exchange instance-version-history encryption-key-manager oauth-jwe n8n-packages runtime-credentials mcp-registry workflow-reviews instance-ai"
KNOWN_MODULES="agents agent-evals insights external-secrets community-packages data-table oauth-server mcp provisioning breaking-changes source-control dynamic-credentials chat-hub sso-oidc sso-saml log-streaming ldap quick-connect workflow-builder favorites redaction instance-registry instance-ai mcp-registry otel token-exchange instance-version-history encryption-key-manager oauth-jwe runtime-credentials n8n-packages workflow-reviews"

# Other secrets set-key can store with the same hidden prompt (set-key --var NAME).
extra_secret_var() {
  case "$1" in
    daytona) printf 'DAYTONA_API_KEY\n' ;;                 # agents knowledge base / Daytona sandbox
    brave)   printf 'INSTANCE_AI_BRAVE_SEARCH_API_KEY\n' ;; # web search; note: no N8N_ prefix
    *) return 1 ;;
  esac
}

# Per-provider key variable n8n falls back to when KEY_VAR is empty
# (packages/cli/src/modules/instance-ai/instance-ai-settings.service.ts).
provider_key_var() {
  case "$1" in
    anthropic)  printf 'ANTHROPIC_API_KEY\n' ;;
    openai)     printf 'OPENAI_API_KEY\n' ;;
    openrouter) printf 'OPENROUTER_API_KEY\n' ;;
    *) return 1 ;;
  esac
}

ASSUME_YES=0
TMP_DIR=""
INSTALLER=""
BACKUP_PATH=""

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
if [[ -t 1 && -z "${NO_COLOR:-}" && "${TERM:-dumb}" != "dumb" ]]; then
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[1;31m'
  C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_BOLD=""; C_DIM=""; C_RESET=""
fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '%s+%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%sError:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }
log()  { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG_FILE"; }

cleanup() {
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then rm -rf "$TMP_DIR"; fi
}
trap cleanup EXIT

# confirm "question"  -> 0 on yes. -y/--yes answers yes to everything.
confirm() {
  local answer
  if (( ASSUME_YES )); then return 0; fi
  if [[ ! -t 0 ]]; then
    die "'$1' needs an interactive terminal to answer (or pass -y/--yes)"
  fi
  printf '%s [y/N] ' "$1"
  read -r answer
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]
}

# ---------------------------------------------------------------------------
# Portable helpers (Linux + macOS)
# ---------------------------------------------------------------------------
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "need sha256sum or shasum to verify downloads"
  fi
}

# Octal permission bits of a file, e.g. 600.
file_mode() {
  if stat -c %a "$1" >/dev/null 2>&1; then
    stat -c %a "$1"
  else
    stat -f %Lp "$1"
  fi
}

dir_size() { du -sh "$1" 2>/dev/null | cut -f1; }

# Seconds since the epoch for a snapshot name (YYYYMMDD-HHMMSS[_N], UTC), or
# nothing if it cannot be parsed.
snapshot_epoch() {
  local s="${1%%_*}" iso
  [[ "$s" =~ ^[0-9]{8}-[0-9]{6}$ ]] || return 0
  iso="${s:0:4}-${s:4:2}-${s:6:2} ${s:9:2}:${s:11:2}:${s:13:2}"
  date -j -u -f '%Y%m%d-%H%M%S' "$s" +%s 2>/dev/null || date -u -d "$iso" +%s 2>/dev/null || true
}

valid_version() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; }

# version_lt A B -> 0 when A < B (numeric, per component)
version_lt() {
  local a b i
  IFS=. read -r -a a <<<"$1"
  IFS=. read -r -a b <<<"$2"
  for i in 0 1 2; do
    if (( 10#${a[i]:-0} < 10#${b[i]:-0} )); then return 0; fi
    if (( 10#${a[i]:-0} > 10#${b[i]:-0} )); then return 1; fi
  done
  return 1
}

# Latest stable n8n release tag from GitHub, or empty if unreachable.
resolve_latest_version() {
  local v
  v="$(curl -fsSL --max-time 10 "$RELEASES_URL" 2>/dev/null |
    sed -n 's/.*"tag_name": *"n8n@\([0-9][0-9.]*\)".*/\1/p' | head -n1)"
  if valid_version "$v"; then printf '%s\n' "$v"; fi
}

# ---------------------------------------------------------------------------
# Docker / compose helpers
# ---------------------------------------------------------------------------
check_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed (see https://docs.docker.com/get-docker/)"
  docker compose version >/dev/null 2>&1 ||
    die "the 'docker compose' v2 plugin is not available (the legacy docker-compose binary is not supported)"
  docker info >/dev/null 2>&1 ||
    die "the Docker daemon is not running (or DOCKER_HOST points at a dead socket)"
}

compose_files() {
  printf '%s\n' -f "$N8N_DIR/compose.yml"
  # `-f` disables compose's automatic override discovery, so add it explicitly.
  if [[ -f "$N8N_DIR/compose.override.yml" ]]; then
    printf '%s\n' -f "$N8N_DIR/compose.override.yml"
  fi
}

compose() {
  local files=()
  while IFS= read -r line; do files+=("$line"); done < <(compose_files)
  docker compose "${files[@]}" "$@"
}

require_install() {
  [[ -f "$N8N_DIR/compose.yml" && -f "$N8N_DIR/.env" ]] ||
    die "no n8n install found in $N8N_DIR (run './n8nctl.sh install --version X.Y.Z')"
}

is_installed() { [[ -f "$N8N_DIR/compose.yml" || -f "$N8N_DIR/.env" ]]; }

n8n_running() {
  [[ -n "$(compose ps -q --status running n8n 2>/dev/null)" ]]
}

n8n_healthy() {
  curl -fsS --noproxy '*' --max-time 3 -o /dev/null "http://127.0.0.1:${N8N_PORT}/healthz" 2>/dev/null
}

# Something answers on the port (mirrors the upstream check: refusals and
# timeouts count as free).
port_in_use() {
  local rc=0
  curl -s -o /dev/null --noproxy '*' --max-time 2 "http://127.0.0.1:${N8N_PORT}/" 2>/dev/null || rc=$?
  [[ $rc -eq 0 || $rc -eq 52 || $rc -eq 56 ]]
}

wait_healthy() {
  local limit="${1:-180}" waited=0
  printf 'Waiting for n8n to become ready'
  while (( waited < limit )); do
    if n8n_healthy; then printf ' %sready%s\n' "$C_GREEN" "$C_RESET"; return 0; fi
    printf '.'
    sleep 3
    waited=$((waited + 3))
  done
  printf '\n'
  return 1
}

# Checks on the running stack: container health checks, bind mounts (they go
# dead after a sleep when the project is on an external drive) and, when the
# override preloads runtime/force-http1.cjs, its confirmation line in the n8n
# log. Prints a line per finding; returns 1 if anything needs attention.
check_runtime() {
  local cid name health mounts m line bad=0 nmounts=0
  while IFS= read -r cid; do
    [[ -n "$cid" ]] || continue
    name="$(docker inspect -f '{{.Name}}' "$cid" 2>/dev/null || true)"; name="${name#/}"
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$cid" 2>/dev/null || true)"
    case "$health" in
      ""|healthy) ;;
      starting) say "${name:-$cid} is still starting" ;;
      *) warn "${name:-$cid} health check: $health"; bad=1 ;;
    esac
    mounts="$(docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{println .Destination}}{{end}}{{end}}' "$cid" 2>/dev/null || true)"
    while IFS= read -r m; do
      [[ -n "$m" ]] || continue
      nmounts=$((nmounts + 1))
      if ! docker exec "$cid" ls "$m" >/dev/null 2>&1; then
        warn "${name:-$cid}: bind mount $m is not readable; run './n8nctl.sh stop' then './n8nctl.sh start'"
        bad=1
      fi
    done <<<"$mounts"
  done < <(compose ps -q 2>/dev/null || true)
  (( nmounts > 0 )) && (( ! bad )) && ok "Bind mounts: all $nmounts readable"

  if grep -q 'force-http1' "$N8N_DIR/compose.override.yml" 2>/dev/null; then
    line="$(compose logs --no-color --no-log-prefix n8n 2>/dev/null | grep '\[n8n-local\]' | tail -n1 || true)"
    case "$line" in
      *'fetch uses HTTP/1.1'*) ok "Preload: fetch uses HTTP/1.1" ;;
      "") warn "Preload: no [n8n-local] line in the n8n log; is runtime/force-http1.cjs loaded?"; bad=1 ;;
      *) warn "Preload: $line"; bad=1 ;;
    esac
  fi
  return "$bad"
}

# Data volume: N8N_VOLUME overrides; otherwise the single volume named *n8n-data,
# preferring the one compose derives from the install directory name.
detect_volume() {
  if [[ -n "${N8N_VOLUME:-}" ]]; then printf '%s\n' "$N8N_VOLUME"; return 0; fi
  local vols count preferred
  vols="$(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E '(^|[_-])n8n-data$' || true)"
  count="$(printf '%s\n' "$vols" | grep -c . || true)"
  if (( count == 0 )); then return 1; fi
  if (( count == 1 )); then printf '%s\n' "$vols"; return 0; fi
  preferred="$(basename "$N8N_DIR" | tr '[:upper:]' '[:lower:]')_n8n-data"
  if printf '%s\n' "$vols" | grep -qx "$preferred"; then printf '%s\n' "$preferred"; return 0; fi
  die "several candidate data volumes found ($(printf '%s' "$vols" | tr '\n' ' ')); set N8N_VOLUME to pick one"
}

# ---------------------------------------------------------------------------
# .env helpers (variable names only are ever printed)
# ---------------------------------------------------------------------------
env_get() { sed -n "s/^$1=//p" "$N8N_DIR/.env" | head -n1; }

env_is_set() { grep -qE "^$1=.+" "$N8N_DIR/.env" 2>/dev/null; }

# Replace or append NAME=VALUE without passing the value through sed/awk
# program text (values may contain any characters).
env_set() {
  local var="$1" tmp
  tmp="$N8N_DIR/.env.tmp.$$"
  (
    umask 077
    N8NCTL_ENV_VALUE="$2" awk -v var="$var" '
      BEGIN { v = ENVIRON["N8NCTL_ENV_VALUE"] }
      index($0, var "=") == 1 { print var "=" v; done = 1; next }
      { print }
      END { if (!done) print var "=" v }
    ' "$N8N_DIR/.env" >"$tmp"
  )
  mv "$tmp" "$N8N_DIR/.env"
  chmod 600 "$N8N_DIR/.env"
}

# Remove NAME=... lines entirely.
env_unset() {
  local tmp="$N8N_DIR/.env.tmp.$$"
  ( umask 077; grep -v "^$1=" "$N8N_DIR/.env" >"$tmp" || true )
  mv "$tmp" "$N8N_DIR/.env"
  chmod 600 "$N8N_DIR/.env"
}

ensure_gitignore() {
  local entry changed=0
  for entry in "n8n/" "n8n-backups/" "n8nctl.log" "exports/"; do
    if ! grep -qxF "$entry" "$GITIGNORE_FILE" 2>/dev/null; then
      printf '%s\n' "$entry" >>"$GITIGNORE_FILE"
      changed=1
    fi
  done
  (( changed )) && ok "Added missing entries to .gitignore (n8n/, n8n-backups/, n8nctl.log, exports/)"
  return 0
}

gitignore_ok() {
  local entry
  for entry in "n8n/" "n8n-backups/" "n8nctl.log" "exports/"; do
    grep -qxF "$entry" "$GITIGNORE_FILE" 2>/dev/null || return 1
  done
}

# ---------------------------------------------------------------------------
# Installer handling: download -> verify -> hash -> compare -> review -> run
# ---------------------------------------------------------------------------
fetch_installer() {
  local hash script_ver last_hash changed=0 last_line
  TMP_DIR="$(mktemp -d)"
  chmod 700 "$TMP_DIR"
  INSTALLER="$TMP_DIR/get-n8n.sh"

  say "Downloading installer from $INSTALLER_URL ..."
  curl -fsSL --max-time 60 "$INSTALLER_URL" -o "$INSTALLER" ||
    die "could not download the installer from $INSTALLER_URL"

  # The upstream script calls main on its last line so a truncated download
  # executes nothing. Check for that marker and for a shell shebang.
  [[ "$(head -n1 "$INSTALLER")" == '#!/bin/sh' ]] || die "downloaded installer does not start with '#!/bin/sh'; refusing to run it"
  last_line="$(grep -v '^[[:space:]]*$' "$INSTALLER" | tail -n1)"
  [[ "$last_line" == 'main "$@"' ]] || die "downloaded installer looks truncated (last line: $last_line); refusing to run it"

  hash="$(sha256_file "$INSTALLER")"
  script_ver="$(sed -n 's/^SCRIPT_VERSION="\(.*\)"/\1/p' "$INSTALLER" | head -n1)"
  last_hash="$(sed -n 's/.*installer_sha256=\([0-9a-f]\{64\}\).*/\1/p' "$LOG_FILE" 2>/dev/null | tail -n1 || true)"

  say "Installer: get-n8n.sh v${script_ver:-?}, $(wc -l <"$INSTALLER" | tr -d ' ') lines"
  say "sha256:    $hash"
  if [[ -z "$last_hash" ]]; then
    warn "First time seeing this installer (no previous hash in n8nctl.log)."
    changed=1
  elif [[ "$hash" != "$last_hash" ]]; then
    warn "The installer CHANGED since it was last run."
    warn "previous sha256: $last_hash"
    changed=1
  else
    ok "Installer unchanged since it was last run"
  fi

  if (( changed )); then
    if (( ASSUME_YES )); then
      warn "Proceeding without review because -y/--yes was given."
    elif [[ -t 0 ]]; then
      if confirm "Review the installer before running it?"; then
        "${PAGER:-less}" "$INSTALLER"
      fi
      confirm "Run this installer?" || die "aborted; nothing was changed"
    else
      die "the installer is new or changed; run interactively to review it, or pass -y/--yes"
    fi
  fi
  log "installer  installer_sha256=$hash script_version=${script_ver:-?} source=$INSTALLER_URL"
}

# Runs the reviewed installer from its temp file. DO_NOT_TRACK stops the
# upstream script from offering an anonymous failure report on /dev/tty.
run_installer() {
  [[ -n "$INSTALLER" && -f "$INSTALLER" ]] || die "internal: installer not fetched"
  (
    cd "$N8N_BASE_DIR"
    N8N_DIR="$N8N_DIR" DO_NOT_TRACK=1 sh "$INSTALLER" "$@"
  )
}

# Resolve --version or fall back to the latest release, with confirmation.
pick_version() {
  local requested="$1" latest
  if [[ -n "$requested" ]]; then
    valid_version "$requested" || die "invalid --version '$requested' (expected X.Y.Z, e.g. 2.35.3)"
    printf '%s\n' "$requested"
    return 0
  fi
  latest="$(resolve_latest_version)"
  [[ -n "$latest" ]] || die "no --version given and the latest release could not be looked up; pass --version X.Y.Z"
  warn "No --version given; latest stable release is $latest." >&2
  printf '%s\n' "$latest"
}

# ---------------------------------------------------------------------------
# Backup core (shared by backup, upgrade, restore, uninstall)
# ---------------------------------------------------------------------------
do_backup() {
  local reason="${1:-manual}" vol ts dest n was_running=0 ver sandbox f hash
  require_install
  check_docker
  vol="$(detect_volume)" || die "no data volume matching *n8n-data found. Has n8n been started at least once? (N8N_VOLUME overrides detection)"
  ts="$(date -u +%Y%m%d-%H%M%S)"
  dest="$N8N_BACKUP_DIR/$ts"
  # Two snapshots in the same second (e.g. pre-restore then restore) get a suffix.
  n=2
  while [[ -e "$dest" ]]; do dest="$N8N_BACKUP_DIR/${ts}_$n"; n=$((n + 1)); done
  mkdir -p "$dest"
  chmod 700 "$dest"

  if n8n_running; then
    was_running=1
    say "Stopping the n8n service briefly for a consistent SQLite snapshot ..."
    compose stop n8n >/dev/null
    # Whatever happens next, bring n8n back.
    trap 'compose start n8n >/dev/null 2>&1 || true; cleanup' EXIT
  fi

  say "Archiving volume $vol ..."
  docker run --rm \
    -v "$vol:/data:ro" \
    -v "$dest:/backup" \
    "$HELPER_IMAGE" tar czf /backup/n8n-data.tar.gz -C /data . ||
    die "archiving the data volume failed (backup dir left at $dest for inspection)"

  if (( was_running )); then
    compose start n8n >/dev/null
    trap cleanup EXIT
    wait_healthy 120 || warn "n8n restarted but has not reported healthy yet; check './n8nctl.sh status'"
  fi

  for f in compose.yml .env searxng-settings.yml compose.override.yml; do
    [[ -f "$N8N_DIR/$f" ]] && cp -p "$N8N_DIR/$f" "$dest/$f"
  done
  chmod 600 "$dest/.env"

  ver="$(env_get N8N_VERSION)"
  sandbox="$(env_get N8N_SANDBOX_VERSION)"
  hash="$(sha256_file "$dest/n8n-data.tar.gz")"
  cat >"$dest/manifest" <<EOF
created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
reason=$reason
n8n_version=${ver:-unknown}
sandbox_version=${sandbox:-unknown}
volume=$vol
data_sha256=$hash
n8nctl_version=$N8NCTL_VERSION
helper_image=$HELPER_IMAGE
EOF
  BACKUP_PATH="$dest"
  ok "Backup written to $dest ($(dir_size "$dest"))"
  log "backup  path=$dest reason=$reason version=${ver:-unknown} volume=$vol data_sha256=$hash helper=$HELPER_IMAGE"
}

manifest_get() { sed -n "s/^$2=//p" "$1/manifest" 2>/dev/null | head -n1; }

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
cmd_preflight() {
  local fails=0 v
  say "${C_BOLD}Preflight for $N8N_BASE_DIR${C_RESET}"
  say "OS: $(uname -s) $(uname -m), bash ${BASH_VERSION}"

  if command -v docker >/dev/null 2>&1; then
    ok "docker CLI: $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',')"
  else
    warn "docker CLI not found"; fails=1
  fi
  if v="$(docker compose version --short 2>/dev/null)"; then
    ok "docker compose v2 plugin: $v"
  else
    warn "docker compose v2 plugin missing (legacy docker-compose is not supported)"; fails=1
  fi
  if docker info >/dev/null 2>&1; then
    ok "Docker daemon reachable"
  else
    warn "Docker daemon not reachable (start Docker Desktop / dockerd, or check DOCKER_HOST)"; fails=1
  fi
  if command -v curl >/dev/null 2>&1; then ok "curl present"; else warn "curl missing"; fails=1; fi
  if command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1; then
    ok "sha256 tool present"
  else
    warn "neither sha256sum nor shasum found"; fails=1
  fi

  if is_installed; then
    ok "Existing install in $N8N_DIR (n8n $(env_get N8N_VERSION 2>/dev/null || echo '?'))"
  elif port_in_use; then
    warn "Something already answers on port $N8N_PORT; the installer will refuse to start"; fails=1
  else
    ok "Port $N8N_PORT is free"
  fi

  if [[ -f "$N8N_DIR/.env" ]]; then
    v="$(file_mode "$N8N_DIR/.env")"
    if [[ "$v" == "600" ]]; then ok ".env mode 600"; else warn ".env mode is $v (expected 600)"; fi
  fi

  if gitignore_ok; then
    ok ".gitignore covers n8n/, n8n-backups/, n8nctl.log, exports/"
  else
    warn ".gitignore is missing entries (install fixes this; or add n8n/, n8n-backups/, n8nctl.log, exports/)"
  fi
  say "Free space: $(df -h "$N8N_BASE_DIR" | awk 'NR==2{print $4}') on $(df -h "$N8N_BASE_DIR" | awk 'NR==2{print $1}')"
  warn "Port $N8N_PORT is published to all interfaces. On anything but a personal machine, put a firewall or a TLS reverse proxy in front."

  if (( fails )); then die "preflight found problems (see above)"; fi
  ok "Preflight passed"
}

cmd_install() {
  local requested="" no_start=0 ver args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version) [[ $# -ge 2 ]] || die "--version needs a value"; requested="$2"; shift ;;
      --version=*) requested="${1#*=}" ;;
      --no-start) no_start=1 ;;
      *) die "install: unknown option '$1'" ;;
    esac
    shift
  done

  if is_installed; then
    die "an install already exists in $N8N_DIR. Use 'upgrade --version X.Y.Z' to change versions, or 'uninstall' first."
  fi
  check_docker
  if (( ! no_start )) && port_in_use; then
    die "something already answers on port $N8N_PORT; stop it first (or use --no-start and edit the port mapping in a compose.override.yml)"
  fi
  ver="$(pick_version "$requested")"

  say ""
  say "${C_BOLD}Plan${C_RESET}"
  say "  n8n version:   $ver (pinned in n8n/.env as N8N_VERSION)"
  say "  install dir:   $N8N_DIR"
  say "  data:          Docker volume (*n8n-data), SQLite database"
  say "  services:      n8n, task runners, code sandbox (privileged dind), SearXNG web search"
  say "  published:     port $N8N_PORT only"
  (( no_start )) && say "  start:         no (--no-start)"
  say ""
  confirm "Install n8n $ver?" || die "aborted; nothing was changed"

  fetch_installer
  args=(--version "$ver")
  (( no_start )) && args+=(--no-start)
  run_installer "${args[@]}"

  [[ -f "$N8N_DIR/.env" ]] && chmod 600 "$N8N_DIR/.env"
  ensure_gitignore
  log "install  version=$ver dir=$N8N_DIR no_start=$no_start"

  say ""
  ok "Installed n8n $ver"
  say "Next steps:"
  say "  1. ./n8nctl.sh set-key        # AI Assistant model key (Anthropic, OpenAI, or OpenRouter)"
  say "  2. open http://localhost:$N8N_PORT and create the owner account"
  say "  3. pick provider and model under the instance AI settings in the UI"
  say "  4. ./n8nctl.sh backup         # once things look right"
  say "${C_DIM}The Assistant is in Preview; review generated workflows before production use.${C_RESET}"
}

cmd_upgrade() {
  local requested="" skip_backup=0 no_start=0 current target args=() backup_note="skipped"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version) [[ $# -ge 2 ]] || die "--version needs a value"; requested="$2"; shift ;;
      --version=*) requested="${1#*=}" ;;
      --skip-backup) skip_backup=1 ;;
      --no-start) no_start=1 ;;
      *) die "upgrade: unknown option '$1'" ;;
    esac
    shift
  done
  require_install
  check_docker

  current="$(env_get N8N_VERSION)"
  target="$(pick_version "$requested")"
  if [[ -n "$current" ]] && version_lt "$target" "$current"; then
    die "refusing to downgrade $current -> $target. Database migrations are one-way; use 'restore' with a backup taken at $target."
  fi
  if [[ "$target" == "$current" ]]; then
    warn "Already at n8n $current. Continuing only refreshes the sandbox service pin."
  fi

  say ""
  say "${C_BOLD}Plan${C_RESET}"
  say "  n8n:      ${current:-unset} -> $target"
  say "  backup:   $([[ $skip_backup -eq 1 ]] && echo 'SKIPPED (--skip-backup)' || echo "yes, into $N8N_BACKUP_DIR")"
  say "  restart:  $([[ $no_start -eq 1 ]] && echo 'no (--no-start)' || echo 'yes, images pulled then containers recreated')"
  say ""
  confirm "Upgrade n8n ${current:-?} -> $target?" || die "aborted; nothing was changed"

  # Review the installer before taking the (brief-downtime) backup so an
  # abort at review costs nothing.
  fetch_installer
  if (( ! skip_backup )); then
    do_backup "pre-upgrade-${current:-unknown}"
    backup_note="$BACKUP_PATH"
  else
    warn "Skipping the pre-upgrade backup as requested."
  fi

  # The installer only updates .env here. Left to itself it would start the
  # stack with compose.yml alone, briefly running n8n without the override.
  run_installer --upgrade --version "$target" --no-start
  chmod 600 "$N8N_DIR/.env"
  log "upgrade  from=${current:-unset} to=$target backup=$backup_note no_start=$no_start"

  if (( ! no_start )); then
    say "Pulling images and starting n8n $target ..."
    compose pull ||
      die "pulling images failed; n8n/.env now says $target but the old containers are still running. Retry with './n8nctl.sh start'$([[ "$backup_note" != "skipped" ]] && echo ", or roll back with './n8nctl.sh restore $backup_note'")"
    compose up -d >/dev/null
    wait_healthy 180 || warn "n8n did not report healthy in time; check './n8nctl.sh logs n8n'"
    check_runtime || warn "n8n $target is running, but the checks above need attention"
  fi
  ok "Upgraded n8n ${current:-?} -> $target"
  [[ "$backup_note" != "skipped" ]] && say "Rollback: ./n8nctl.sh restore $backup_note"
  return 0
}

cmd_set_key() {
  local key var="$KEY_VAR" provider="" extra="" remove=0 p pv
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --provider) [[ $# -ge 2 ]] || die "--provider needs a value"; provider="$2"; shift ;;
      --provider=*) provider="${1#*=}" ;;
      --var) [[ $# -ge 2 ]] || die "--var needs a value"; extra="$2"; shift ;;
      --var=*) extra="${1#*=}" ;;
      --remove) remove=1 ;;
      *) die "set-key: unknown option '$1'" ;;
    esac
    shift
  done
  require_install
  [[ -n "$provider" && -n "$extra" ]] && die "use either --provider or --var, not both"
  if [[ -n "$provider" ]]; then
    var="$(provider_key_var "$provider")" || die "unknown provider '$provider' (one of: $PROVIDERS)"
  elif [[ -n "$extra" ]]; then
    var="$(extra_secret_var "$extra")" || die "unknown --var '$extra' (one of: daytona brave)"
  fi

  if (( remove )); then
    env_is_set "$var" || { say "$var is not set; nothing to do"; return 0; }
    env_unset "$var"
    ok "Removed $var from $N8N_DIR/.env"
    log "set-key  var=$var action=remove"
  else
    if [[ -t 0 ]]; then
      printf 'API key for %s (input hidden): ' "${provider:-${extra:-the active provider}}"
      IFS= read -rs key
      printf '\n'
    else
      IFS= read -r key || true
    fi
    key="${key%$'\r'}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ -n "$key" ]] || die "no key given"
    [[ "$key" =~ [[:space:]] ]] && die "the key contains whitespace; paste only the key itself"

    env_set "$var" "$key"
    ok "Saved $var to $N8N_DIR/.env (mode 600)"
    log "set-key  var=$var action=set"

    if [[ -n "$provider" ]] && env_is_set "$KEY_VAR"; then
      warn "$KEY_VAR is also set and takes precedence for EVERY provider."
      warn "Run './n8nctl.sh set-key --remove' so per-provider keys apply when you switch models."
    fi
  fi

  if n8n_running; then
    say "Applying to the running stack ..."
    compose up -d >/dev/null
    ok "Applied."
  else
    say "n8n is not running; the change takes effect on './n8nctl.sh start'."
  fi
  if (( ! remove )) && [[ -z "$extra" ]]; then
    say "Keys on file:"
    for p in $PROVIDERS; do
      pv="$(provider_key_var "$p")"
      env_is_set "$pv" && say "  $p ($pv)"
    done
    env_is_set "$KEY_VAR" && say "  generic ($KEY_VAR, overrides the above)"
    say "Active model: $(env_get "$MODEL_VAR" | grep . || echo "$DEFAULT_MODEL (n8n default)")"
    say "Switch with:  ./n8nctl.sh set-model <provider>/<model>"
  fi
  return 0
}

cmd_set_model() {
  local model="" provider pv
  [[ $# -eq 1 ]] || die "usage: set-model <provider>/<model>   e.g. anthropic/claude-opus-4-8, openai/gpt-5.5, openrouter/anthropic/claude-opus-4-8"
  model="$1"
  require_install
  [[ "$model" == */* ]] || die "model must be in provider/model form (one of: $PROVIDERS)"
  provider="${model%%/*}"
  pv="$(provider_key_var "$provider")" || die "unknown provider '$provider' (one of: $PROVIDERS)"
  [[ -n "${model#*/}" ]] || die "missing model name after '$provider/'"

  if env_is_set "$KEY_VAR"; then
    warn "$KEY_VAR is set; it will be used for $provider regardless of $pv."
  elif ! env_is_set "$pv"; then
    warn "no key on file for $provider ($pv). Add one with './n8nctl.sh set-key --provider $provider',"
    warn "unless a provider connection is configured in the n8n UI."
  fi

  env_set "$MODEL_VAR" "$model"
  ok "Set $MODEL_VAR=$model"
  log "set-model  model=$model"
  if n8n_running; then
    say "Applying to the running stack ..."
    compose up -d >/dev/null
    ok "Applied. The Assistant now uses $model."
  else
    say "n8n is not running; the change takes effect on './n8nctl.sh start'."
  fi
}

module_known() { local m; for m in $KNOWN_MODULES; do [[ "$m" == "$1" ]] && return 0; done; return 1; }
module_default() { local m; for m in $DEFAULT_MODULES; do [[ "$m" == "$1" ]] && return 0; done; return 1; }

# Current N8N_ENABLED_MODULES as a space-separated list (may be empty).
modules_list() { env_get "$MODULES_VAR" | tr ',' ' ' | tr -s ' ' | sed 's/^ //; s/ $//'; }

module_listed() { local m; for m in $(modules_list); do [[ "$m" == "$1" ]] && return 0; done; return 1; }

cmd_modules() {
  local action="" name="" cur new m ver
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --enable)  [[ $# -ge 2 ]] || die "--enable needs a module name"; action=enable; name="$2"; shift ;;
      --enable=*)  action=enable; name="${1#*=}" ;;
      --disable) [[ $# -ge 2 ]] || die "--disable needs a module name"; action=disable; name="$2"; shift ;;
      --disable=*) action=disable; name="${1#*=}" ;;
      *) die "modules: unknown option '$1' (use --enable NAME or --disable NAME)" ;;
    esac
    shift
  done
  require_install
  cur="$(modules_list)"

  if [[ -z "$action" ]]; then
    say "$MODULES_VAR: ${cur:-(unset; n8n loads its default modules)}"
    say "Default modules (always on unless listed in N8N_DISABLED_MODULES): $DEFAULT_MODULES"
    say "Opt-in modules: $(for m in $KNOWN_MODULES; do module_default "$m" || printf '%s ' "$m"; done)"
    return 0
  fi
  module_known "$name" || die "unknown module '$name'. n8n refuses to start on unknown names. Known: $KNOWN_MODULES"

  if [[ "$action" == enable ]]; then
    module_listed "$name" && { ok "$name is already in $MODULES_VAR"; return 0; }
    module_default "$name" && warn "$name is a default module; n8n loads it without listing it. Adding it is harmless."
    if [[ "$name" == agents ]]; then
      ver="$(env_get N8N_VERSION)"
      [[ -n "$ver" ]] && version_lt "$ver" "$AGENTS_MIN_VERSION" &&
        warn "Agents need n8n $AGENTS_MIN_VERSION or newer; installed is $ver. Upgrade first."
    fi
    new="${cur:+$cur }$name"
  else
    module_listed "$name" || { say "$name is not in $MODULES_VAR; nothing to do"; return 0; }
    module_default "$name" && warn "$name is a default module; removing it from $MODULES_VAR does NOT turn it off. To disable it, list it in N8N_DISABLED_MODULES in $N8N_DIR/.env."
    new=""
    for m in $cur; do [[ "$m" == "$name" ]] || new="${new:+$new }$m"; done
  fi

  if [[ -z "$new" ]]; then env_unset "$MODULES_VAR"; else env_set "$MODULES_VAR" "$(printf '%s' "$new" | tr ' ' ',')"; fi
  ok "$MODULES_VAR: ${new:-(unset)}"
  log "modules  action=$action module=$name value=${new:-unset}"
  if n8n_running; then
    say "Applying to the running stack ..."
    compose up -d >/dev/null
    ok "Applied."
  else
    say "n8n is not running; the change takes effect on './n8nctl.sh start'."
  fi
}

cmd_status() {
  local ver sandbox mode vol last keys p mods taken age
  say "${C_BOLD}n8nctl $N8NCTL_VERSION${C_RESET}  base: $N8N_BASE_DIR"
  if ! is_installed; then
    say "Install:    none (run './n8nctl.sh install --version X.Y.Z')"
    return 0
  fi
  ver="$(env_get N8N_VERSION)"; sandbox="$(env_get N8N_SANDBOX_VERSION)"
  say "Install:    $N8N_DIR"
  say "n8n:        ${ver:-unset}    sandbox service: ${sandbox:-unset}"
  mode="$(file_mode "$N8N_DIR/.env")"
  if [[ "$mode" == "600" ]]; then say ".env:       mode 600"; else warn ".env mode is $mode, expected 600 (chmod 600 n8n/.env)"; fi
  say "Model:      $(env_get "$MODEL_VAR" | grep . || echo "$DEFAULT_MODEL (n8n default)")"
  keys=""
  for p in $PROVIDERS; do env_is_set "$(provider_key_var "$p")" && keys="$keys $p"; done
  env_is_set "$KEY_VAR" && keys="$keys generic"
  if [[ -n "$keys" ]]; then
    say "Assistant:  keys on file:$keys"
  else
    say "Assistant:  OFF, no model key (run './n8nctl.sh set-key --provider <name>')"
  fi
  if env_is_set "$BRAVE_VAR"; then say "Web search: Brave ($BRAVE_VAR)"; else say "Web search: bundled SearXNG"; fi
  mods="$(modules_list)"
  say "Modules:    ${mods:-(unset; n8n defaults)}"
  if module_listed agents; then
    if [[ -n "$ver" ]] && version_lt "$ver" "$AGENTS_MIN_VERSION"; then
      warn "agents is enabled but needs n8n $AGENTS_MIN_VERSION or newer (installed $ver)"
    else
      say "Agents:     enabled (Preview)"
    fi
  else
    say "Agents:     not in $MODULES_VAR (enable with './n8nctl.sh modules --enable agents')"
  fi
  env_is_set DAYTONA_API_KEY && say "Daytona:    key on file (DAYTONA_API_KEY)"
  [[ -f "$N8N_DIR/compose.override.yml" ]] && say "Override:   compose.override.yml present"
  gitignore_ok || warn ".gitignore is missing n8n/, n8n-backups/, n8nctl.log or exports/"

  if docker info >/dev/null 2>&1; then
    if vol="$(detect_volume 2>/dev/null)"; then say "Volume:     $vol"; else say "Volume:     not created yet"; fi
    say ""
    compose ps 2>/dev/null || true
    say ""
    if n8n_healthy; then
      ok "Healthy: http://localhost:$N8N_PORT/healthz"
    else
      warn "Not answering on http://localhost:$N8N_PORT/healthz"
    fi
    n8n_running && { check_runtime || true; }
  else
    warn "Docker daemon not reachable; container state unknown"
  fi

  last="$(list_backups | tail -n1)"
  if [[ -n "$last" ]]; then
    taken="$(snapshot_epoch "$(basename "$last")")"
    age=""
    [[ -n "$taken" ]] && age=$(( ($(date -u +%s) - taken) / 3600 ))
    say "Last backup: $last (n8n $(manifest_get "$last" n8n_version)${age:+, ${age}h ago})"
    if [[ -n "$age" ]] && (( age >= 26 )); then
      warn "The newest snapshot is $age hours old; the nightly backup may have stopped (see docs/backup-plan.md)"
    fi
  else
    say "Last backup: none"
  fi
}

cmd_start() {
  require_install; check_docker
  say "Starting the stack ..."
  compose up -d
  log "start"
  wait_healthy 180 || warn "n8n did not report healthy in time; check './n8nctl.sh logs n8n'"
  ok "n8n at http://localhost:$N8N_PORT"
}

cmd_stop() {
  require_install; check_docker
  compose down
  log "stop"
  ok "Stopped (data kept in the volume)"
}

cmd_logs() {
  require_install; check_docker
  compose logs -f --tail=200 "$@"
}

cmd_backup() {
  [[ $# -eq 0 ]] || die "backup takes no arguments"
  do_backup manual
}

# Export every workflow as JSON via n8n's own CLI inside the running container.
# Credentials are never exported: without --decrypted they are useless
# elsewhere, and decrypted they are plaintext secrets on disk.
cmd_export() {
  local cid ts dest ctmp n f
  [[ $# -eq 0 ]] || die "export takes no arguments (files go to $N8N_EXPORT_DIR/<timestamp>/)"
  require_install
  check_docker
  cid="$(compose ps -q --status running n8n 2>/dev/null)"
  [[ -n "$cid" ]] || die "n8n is not running; start it first ('./n8nctl.sh start')"

  ts="$(date -u +%Y%m%d-%H%M%S)"
  dest="$N8N_EXPORT_DIR/$ts"
  n=2
  while [[ -e "$dest" ]]; do dest="$N8N_EXPORT_DIR/${ts}_$n"; n=$((n + 1)); done
  ensure_gitignore
  mkdir -p "$dest"
  chmod 700 "$dest"
  ctmp="/tmp/n8nctl-export-$ts"

  say "Exporting workflows from the running container ..."
  docker exec -u node "$cid" n8n export:workflow --all --separate --pretty --output="$ctmp/workflows/" >/dev/null ||
    die "n8n export:workflow failed (see './n8nctl.sh logs n8n')"
  docker exec -u node "$cid" n8n export:workflow --all --pretty --output="$ctmp/all-workflows.json" >/dev/null ||
    die "n8n export:workflow (combined) failed"
  docker cp "$cid:$ctmp/." "$dest/" >/dev/null || die "copying the export out of the container failed"
  docker exec -u node "$cid" rm -rf "$ctmp" >/dev/null 2>&1 || true

  n=0
  for f in "$dest"/workflows/*.json; do [[ -f "$f" ]] && n=$((n + 1)); done
  cat >"$dest/README.txt" <<EOF
n8n workflow export, $(date -u +%Y-%m-%dT%H:%M:%SZ), n8n $(env_get N8N_VERSION)
workflows/          one file per workflow: import these in the n8n UI (Import from File)
all-workflows.json  all workflows in one file: for 'n8n import:workflow --input=...'
Credentials are NOT included. Re-create them on the target instance, then
re-activate each imported workflow after checking its credential fields.
Keep this folder out of git; it can contain webhook paths and hard-coded values.
EOF
  log "export  path=$dest workflows=$n version=$(env_get N8N_VERSION)"
  ok "Exported $n workflow(s) to $dest"
  say "  workflows/*.json      import one at a time in the n8n UI"
  say "  all-workflows.json    for the n8n CLI importer"
}

# Snapshot directories, oldest first. Names are UTC timestamps (plus an
# optional _N suffix), so lexical order is chronological.
list_backups() {
  local d
  for d in "$N8N_BACKUP_DIR"/*/; do
    [[ -f "$d/n8n-data.tar.gz" ]] && printf '%s\n' "${d%/}"
  done
  return 0
}

cmd_backups() {
  local d name keep="" all=() count doomed=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --prune) [[ $# -ge 2 ]] || die "--prune needs a number"; keep="$2"; shift ;;
      --prune=*) keep="${1#*=}" ;;
      *) die "backups: unknown option '$1'" ;;
    esac
    shift
  done
  while IFS= read -r d; do all+=("$d"); done < <(list_backups)
  count=${#all[@]}
  if (( count == 0 )); then
    say "No backups in $N8N_BACKUP_DIR"
    return 0
  fi
  printf '%-18s %-9s %-7s %s\n' "SNAPSHOT" "N8N" "SIZE" "REASON"
  for d in "${all[@]}"; do
    name="$(basename "$d")"
    printf '%-18s %-9s %-7s %s\n' "$name" "$(manifest_get "$d" n8n_version)" "$(dir_size "$d")" "$(manifest_get "$d" reason)"
  done

  if [[ -z "$keep" ]]; then
    say ""
    say "Restore with: ./n8nctl.sh restore $N8N_BACKUP_DIR/<snapshot>"
    say "Prune with:   ./n8nctl.sh backups --prune <keep-newest-N>"
    return 0
  fi
  if ! [[ "$keep" =~ ^[0-9]+$ ]] || (( keep < 1 )); then
    die "--prune needs a whole number of snapshots to keep (at least 1)"
  fi
  if (( count <= keep )); then
    say ""
    ok "Nothing to prune ($count snapshot(s), keeping $keep)"
    return 0
  fi
  doomed=("${all[@]:0:$((count - keep))}")
  say ""
  warn "Pruning ${#doomed[@]} oldest snapshot(s), keeping the newest $keep:"
  for d in "${doomed[@]}"; do say "  $(basename "$d")"; done
  confirm "Delete them?" || die "aborted; nothing was deleted"
  for d in "${doomed[@]}"; do
    case "$d" in "$N8N_BACKUP_DIR"/*) ;; *) die "internal: refusing to delete outside $N8N_BACKUP_DIR: $d" ;; esac
    rm -rf "$d"
    log "prune  path=$d"
  done
  ok "Pruned ${#doomed[@]} snapshot(s)"
}

# Checks a snapshot directory: files, .env mode, tarball sha256 against the
# manifest, versions, and a readable tarball holding database.sqlite.
# Prints a line per check; returns 1 if any failed.
verify_snapshot() {
  local src="$1" fails=0 want got mode entries ver env_ver f

  for f in n8n-data.tar.gz .env compose.yml manifest; do
    if [[ -f "$src/$f" ]]; then ok "$f present"; else warn "$f missing"; fails=1; fi
  done
  [[ -f "$src/searxng-settings.yml" ]] || warn "searxng-settings.yml missing (web search config will be lost on restore)"

  if [[ -f "$src/.env" ]]; then
    mode="$(file_mode "$src/.env")"
    if [[ "$mode" == "600" ]]; then ok ".env mode 600"; else warn ".env mode is $mode (expected 600)"; fi
  fi

  if [[ -f "$src/manifest" && -f "$src/n8n-data.tar.gz" ]]; then
    want="$(manifest_get "$src" data_sha256)"
    got="$(sha256_file "$src/n8n-data.tar.gz")"
    if [[ -n "$want" && "$want" == "$got" ]]; then
      ok "data tarball sha256 matches manifest"
    else
      warn "data tarball sha256 MISMATCH (manifest: ${want:-none}, actual: $got)"; fails=1
    fi
    ver="$(manifest_get "$src" n8n_version)"
    env_ver="$(sed -n 's/^N8N_VERSION=//p' "$src/.env" 2>/dev/null | head -n1)"
    if [[ -n "$env_ver" && "$env_ver" == "$ver" ]]; then
      ok "n8n version $ver consistent between manifest and .env"
    else
      warn "version mismatch: manifest=$ver .env=${env_ver:-unset}"; fails=1
    fi
  fi

  if [[ -f "$src/n8n-data.tar.gz" ]]; then
    if entries="$(tar tzf "$src/n8n-data.tar.gz" 2>/dev/null | grep -c .)"; then
      ok "tarball readable, $entries entries"
      if tar tzf "$src/n8n-data.tar.gz" 2>/dev/null | grep -qE '(^|/)database\.sqlite$'; then
        ok "database.sqlite present in tarball"
      else
        warn "no database.sqlite in tarball"; fails=1
      fi
    else
      warn "tarball is not readable"; fails=1
    fi
  fi

  return "$fails"
}

cmd_verify() {
  local src
  [[ $# -eq 1 ]] || die "usage: verify <backup-dir>"
  src="$1"
  [[ -d "$src" ]] || die "not a directory: $src"
  src="$(cd "$src" && pwd)"
  say "${C_BOLD}Verifying $src${C_RESET}"
  verify_snapshot "$src" || die "verification FAILED for $src"
  ok "Snapshot looks good"
}

cmd_restore() {
  local src="" no_safety=0 vol f safety="none" ver
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-safety-backup) no_safety=1 ;;
      -*) die "restore: unknown option '$1'" ;;
      *) [[ -z "$src" ]] || die "restore takes one backup directory"; src="$1" ;;
    esac
    shift
  done
  [[ -n "$src" ]] || die "usage: restore <backup-dir>   (see './n8nctl.sh backups')"
  [[ -d "$src" ]] || die "not a directory: $src"
  src="$(cd "$src" && pwd)"
  [[ -f "$src/n8n-data.tar.gz" ]] || die "$src has no n8n-data.tar.gz"
  [[ -f "$src/.env" ]] || die "$src has no .env (the encryption key must travel with the data)"
  check_docker
  # Check the snapshot before the plan: a damaged tarball must be found while
  # the live data is still in place.
  say "Checking $src ..."
  verify_snapshot "$src" || die "$src failed verification (see above); nothing was changed"

  ver="$(manifest_get "$src" n8n_version)"
  say ""
  say "${C_BOLD}Restore plan${C_RESET}"
  say "  source:     $src (n8n ${ver:-unknown}, taken $(manifest_get "$src" created))"
  say "  target:     $N8N_DIR + data volume"
  say "  safety:     $([[ $no_safety -eq 1 ]] && echo 'no pre-restore backup (--no-safety-backup)' || echo 'pre-restore backup of the current state first')"
  say ""
  warn "This REPLACES the current data volume and n8n/.env, compose.yml, searxng-settings.yml."
  warn "Everything created since the snapshot is lost."
  confirm "Restore from $src?" || die "aborted; nothing was changed"

  if (( ! no_safety )) && is_installed && detect_volume >/dev/null 2>&1; then
    do_backup "pre-restore"
    safety="$BACKUP_PATH"
  fi

  if is_installed; then
    say "Stopping the stack ..."
    compose down >/dev/null 2>&1 || true
  fi
  mkdir -p "$N8N_DIR"
  for f in compose.yml .env searxng-settings.yml compose.override.yml; do
    [[ -f "$src/$f" ]] && cp -p "$src/$f" "$N8N_DIR/$f"
  done
  chmod 600 "$N8N_DIR/.env"

  # Let compose create the volume (with its labels) and pull the pinned
  # images before anything is wiped.
  say "Preparing containers and volume ..."
  compose up --no-start >/dev/null
  vol="$(detect_volume)" || die "data volume not found after 'compose up --no-start'"

  say "Restoring data into $vol ..."
  docker run --rm \
    -v "$vol:/data" \
    -v "$src:/backup:ro" \
    "$HELPER_IMAGE" sh -c 'find /data -mindepth 1 -delete && tar xzf /backup/n8n-data.tar.gz -C /data' ||
    die "restoring the volume failed; the pre-restore backup is at $safety"

  compose up -d >/dev/null
  log "restore  from=$src version=${ver:-unknown} volume=$vol safety_backup=$safety"
  wait_healthy 180 || warn "n8n did not report healthy in time; check './n8nctl.sh logs n8n'"
  ok "Restored from $src"
  [[ "$safety" != "none" ]] && say "Pre-restore state saved at $safety"
  return 0
}

cmd_uninstall() {
  local skip_backup=0 vol backup_note="none"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --skip-backup) skip_backup=1 ;;
      *) die "uninstall: unknown option '$1'" ;;
    esac
    shift
  done
  is_installed || die "nothing to uninstall in $N8N_DIR"
  check_docker

  warn "This removes the containers, the data volume (workflows, credentials, executions) and $N8N_DIR."
  warn "Existing backups in $N8N_BACKUP_DIR are kept."
  confirm "Uninstall n8n and DELETE all its data?" || die "aborted; nothing was changed"

  if (( ! skip_backup )) && [[ -f "$N8N_DIR/compose.yml" ]] && detect_volume >/dev/null 2>&1; then
    do_backup "pre-uninstall"
    backup_note="$BACKUP_PATH"
  fi

  if [[ -f "$N8N_DIR/compose.yml" ]]; then
    compose down -v --remove-orphans
  fi
  if vol="$(detect_volume 2>/dev/null)"; then
    docker volume rm "$vol" >/dev/null 2>&1 || true
  fi
  rm -rf "$N8N_DIR"
  log "uninstall  dir=$N8N_DIR backup=$backup_note"
  ok "Uninstalled. Backups: $backup_note"
}

cmd_help() {
  cat <<EOF
n8nctl.sh $N8NCTL_VERSION - safe wrapper around n8n's one-line installer

Usage: ./n8nctl.sh [-y|--yes] <command> [options]

Commands
  preflight                      Check Docker, compose v2, curl, port $N8N_PORT, .gitignore
  install --version X.Y.Z        Fresh install, pinned. Add --no-start to only write config
  set-key [--provider P]         Save an Assistant key (hidden prompt, or pipe on stdin).
                                 P = anthropic | openai | openrouter. Without --provider the
                                 generic key is set, which overrides per-provider keys.
                                 --remove deletes the chosen key instead
  set-key --var daytona|brave    Same hidden prompt for DAYTONA_API_KEY / the Brave search key
  set-model <provider>/<model>   Switch the Assistant model; uses that provider's key
  modules [--enable M|--disable M]
                                 Show or edit N8N_ENABLED_MODULES (e.g. --enable agents)
  status                         Versions, key present?, containers, health, last backup
  start | stop | logs [service]  Run the stack / stop it (data kept) / follow logs
  backup                         Snapshot data volume + .env + compose files (brief n8n pause)
  export                         Write every workflow as JSON to exports/<timestamp>/ (no credentials)
  backups [--prune N]            List snapshots; --prune keeps only the newest N
  verify <dir>                   Check a snapshot: files, sha256, versions, tarball
  restore <dir>                  Roll back to a snapshot (takes a pre-restore backup first)
  upgrade --version X.Y.Z        Backup, then upgrade. --skip-backup / --no-start available
  uninstall                      Remove containers, data and ./n8n (backup offered first)
  help                           This text

Global options
  -y, --yes            Answer yes to every prompt (skips installer review)

Environment
  N8N_BASE_DIR         Directory containing ./n8n            (default: \$PWD)
  N8N_BACKUP_DIR       Backup destination                    (default: \$N8N_BASE_DIR/n8n-backups)
  N8N_EXPORT_DIR       Workflow export destination           (default: \$N8N_BASE_DIR/exports)
  N8N_VOLUME           Data volume name                      (default: auto-detect *n8n-data)

Log: n8nctl.log next to the script (installer hashes, installs, upgrades, backups).
Docs: https://docs.n8n.io/deploy/host-n8n/install-options/one-line-setup
EOF
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
main() {
  local args=() cmd
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -y|--yes) ASSUME_YES=1 ;;
      -h|--help) cmd_help; exit 0 ;;
      *) args+=("$1") ;;
    esac
    shift
  done
  set -- ${args[@]+"${args[@]}"}
  cmd="${1:-help}"
  [[ $# -gt 0 ]] && shift

  case "$cmd" in
    preflight) cmd_preflight "$@" ;;
    install)   cmd_install "$@" ;;
    set-key)   cmd_set_key "$@" ;;
    set-model) cmd_set_model "$@" ;;
    modules)   cmd_modules "$@" ;;
    status)    cmd_status "$@" ;;
    start)     cmd_start "$@" ;;
    stop)      cmd_stop "$@" ;;
    logs)      cmd_logs "$@" ;;
    backup)    cmd_backup "$@" ;;
    export)    cmd_export "$@" ;;
    backups)   cmd_backups "$@" ;;
    verify)    cmd_verify "$@" ;;
    restore)   cmd_restore "$@" ;;
    upgrade)   cmd_upgrade "$@" ;;
    uninstall) cmd_uninstall "$@" ;;
    help)      cmd_help ;;
    *) cmd_help >&2; die "unknown command: $cmd" ;;
  esac
}

main "$@"
