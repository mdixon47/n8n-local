#!/usr/bin/env bash
# Offline smoke test for n8nctl.sh. Stub `docker` and `curl` scripts are put
# first on PATH; the upstream installer and compose file are served from
# test/fixtures. Everything happens in a temp base dir. Run: test/smoke.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CTL="$HERE/../n8nctl.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

export STUB_ROOT="$HERE" STUB_STATE="$WORK/state" N8N_BASE_DIR="$WORK/base" NO_COLOR=1
export PATH="$HERE/stubs:$PATH"
mkdir -p "$STUB_STATE/volumes" "$N8N_BASE_DIR"
VOL="$STUB_STATE/volumes/n8n_n8n-data"
ENV="$N8N_BASE_DIR/n8n/.env"

pass=0; fail=0
check() {  # check "label" cmd...  -> expects success
  if "${@:2}" >/dev/null 2>&1; then pass=$((pass+1)); echo "ok   $1"; else fail=$((fail+1)); echo "FAIL $1"; fi
}
check_fails() {  # expects non-zero exit
  if "${@:2}" >/dev/null 2>&1; then fail=$((fail+1)); echo "FAIL $1 (expected failure)"; else pass=$((pass+1)); echo "ok   $1"; fi
}
perm() { ls -ld "$1" | cut -c1-10; }   # portable; avoids stat flag differences

# --- preflight / install ------------------------------------------------------
check       "preflight passes"                       "$CTL" preflight
check_fails "install refuses without -y off a tty"   "$CTL" install --version 2.35.3
check       "install -y"                             "$CTL" -y install --version 2.35.3
check_fails "second install refused"                 "$CTL" -y install --version 2.35.3
check       ".env exists"                            test -f "$ENV"
check       ".env is 600"                            test "$(perm "$ENV")" = "-rw-------"
check       "N8N_VERSION pinned"                     grep -qx 'N8N_VERSION=2.35.3' "$ENV"
check       ".gitignore filled"                      grep -qx 'n8n/' "$N8N_BASE_DIR/.gitignore"
check       "installer hash logged"                  grep -q 'installer_sha256=b4a999179859558f4bdc22305f714675ba142adeaa626c6ffba84f0e11147612' "$N8N_BASE_DIR/n8nctl.log"
check       "status runs"                            "$CTL" status
check       "status shows no key"                    bash -c "\"$CTL\" status | grep -q 'OFF, no model key'"

# --- set-key ------------------------------------------------------------------
check       "set-key from stdin"                     bash -c "printf 'sk-test-ONE\n' | \"$CTL\" set-key"
check       "key written"                            grep -qx 'N8N_INSTANCE_AI_MODEL_API_KEY=sk-test-ONE' "$ENV"
check       "set-key replaces"                       bash -c "printf 'sk-test-TWO\n' | \"$CTL\" set-key && [ \$(grep -c '^N8N_INSTANCE_AI_MODEL_API_KEY=' '$ENV') -eq 1 ] && grep -qx 'N8N_INSTANCE_AI_MODEL_API_KEY=sk-test-TWO' '$ENV'"
check       ".env still 600 after set-key"           test "$(perm "$ENV")" = "-rw-------"
check_fails "set-key rejects empty"                  bash -c "printf '\n' | \"$CTL\" set-key"
check_fails "set-key rejects whitespace"             bash -c "printf 'a b\n' | \"$CTL\" set-key"
check       "status shows key set"                   bash -c "\"$CTL\" status | grep -q 'model key set'"
check       "key never in log"                       bash -c "! grep -q 'sk-test' '$N8N_BASE_DIR/n8nctl.log'"

# --- backup / verify / restore -------------------------------------------------
echo "before" > "$VOL/marker"
check       "backup"                                 "$CTL" backup
check       "n8n restarted after backup"             test -f "$STUB_STATE/running"
B1="$(ls -1d "$N8N_BASE_DIR"/n8n-backups/*/ | head -1)"; B1="${B1%/}"
check       "backup has tarball"                     test -f "$B1/n8n-data.tar.gz"
check       "backup .env is 600"                     test "$(perm "$B1/.env")" = "-rw-------"
check       "backup manifest version"                grep -qx 'n8n_version=2.35.3' "$B1/manifest"
check       "verify passes"                          "$CTL" verify "$B1"
check       "second backup same second gets suffix"  bash -c "\"$CTL\" backup && [ \$(ls -1d '$N8N_BASE_DIR'/n8n-backups/*/ | wc -l) -eq 2 ]"
check       "backups lists two"                      bash -c "\"$CTL\" backups | grep -c '^2026\|^20[0-9][0-9]' | grep -qx 2"
echo "after" > "$VOL/marker"
check       "restore -y"                             "$CTL" -y restore "$B1"
check       "restore put data back"                  test "$(cat "$VOL/marker")" = "before"
check       "restore made a safety backup"           bash -c "grep -q 'reason=pre-restore' '$N8N_BASE_DIR'/n8n-backups/*/manifest"
check_fails "verify catches tampering"               bash -c "cp -R '$B1' '$WORK/tampered' && echo x >> '$WORK/tampered/n8n-data.tar.gz' && \"$CTL\" verify '$WORK/tampered'"

# --- prune --------------------------------------------------------------------
check       "prune keeps newest 1"                   bash -c "\"$CTL\" -y backups --prune 1 && [ \$(ls -1d '$N8N_BASE_DIR'/n8n-backups/*/ | wc -l) -eq 1 ]"
check       "prune nothing to do"                    "$CTL" -y backups --prune 5
check_fails "prune rejects 0"                        "$CTL" -y backups --prune 0
check_fails "prune refuses without -y off a tty"     bash -c "\"$CTL\" backup && \"$CTL\" backups --prune 1"

# --- upgrade ------------------------------------------------------------------
check       "upgrade -y"                             "$CTL" -y upgrade --version 2.36.0
check       "version bumped"                         grep -qx 'N8N_VERSION=2.36.0' "$ENV"
check       "upgrade took a backup"                  bash -c "grep -q 'reason=pre-upgrade-2.35.3' '$N8N_BASE_DIR'/n8n-backups/*/manifest"
check_fails "downgrade refused"                      "$CTL" -y upgrade --version 2.35.0
check_fails "bad version refused"                    "$CTL" -y upgrade --version 2.36
printf 'services:\n  n8n:\n    ports: !override\n      - "127.0.0.1:5678:5678"\n' > "$N8N_BASE_DIR/n8n/compose.override.yml"
check       "upgrade with override, no backup"       "$CTL" -y upgrade --version 2.36.1 --skip-backup
check       "override re-applied after upgrade"      grep -q 'compose.override.yml up -d' "$STUB_STATE/docker.calls"
check       "override included in backup"            bash -c "\"$CTL\" backup && ls -d '$N8N_BASE_DIR'/n8n-backups/*/compose.override.yml"

# --- start / stop / logs / uninstall ------------------------------------------
check       "stop"                                   "$CTL" stop
check       "stopped"                                test ! -f "$STUB_STATE/running"
check       "start"                                  "$CTL" start
check       "logs"                                   "$CTL" logs n8n
check_fails "uninstall refuses without -y off a tty" "$CTL" uninstall
check       "install dir still there"                test -d "$N8N_BASE_DIR/n8n"
check       "uninstall -y"                           "$CTL" -y uninstall
check       "install dir removed"                    test ! -d "$N8N_BASE_DIR/n8n"
check       "volume removed"                         test ! -d "$VOL"
check       "uninstall took a backup"                bash -c "grep -q 'reason=pre-uninstall' '$N8N_BASE_DIR'/n8n-backups/*/manifest"
check       "status after uninstall"                 bash -c "\"$CTL\" status | grep -q 'Install:    none'"
check_fails "unknown command"                        "$CTL" bogus
check       "help"                                   "$CTL" help

echo
echo "passed: $pass  failed: $fail"
(( fail == 0 ))
