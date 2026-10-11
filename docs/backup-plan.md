# Backup plan

How this n8n install is backed up, how to check that backups are working,
and how to get data back. Agreed 2026-10-09. Commands run from the project
folder. Background on the commands is in [learn.md](learn.md) section 10.

## At a glance

| | |
| --- | --- |
| Schedule | Every night at 23:00 local time (follows daylight saving), first run 2026-10-09 |
| Also taken | Automatically before every `upgrade`, `restore` and `uninstall`; by hand before risky changes |
| Kept | The newest 14 snapshots, of any kind |
| Where | `n8n-backups/` on the Seagate USB drive; one copy |
| Most work you can lose | About one day (everything since the last 23:00 run) |
| Time to restore | A few minutes for the whole instance |
| Runs as | LaunchAgent `com.n8nctl.backup`, which opens `~/Applications/n8nctl Backup.app`; log in `~/Library/Logs/n8nctl-backup.log` |

## What a snapshot holds

Each snapshot is a folder `n8n-backups/<YYYYMMDD-HHMMSS>/` (mode 700):

| File | Contents |
| --- | --- |
| `n8n-data.tar.gz` | The whole Docker data volume: the SQLite database (workflows, credentials, executions, users, tags), the encryption key, uploaded files |
| `.env` | Versions, generated secrets, the model API key. Needed to decrypt the credentials in the database |
| `compose.yml`, `compose.override.yml`, `searxng-settings.yml` | The stack's configuration, including LAN access and the gallery service |
| `manifest` | n8n version, volume name, reason, and the tarball's sha256 |

n8n is paused for a few seconds while the volume is archived, so the SQLite
file is copied in a consistent state.

**Not in a snapshot, and why that is fine:**

- The wrapper, docs and gallery code: in git, pushed to the private GitHub
  repo `mdixon47/n8n-local`.
- `templates-api/data/`: rebuilt from the database with
  `python3 -I templates-api/build.py`.
- `exports/`: copies made from the database on demand.
- Docker images: pulled again from the versions pinned in `.env`.

## Schedule and retention

The LaunchAgent opens the *n8nctl Backup* app, which runs
`./n8nctl.sh -y backup`, then `./n8nctl.sh -y backups --prune 14`, and
writes start, output and exit status to the log. Why an app: see "The
backup app" below.

- **Pruning counts every snapshot** directly inside `n8n-backups/`:
  nightly, manual, pre-upgrade, pre-restore. Taking extra manual
  snapshots shortens how many days back you can go.
- **Pre-upgrade snapshots rotate out too**, 14 snapshots later. That
  snapshot is the only way to undo an upgrade (migrations are one-way). To
  keep one longer, move it out of the pruned folder:
  `mv n8n-backups/<timestamp> ~/n8n-backups-keep/`. Anything outside
  `n8n-backups/` is never pruned.
- **Disk use:** about 41 MB per snapshot today, so about 600 MB for 14. The
  drive has over 7 TB free. Size grows with stored executions; learn.md
  section 13 covers execution pruning.

**When a run is skipped:** since 2026-10-11 the Mac does not sleep on AC
power (`pmset -c sleep 0`), so the job normally runs on time. If the Mac is
asleep at 23:00 (on UPS power), macOS runs the job when it wakes. If the Mac is off, or the Seagate drive is unplugged, or
Docker is not running, that night has no backup. The next night's run is
not affected.

## What this plan does not cover

These are known gaps, accepted on 2026-10-09:

- **One copy.** The snapshots and the project live on the same Seagate
  drive. If that drive fails, the backups go with it. n8n's live data is on
  the internal SSD (inside Docker's disk image), so one disk failing loses
  either the live data or the backups, not both.
- **Fire, theft, power surge.** Both disks are in the same place.
- **Mistakes noticed after 14 snapshots.** Older states are gone.
- **The backup app can read the Seagate drive.** It was allowed access to
  removable volumes. It runs only the two commands above, but anyone who can
  edit `launchd/n8nctl-backup.applescript` and rebuild it controls what runs.

The cheapest fixes, when wanted: copy the newest snapshot to a second disk
each week, or to cloud storage as an encrypted archive. Never copy snapshots
anywhere unencrypted: each one contains the encryption key and API keys.

## Checks

| How often | Check | Healthy result |
| --- | --- | --- |
| Weekly | `./n8nctl.sh backups` | A snapshot from last night, reason `manual` |
| Weekly | `tail -20 ~/Library/Logs/n8nctl-backup.log` | `+ Backup written to ...`, a prune line, and `n8nctl Backup app: exit 0` |
| Monthly | `./n8nctl.sh verify n8n-backups/<newest>` | `+ Snapshot looks good` |
| Every 3 months | The restore drill in learn.md section 10 | The deleted test workflow comes back |

`./n8nctl.sh status` also prints `Last backup:` with its n8n version, so a
stale date is visible there too.

`launchctl print gui/$(id -u)/com.n8nctl.backup` reports `last exit code = 0`
whenever the app opened, even if the backup inside it failed. The app's own
`exit` line in the log is the one that counts.

**If the job fails,** the reason is in the log:

| Log says | Cause | Fix |
| --- | --- | --- |
| `Operation not permitted` | The app's access to the drive was refused, revoked, or reset by rebuilding the app | Run the job by hand (below) and click **Allow**; or System Settings, Privacy & Security, Files and Folders, *n8nctl Backup*, Removable Volumes on |
| `the Docker daemon is not running` | Docker Desktop not running | Start Docker Desktop; enable "Start Docker Desktop when you sign in" |
| No log line at all, `spawn failed` | The log path or drive was unavailable | Check that the Seagate drive is mounted |

## Getting data back

**The whole instance** (everything since the snapshot is replaced):

```bash
./n8nctl.sh backups                         # pick a snapshot
./n8nctl.sh restore n8n-backups/<timestamp>
python3 -I templates-api/build.py           # rebuild the gallery afterwards
```

`restore` takes a `pre-restore` snapshot first, so a restore can itself be
undone. Restoring a snapshot from an older n8n version also brings back
that version; see learn.md section 11.

**One workflow** (everything else stays as it is). This is how *Discord AI
bot* and *Gmail Inbox Triage - Error Handler* were recovered on 2026-10-09:

1. `./n8nctl.sh backup` as an undo point.
2. Unpack the snapshot's `n8n-data.tar.gz` into a private temporary folder
   (`mkdir -m 700`) outside the project.
3. Read the workflow's row from `database.sqlite` (table `workflow_entity`)
   and write it as JSON with `id`, `name`, `nodes`, `connections`,
   `settings`, `staticData`, `pinData`, `meta`. Keeping the original `id`
   keeps links to it working, such as another workflow's error-workflow
   setting.
4. Copy the file into the container and run
   `docker exec -u node n8n-n8n-1 n8n import:workflow --input=/tmp/<file>`.
   It arrives switched off.
5. Switch it on if it was on before:
   `docker exec -u node n8n-n8n-1 n8n publish:workflow --id=<id>`, then
   restart n8n. **Error workflows must be active in n8n 2.42**, or n8n logs
   `is not active and cannot be executed` and skips them.
6. Delete the temporary folder: it holds a full copy of the database.

The credentials a workflow uses must still exist; they are stored
separately and are not part of the workflow's row.

## The backup app

macOS refuses processes started by launchd access to an external drive
unless they have been allowed, and a plain `/bin/bash` job has no way to
ask (exit 126, `Operation not permitted`; an attempt to add `/bin/bash` to
Full Disk Access never registered on this Mac). An app can ask, once. So the LaunchAgent
runs `/usr/bin/open -W -g` on a small AppleScript app that does the work.

- Source: `launchd/n8nctl-backup.applescript` (in git).
- Installed: `~/Applications/n8nctl Backup.app`, bundle id
  `local.n8nctl.backup`, ad-hoc signed, hidden from the Dock.
- It never shows a dialog. Errors are written to the log, so an unattended
  run cannot hang waiting for a click.

Rebuild after changing the source. The signature changes with every build,
so macOS asks for permission again on the next run; run it once by hand and
click **Allow**:

```bash
APP="$HOME/Applications/n8nctl Backup.app"
rm -rf "$APP" && osacompile -o "$APP" launchd/n8nctl-backup.applescript
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string local.n8nctl.backup" \
  -c "Add :LSUIElement bool true" "$APP/Contents/Info.plist"
codesign --force --deep -s - "$APP"
launchctl kickstart -k gui/$(id -u)/com.n8nctl.backup     # then click Allow
```

## Changing the plan

The schedule lives in two places that must match: the template
`launchd/com.n8nctl.backup.plist` (in git) and the installed copy in
`~/Library/LaunchAgents/`. After editing the template:

```bash
launchctl bootout gui/$(id -u)/com.n8nctl.backup
cp launchd/com.n8nctl.backup.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.n8nctl.backup.plist
launchctl kickstart -k gui/$(id -u)/com.n8nctl.backup     # run once now to test
```

Then update the table at the top of this file.

## History

- **2026-10-09.** Plan written. Found that the original 03:30 job had never
  run (its log was on the external drive, which macOS blocked). Moved the
  log to `~/Library/Logs/`, changed the time to 23:00, kept 14 snapshots,
  one copy. Full Disk Access for `/bin/bash` was tried first and did not
  take; replaced by the *n8nctl Backup* app, allowed once. First successful
  run: 17:27 EDT, snapshot `20261009-212726`.
