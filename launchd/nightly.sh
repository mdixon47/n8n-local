#!/usr/bin/env bash
#
# The nightly job. The n8nctl Backup app (launchd/n8nctl-backup.applescript)
# runs it at 23:00:
#   1. backup, then prune to the newest 14 snapshots; tell when the data
#      grew by more than half since the night before
#   2. only after a good backup: upgrade --patch-only, the newest patch of the
#      installed n8n minor version once it is a day old (n8n restarts for
#      about a minute when there is one)
#   3. check-update, to hear about new minor and major versions, which are
#      upgraded by hand
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

stamp() { date '+%Y-%m-%d %H:%M:%S %Z'; }
notify() { printf 'NOTIFY:%s\n' "$*"; printf '  notify: %s\n' "$*" >>"$LOG"; }

cd "$(dirname "$0")/.." || { notify "Nightly n8n job: project folder not found"; exit 0; }
echo "=== $(stamp) nightly: start" >>"$LOG"

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

echo "=== $(stamp) nightly: done" >>"$LOG"
exit 0
