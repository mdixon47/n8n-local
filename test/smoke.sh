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
# Permission string; avoids GNU/BSD stat flag differences.
# shellcheck disable=SC2012
perm() { ls -ld "$1" | cut -c1-10; }
first_backup() { local d; for d in "$N8N_BASE_DIR"/n8n-backups/*/; do printf '%s\n' "${d%/}"; return; done; }
count_backups() { local d n=0; for d in "$N8N_BASE_DIR"/n8n-backups/*/; do [[ -d "$d" ]] && n=$((n+1)); done; printf '%s\n' "$n"; }

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
check       "status shows generic key"               bash -c "\"$CTL\" status | grep -q 'keys on file: generic'"

# --- per-provider keys and model switching ---------------------------------
check       "set-key --provider openrouter"          bash -c "printf 'sk-or-TEST\n' | \"$CTL\" set-key --provider openrouter"
check       "provider key written"                   grep -qx 'OPENROUTER_API_KEY=sk-or-TEST' "$ENV"
check       "warns generic overrides"                bash -c "printf 'sk-ant-TEST\n' | \"$CTL\" set-key --provider anthropic 2>&1 | grep -q 'takes precedence'"
check_fails "set-key rejects unknown provider"       bash -c "printf 'x\n' | \"$CTL\" set-key --provider foo"
check       "set-key --remove generic"               "$CTL" set-key --remove
check       "generic line gone"                      bash -c "! grep -q '^N8N_INSTANCE_AI_MODEL_API_KEY=' '$ENV'"
check       "provider keys survive remove"           bash -c "grep -qx 'ANTHROPIC_API_KEY=sk-ant-TEST' '$ENV' && grep -qx 'OPENROUTER_API_KEY=sk-or-TEST' '$ENV'"
check       "remove when absent is a no-op"          "$CTL" set-key --remove
check       "status lists provider keys"             bash -c "\"$CTL\" status | grep -q 'keys on file: anthropic openrouter'"
check       "status shows default model"             bash -c "\"$CTL\" status | grep -q 'Model:      anthropic/claude-opus-4-8 (n8n default)'"
check       "set-model openrouter"                   "$CTL" set-model openrouter/anthropic/claude-opus-4-8
check       "model written"                          grep -qx 'N8N_INSTANCE_AI_MODEL=openrouter/anthropic/claude-opus-4-8' "$ENV"
check       "set-model without key warns but works"  bash -c "\"$CTL\" set-model openai/gpt-5.5 2>&1 | grep -q 'no key on file for openai'"
check       "set-model replaces, no duplicate"       bash -c "\"$CTL\" set-model anthropic/claude-opus-4-8 && [ \$(grep -c '^N8N_INSTANCE_AI_MODEL=' '$ENV') -eq 1 ]"
check_fails "set-model rejects bare name"            "$CTL" set-model claude
check_fails "set-model rejects unknown provider"     "$CTL" set-model google/gemini
check_fails "set-model rejects empty model"          "$CTL" set-model anthropic/
check       "set-key --var daytona"                  bash -c "printf 'dtn-TEST\n' | \"$CTL\" set-key --var daytona"
check       "DAYTONA_API_KEY written"                grep -qx 'DAYTONA_API_KEY=dtn-TEST' "$ENV"
check       "set-key --var brave"                    bash -c "printf 'BSA-TEST\n' | \"$CTL\" set-key --var brave"
check       "brave key written (no N8N_ prefix)"     grep -qx 'INSTANCE_AI_BRAVE_SEARCH_API_KEY=BSA-TEST' "$ENV"
check_fails "set-key rejects unknown --var"          bash -c "printf 'x\n' | \"$CTL\" set-key --var foo"
check_fails "set-key rejects --var with --provider"  bash -c "printf 'x\n' | \"$CTL\" set-key --var brave --provider openai"
check       "set-key --var daytona --remove"         "$CTL" set-key --var daytona --remove
check       "DAYTONA_API_KEY gone"                   bash -c "! grep -q '^DAYTONA_API_KEY=' '$ENV'"
check       "status shows Brave"                     bash -c "\"$CTL\" status | grep -q 'Web search: Brave'"
check       ".env still 600"                         test "$(perm "$ENV")" = "-rw-------"
check       "no key value in log"                    bash -c "! grep -qE 'sk-(test|or|ant)|dtn-|BSA-' '$N8N_BASE_DIR/n8nctl.log'"

# --- modules ------------------------------------------------------------------
check       "modules shows unset"                    bash -c "\"$CTL\" modules | grep -q 'N8N_ENABLED_MODULES: (unset'"
check       "status: agents not enabled"             bash -c "\"$CTL\" status | grep -q 'Agents:     not in N8N_ENABLED_MODULES'"
check       "modules --enable agents"                "$CTL" modules --enable agents
check       "N8N_ENABLED_MODULES=agents"             grep -qx 'N8N_ENABLED_MODULES=agents' "$ENV"
check       "enable again is a no-op"                bash -c "\"$CTL\" modules --enable agents && grep -qx 'N8N_ENABLED_MODULES=agents' '$ENV'"
check       "modules --enable instance-ai appends"   bash -c "\"$CTL\" modules --enable instance-ai && grep -qx 'N8N_ENABLED_MODULES=agents,instance-ai' '$ENV'"
check       "status: agents enabled"                 bash -c "\"$CTL\" status | grep -q 'Agents:     enabled'"
check       "status: Modules line"                   bash -c "\"$CTL\" status | grep -q 'Modules:    agents instance-ai'"
check_fails "modules rejects unknown name"           "$CTL" modules --enable bogus-module
check       "enable default module warns"           bash -c "\"$CTL\" modules --enable insights 2>&1 | grep -q 'default module'"
check       "disable default module warns, edits"    bash -c "\"$CTL\" modules --disable instance-ai 2>&1 | grep -q 'does NOT turn it off' && grep -qx 'N8N_ENABLED_MODULES=agents,insights' '$ENV'"
check       "disable insights"                       bash -c "\"$CTL\" modules --disable insights && grep -qx 'N8N_ENABLED_MODULES=agents' '$ENV'"
check       "modules lists opt-in and default"       bash -c "\"$CTL\" modules | grep -q 'Opt-in modules: agents' && \"$CTL\" modules | grep -q 'Default modules'"
check       "disable agents removes the line"        bash -c "\"$CTL\" modules --disable agents && ! grep -q '^N8N_ENABLED_MODULES=' '$ENV'"
check       "disable absent is a no-op"              "$CTL" modules --disable agents
check       "modules logged, no values leaked"       bash -c "grep -q 'modules  action=enable module=agents' '$N8N_BASE_DIR/n8nctl.log'"

# --- backup / verify / restore -------------------------------------------------
echo "before" > "$VOL/marker"
check       "backup"                                 "$CTL" backup
check       "n8n restarted after backup"             test -f "$STUB_STATE/running"
B1="$(first_backup)"
check       "backup has tarball"                     test -f "$B1/n8n-data.tar.gz"
check       "backup .env is 600"                     test "$(perm "$B1/.env")" = "-rw-------"
check       "backup manifest version"                grep -qx 'n8n_version=2.35.3' "$B1/manifest"
check       "verify passes"                          "$CTL" verify "$B1"
check       "second backup creates a new snapshot"    bash -c "\"$CTL\" backup" && check "two snapshots exist" test "$(count_backups)" -eq 2
check       "backups lists two"                      bash -c "[ \$(\"$CTL\" backups | grep -cE '^[0-9]{8}-[0-9]{6}') -eq 2 ]"
echo "after" > "$VOL/marker"
check       "restore -y"                             "$CTL" -y restore "$B1"
check       "restore put data back"                  test "$(cat "$VOL/marker")" = "before"
check       "restore made a safety backup"           bash -c "grep -q 'reason=pre-restore' '$N8N_BASE_DIR'/n8n-backups/*/manifest"
check_fails "verify catches tampering"               bash -c "cp -R '$B1' '$WORK/tampered' && echo x >> '$WORK/tampered/n8n-data.tar.gz' && \"$CTL\" verify '$WORK/tampered'"
echo "live" > "$VOL/marker"; nb="$(count_backups)"
check_fails "restore refuses a damaged snapshot"     "$CTL" -y restore "$WORK/tampered"
check       "damaged restore left data alone"        test "$(cat "$VOL/marker")" = "live"
check       "damaged restore took no backup first"   test "$(count_backups)" -eq "$nb"
check       "manifest records the helper image"      grep -q '^helper_image=alpine:3\.[0-9.]*@sha256:' "$B1/manifest"

# --- export -------------------------------------------------------------------
check       "export"                                 "$CTL" export
X=""; for d in "$N8N_BASE_DIR"/exports/*/; do X="${d%/}"; break; done
nx=0; for f in "$X"/workflows/*.json; do [[ -f "$f" ]] && nx=$((nx+1)); done
check       "export: per-workflow files"             test "$nx" -eq 2
check       "export: combined file"                  test -s "$X/all-workflows.json"
check       "export: README present"                 grep -q 'Credentials are NOT included' "$X/README.txt"
check       "export: dir is 700"                     test "$(perm "$X")" = "drwx------"
check       "export: gitignore gained exports/"      grep -qx 'exports/' "$N8N_BASE_DIR/.gitignore"
check       "export: logged with count"              grep -q 'export  path=.* workflows=2' "$N8N_BASE_DIR/n8nctl.log"
check       "export: container temp cleaned"         bash -c "! ls -d '$STUB_STATE'/container/tmp/n8nctl-export-* 2>/dev/null | grep -q ."
check_fails "export rejects arguments"               "$CTL" export --foo
"$CTL" stop >/dev/null
check_fails "export needs n8n running"               "$CTL" export
"$CTL" start >/dev/null

# --- prune --------------------------------------------------------------------
check       "prune keeps newest 1"                   "$CTL" -y backups --prune 1
check       "one snapshot left"                      test "$(count_backups)" -eq 1
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
check       "upgrade never lets the installer start"  bash -c "\"$CTL\" -y upgrade --version 2.36.2 --skip-backup | grep -q 'Not restarting (--no-start)'"
check       "upgrade pulls, then starts with override" bash -c "grep -q 'compose.override.yml pull' '$STUB_STATE/docker.calls'"
check       "upgrade --no-start leaves it stopped"   bash -c "\"$CTL\" stop && \"$CTL\" -y upgrade --version 2.36.3 --skip-backup --no-start && [ ! -f '$STUB_STATE/running' ]"
"$CTL" start >/dev/null

# --- runtime checks (status / upgrade) ----------------------------------------
printf 'services:\n  n8n:\n    environment:\n      NODE_OPTIONS: --require=/opt/n8n-local/force-http1.cjs\n' > "$N8N_BASE_DIR/n8n/compose.override.yml"
printf '/opt/n8n-local\n' > "$STUB_STATE/mounts"
check       "status: preload missing is flagged"     bash -c "\"$CTL\" status 2>&1 | grep -q 'Preload: no \[n8n-local\] line'"
echo "[n8n-local] fetch uses HTTP/1.1 (undici 8.9.0 dispatcher)" > "$STUB_STATE/n8n.log"
check       "status: preload confirmed"              bash -c "\"$CTL\" status | grep -q 'Preload: fetch uses HTTP/1.1'"
check       "status: bind mounts readable"           bash -c "\"$CTL\" status | grep -q 'Bind mounts: all 1 readable'"
printf '/opt/n8n-local\n' > "$STUB_STATE/dead"
check       "status: dead bind mount flagged"        bash -c "\"$CTL\" status 2>&1 | grep -q 'bind mount /opt/n8n-local is not readable'"
check       "upgrade reports a dead bind mount"      bash -c "\"$CTL\" -y upgrade --version 2.36.4 --skip-backup 2>&1 | grep -q 'checks above need attention'"
rm -f "$STUB_STATE/dead"
echo unhealthy > "$STUB_STATE/health"
check       "status: failing health check flagged"   bash -c "\"$CTL\" status 2>&1 | grep -q 'health check: unhealthy'"
rm -f "$STUB_STATE/health"
check       "status: backup age shown"               bash -c "\"$CTL\" status | grep -qE 'Last backup: .*, [0-9]+h ago\)'"
mkdir -p "$WORK/oldb/20200101-000000" && : > "$WORK/oldb/20200101-000000/n8n-data.tar.gz"
check       "status: stale backup flagged"           bash -c "N8N_BACKUP_DIR='$WORK/oldb' \"$CTL\" status 2>&1 | grep -q 'nightly backup may have stopped'"

# --- update check --------------------------------------------------------------
# installed: 2.36.4 (from the runtime checks above); fixture: stable 2.37.2, beta 2.38.0, 1.123.99 published later
check       "patch-only waits for a day-old patch"   bash -c "N8NCTL_PATCH_SOAK_DAYS=100000 \"$CTL\" -y upgrade --patch-only 2>&1 | grep -q 'No patch upgrade to install' && grep -qx 'N8N_VERSION=2.36.4' '$ENV'"
sed '2i\
# changed' "$HERE/fixtures/get-n8n.sh" > "$WORK/changed-installer.sh"
check       "patch-only refuses a changed installer" bash -c "out=\$(STUB_INSTALLER='$WORK/changed-installer.sh' \"$CTL\" -y upgrade --patch-only 2>&1); [ \$? -ne 0 ] && grep -q 'installer is new or changed' <<<\"\$out\""
check       "refused upgrade changed nothing"        grep -qx 'N8N_VERSION=2.36.4' "$ENV"
printf '/opt/n8n-local\n' > "$STUB_STATE/dead"
check       "patch-only: exit 4 when checks fail"    bash -c "\"$CTL\" -y upgrade --patch-only >/dev/null 2>&1; [ \$? -eq 4 ]"
rm -f "$STUB_STATE/dead"
check       "patch-only took the 2.36 patch only"    grep -qx 'N8N_VERSION=2.36.9' "$ENV"
check       "patch-only logged"                      grep -q 'upgrade  from=2.36.4 to=2.36.9 .*patch_only=1' "$N8N_BASE_DIR/n8nctl.log"
check       "patch-only: nothing newer, exit 0"      bash -c "\"$CTL\" -y upgrade --patch-only | grep -q 'newest patch of 2.36'"
check       "check-update exits 3 when behind"       bash -c "\"$CTL\" check-update >/dev/null 2>&1; [ \$? -eq 3 ]"
check       "check-update finds stable 2.37.2"       bash -c "\"$CTL\" check-update 2>&1 | grep -q 'Latest stable:  2.37.2'"
check       "check-update calls it a minor update"   bash -c "\"$CTL\" check-update 2>&1 | grep -q 'new minor version is out: 2.37.2'"
check       "check-update shows the beta apart"      bash -c "\"$CTL\" check-update 2>&1 | grep -q 'Beta:           2.38.0'"
check       "check-update ignores 1.x and betas"     bash -c "! \"$CTL\" check-update 2>&1 | grep -qE 'Latest stable:  (1\.123|2\.38)'"
check       "check-update logged"                    grep -q 'update-check  current=2.36.9 stable=2.37.2 beta=2.38.0 status=minor' "$N8N_BASE_DIR/n8nctl.log"
check       "status shows the update"                bash -c "\"$CTL\" status 2>&1 | grep -q 'Update:     n8n 2.37.2 is available'"
check       "upgrade without --version: stable"      bash -c "\"$CTL\" -y upgrade --skip-backup && grep -qx 'N8N_VERSION=2.37.2' '$ENV'"
check       "check-update up to date, exit 0"        bash -c "\"$CTL\" check-update | grep -q 'Up to date'"
check       "status: up to date"                     bash -c "\"$CTL\" status | grep -q 'Update:     up to date with stable 2.37.2'"
printf '2020-01-01T00:00:00Z  update-check  current=2.37.2 stable=2.37.2 beta=none status=current\n' >> "$N8N_BASE_DIR/n8nctl.log"
check       "status: stale check flagged"            bash -c "\"$CTL\" status 2>&1 | grep -q 'last check was [0-9]* days ago'"
check       "check-update: major version noticed"    bash -c "STUB_RELEASES=github-releases-major.json \"$CTL\" check-update 2>&1 | grep -q 'n8n 3 is out (3.0.1)'"
check_fails "upgrade refuses an unasked major jump"  env STUB_RELEASES=github-releases-major.json "$CTL" -y upgrade --skip-backup
check       "major jump left the version alone"      grep -qx 'N8N_VERSION=2.37.2' "$ENV"

# --- nightly job (launchd/nightly.sh) -------------------------------------------
NIGHTLY="$HERE/../launchd/nightly.sh"
export N8NCTL_NIGHTLY_LOG="$WORK/nightly.log" N8NCTL_NIGHTLY_STATE="$WORK/nightly-state"
check       "nightly: up to date, no notification"   bash -c "out=\$(\"$NIGHTLY\") && [ -z \"\$out\" ] && grep -q 'nightly: done' '$WORK/nightly.log'"
check       "nightly: backed up"                     grep -q 'Backup written to' "$WORK/nightly.log"
check       "nightly: tells about a new major once"  bash -c "STUB_RELEASES=github-releases-major.json \"$NIGHTLY\" | grep -q '^NOTIFY:n8n 3.0.1 is available'"
check       "nightly: does not repeat it"            bash -c "out=\$(STUB_RELEASES=github-releases-major.json \"$NIGHTLY\") && ! grep -q 3.0.1 <<<\"\$out\""
mkdir -p "$WORK/ro" && chmod 500 "$WORK/ro"
check       "nightly: failed backup is reported"     bash -c "N8N_BACKUP_DIR='$WORK/ro/b' \"$NIGHTLY\" | grep -q '^NOTIFY:n8n backup failed'"
check       "nightly: no upgrade after a bad backup" bash -c "! N8N_BACKUP_DIR='$WORK/ro/b' \"$NIGHTLY\" | grep -q 'patch upgrade'"
chmod 700 "$WORK/ro"

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
