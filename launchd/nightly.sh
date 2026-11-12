#!/usr/bin/env bash
#
# The nightly job. The n8nctl Backup app (launchd/n8nctl-backup.applescript)
# runs it at 23:00:
#   0. when Docker is not running: start Docker Desktop, wait for it, start
#      the stack (one notification and nothing else if Docker never comes up)
#   1. backup, then prune to the newest 14 snapshots; tell when the data
#      grew by more than half since the night before
#   2. only after a good backup: upgrade --patch-only, the newest patch of the
#      installed n8n minor version once it is a day old (n8n restarts for
#      about a minute when there is one)
#   3. check-update, to hear about new minor and major versions, which are
#      upgraded by hand
#   4. save the pinned AI Assistant chats as Markdown in chats/ (one file per
#      chat, replaced each night), so each has a copy outside the database;
#      then, only after a good backup, delete the unpinned chats idle for more
#      than CHAT_IDLE_DAYS days (that night's snapshot still holds them)
#   5. tell when a trigger kept failing in the last 24 hours: a failing poll
#      (an expired Gmail credential, say) records no execution, so nothing
#      else shows it
# Everything goes to ~/Library/Logs/n8nctl-backup.log. Lines on stdout that
# start with "NOTIFY:" are shown by the app as macOS notifications. Always
# exits 0: outcomes travel as notifications, not exit codes.
#
# Changing this file changes what runs every night, without rebuilding the app.
set -uo pipefail

# The app starts with a minimal PATH; docker lives in /usr/local/bin.
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin" NO_COLOR=1
LOG="${N8NCTL_NIGHTLY_LOG:-$HOME/Library/Logs/n8nctl-backup.log}"
STATE="${N8NCTL_NIGHTLY_STATE:-$HOME/Library/Application Support/n8nctl}"
CHAT_IDLE_DAYS=10

stamp() { date '+%Y-%m-%d %H:%M:%S %Z'; }
notify() { printf 'NOTIFY:%s\n' "$*"; printf '  notify: %s\n' "$*" >>"$LOG"; }

cd "$(dirname "$0")/.." || { notify "Nightly n8n job: project folder not found"; exit 0; }
echo "=== $(stamp) nightly: start" >>"$LOG"

# 0. Docker. Docker Desktop is sometimes not running at 23:00 (quit, or not
#    started after a reboot), and every step below needs it. Start it, wait
#    for the daemon, then start the stack: no service has a restart policy, so
#    Docker alone does not bring n8n back. Only when this job had to start
#    Docker; a stack stopped on purpose with Docker running stays stopped.
#    N8NCTL_DOCKER_START (one command) and N8NCTL_DOCKER_WAIT are for tests.
docker_up() { docker info >/dev/null 2>&1; }
if ! docker_up; then
  wait_max="${N8NCTL_DOCKER_WAIT:-180}" waited=0
  echo "Docker is not running; starting Docker Desktop" >>"$LOG"
  if [[ -n "${N8NCTL_DOCKER_START:-}" ]]; then "$N8NCTL_DOCKER_START"; else open -g -a Docker; fi >>"$LOG" 2>&1
  while ! docker_up && (( waited < wait_max )); do sleep 5; waited=$((waited + 5)); done
  if ! docker_up; then
    notify "Nightly n8n job skipped: Docker Desktop did not start within ${wait_max}s. Start Docker, then ./n8nctl.sh start and ./n8nctl.sh backup"
    echo "=== $(stamp) nightly: done (no Docker)" >>"$LOG"
    exit 0
  fi
  echo "Docker is up after ${waited}s; starting the stack" >>"$LOG"
  ./n8nctl.sh start >>"$LOG" 2>&1 ||
    notify "Docker Desktop was started, but n8n did not start. Run ./n8nctl.sh status"
fi

# 1. backup
out="$(./n8nctl.sh -y backup 2>&1)"
rc=$?
printf '%s\n' "$out" >>"$LOG"
if (( rc == 0 )) && ./n8nctl.sh -y backups --prune 14 >>"$LOG" 2>&1; then
  backup_ok=1
  grep -q 'data grew by more than half' <<<"$out" &&
    notify "The n8n backup grew by more than half since the last one. Check stored executions (docs/backup-plan.md)"
else
  backup_ok=0
  notify "n8n backup failed. Details in ~/Library/Logs/n8nctl-backup.log"
fi

# 2. patch upgrade (it takes its own pre-upgrade snapshot too)
if (( backup_ok )); then
  out="$(./n8nctl.sh -y upgrade --patch-only 2>&1)"
  rc=$?
  printf '%s\n' "$out" >>"$LOG"
  case "$rc" in
    0) up="$(grep -o 'Upgraded n8n [0-9.]* -> [0-9.]*' <<<"$out" | head -n1)"
       [[ -n "$up" ]] && notify "$up (automatic patch upgrade)" ;;
    4) notify "n8n was upgraded, but the checks after it failed. Run ./n8nctl.sh status" ;;
    *) notify "The automatic n8n patch upgrade did not run (exit $rc). Details in the log" ;;
  esac
fi

# 3. new minor or major versions: one notification per version
out="$(./n8nctl.sh check-update 2>&1)"
rc=$?
printf '%s\n' "$out" >>"$LOG"
if (( rc == 3 )) && ! grep -q 'patch release(s) behind' <<<"$out"; then
  latest="$(sed -n 's/^Latest stable:  \([0-9][0-9.]*\).*/\1/p' <<<"$out")"
  mkdir -p "$STATE"
  if [[ -n "$latest" && "$(cat "$STATE/notified" 2>/dev/null)" != "$latest" ]]; then
    notify "n8n $latest is available. Read the release notes, then ./n8nctl.sh upgrade --version $latest"
    printf '%s\n' "$latest" >"$STATE/notified"
  fi
fi

# 4. pinned Assistant chats -> chats/ (n8n must be up; quiet unless it fails)
if ! ./n8nctl.sh chats save --pinned >>"$LOG" 2>&1; then
  notify "Saving the pinned n8n Assistant chats failed. Details in the log"
fi
# Unpinned chats idle too long. The list it prints (chat titles) stays out of
# the log; n8nctl.log keeps the ids.
if (( backup_ok )); then
  out="$(./n8nctl.sh -y chats prune --days "$CHAT_IDLE_DAYS" 2>&1)"
  rc=$?
  grep -v '^     [0-9]\|LAST ACTIVE' <<<"$out" >>"$LOG"
  if (( rc != 0 )); then
    notify "Deleting old n8n Assistant chats failed. Details in the log"
  else
    gone="$(grep -o 'Deleted [0-9]* unpinned chat(s)' <<<"$out" | grep -o '[0-9]*')"
    [[ -n "$gone" ]] && notify "Deleted $gone unpinned n8n Assistant chat(s) idle for more than $CHAT_IDLE_DAYS days. Pin a chat to keep it"
  fi
fi

# 5. failing triggers (from n8n's log, via status)
out="$(./n8nctl.sh status 2>&1)"
if grep -q 'Triggers failing' <<<"$out"; then
  printf '%s\n' "$out" | grep -A20 'Triggers failing' | grep '^! ' >>"$LOG"
  notify "An n8n trigger kept failing today, often an expired credential. Run ./n8nctl.sh status"
fi

echo "=== $(stamp) nightly: done" >>"$LOG"
exit 0
