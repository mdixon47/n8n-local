# Improvements

Changes that would make this install safer or easier to run. None of them
is broken today; [issues.md](issues.md) has the things that are. Written
2026-10-12 against n8n 2.42.6; updated the same day for n8nctl 1.5.0.

Already tracked in issues.md and not repeated here: the stale module list
(item 4), stale version numbers (item 5), a template import command
(item 7), and plain HTTP on the home network (item 10).

When an item is done, delete it here and mention it in the commit message.

## Summary

| # | Improvement | Why | Effort |
| --- | --- | --- | --- |
| 1 | Keep a second, encrypted copy of the backups | All snapshots are on one USB drive | 30 min |
| 2 | Get told when something fails | Failures were found by hand, after the fact | 30 min |
| 3 | Move the project to the internal disk | Removes the dead-bind-mount risk | 1 h |
| 4 | Store less per run of the Gmail auto-labeller | It is 90% of the backup's growth | 10 min |

Done on 2026-10-12 (n8nctl 1.5.0): `restore` verifies the snapshot first;
`upgrade` never lets the installer start n8n and checks the result; `status`
checks container health, bind mounts, the preload and backup age; the
network check is `test/netcheck.js`; the gallery sends CORS headers only to
the editor; the helper image is pinned; CI parses the preload, the network
check and the gallery code.

Done on 2026-10-15 (n8nctl 1.6.1): `GENERIC_TIMEZONE=America/New_York` is
set in `.env`; `backup` prints the data size and the change since the
previous snapshot, records `data_bytes` in the manifest, and warns when it
grew by more than half; the nightly job turns that warning into a
notification.

## 1. A second, encrypted copy of the backups

**What:** the project and all 14 snapshots are on the Seagate drive
([backup-plan.md](backup-plan.md), "One copy"). If the drive fails or is
lost, every backup goes with it. Each snapshot holds the encryption key and
the API keys, so a copy must be encrypted.

**Fix:** once a week, copy the newest snapshot into an encrypted disk image
on the internal disk or in cloud storage, for example with
`hdiutil create -encryption AES-256` and a password kept in the Keychain.
Do it from the backup app so it runs unattended. Keep the newest 4 there.

**Done when:** a copy exists off the Seagate drive, and a test restore from
it on a scratch volume passes `./n8nctl.sh verify`.

## 2. Get told when something fails

`status` already warns when the newest snapshot is 26 hours old or more.
Since 2026-10-13 the nightly job (`launchd/nightly.sh`) shows a Mac
notification when the backup fails; the n8n side below is still open.

**What:** on 2026-10-09 the Gmail labelling workflow failed 72 times before
anyone looked, and the LinkedIn failures on 2026-10-11 were also found by
hand. The labeller kept failing: 101 errors on 2026-10-11 and 86 on
2026-10-12, with nobody told.

The error workflow already exists and works: *Gmail Inbox Triage - Error
Handler* (Error Trigger, then a Gmail send) is active and sent 20 emails on
2026-10-09. But only *Gmail Inbox Triage* uses it. These active workflows
have no error workflow (checked 2026-10-15):

- Auto-label incoming Gmail messages with AI
- Weekly Content Pipeline (Gemini → LinkedIn)
- Weekly Facebook Content Scheduler
- Facebook API Check Reminder

**Fix:** in each one, open Workflow settings and set "Error workflow" to
*Gmail Inbox Triage - Error Handler*. Then rename the handler to something
like *Error alerts*, since it now covers everything. Set it on every new
workflow too.

**Done when:** a deliberately failing test workflow sends an email.

## 3. Move the project to the internal disk

**What:** n8n and the gallery read `runtime/`, `templates-api/` and
`searxng-settings.yml` from the Seagate drive through bind mounts. After a
sleep or a USB reconnect those mounts went dead. The `pmset` settings make
this less likely; they do not rule it out.

**Fix:** move the repo to the internal disk and leave the backups on the
Seagate drive with `N8N_BACKUP_DIR`, so live data and backups stay on
different disks. Update the paths in `launchd/n8nctl-backup.applescript`
and rebuild the app. The app still needs its removable-volume permission,
because the backups stay on the Seagate. Take a backup first; the data
volume itself does not move.

**Done when:** `status` is clean after a sleep and wake with the drive
unplugged and plugged back in.

## 4. Store less per run of the Gmail auto-labeller

**What:** the nightly snapshot grew from 45 MB (2026-10-11) to 249 MB
(2026-10-15). Measured 2026-10-15 inside the data volume:

| Where | Size | From |
| --- | --- | --- |
| `database.sqlite`, execution data | 238 MB | *Auto-label incoming Gmail messages with AI*: 212 MB |
| `storage/` (binary data, filesystem mode) | 213 MB | *Weekly Content Pipeline*: 204 MB, from 27 runs |

The labeller runs about 210 times a day and stores about 170 KB per run,
about 25 MB a day. *Gmail Inbox Triage* runs just as often and stores 3 KB
per run. Pruning is on with the defaults (14 days, 10,000 executions), but
the oldest execution is from 2026-10-09, so nothing has been pruned yet.
Pruning starts around 2026-10-23. Estimate after that: about 350 MB of
labeller data in the database and about 400 to 500 MB per snapshot, so
6 to 7 GB for 14 snapshots. SQLite reuses freed pages but does not give
them back to the disk, so the file stays at its largest size.

**Fix:** in the labeller's Workflow settings, set "Save successful
production executions" to "Do not save". Failed runs are still saved, and
those are the ones worth reading. That should take the steady state down to
roughly a tenth. Once the file has stopped growing, n8n's
`DB_SQLITE_VACUUM_ON_STARTUP=true` in `.env` reclaims the space at the next
restart. It can take a while on a large file, so remove it again afterwards.

**Done when:** three nightly snapshots in a row change by less than 10 MB
(`backup` prints the change).
