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
| 4 | Timezone and backup size | Small checks before activating schedules | 20 min |

Done on 2026-10-12 (n8nctl 1.5.0): `restore` verifies the snapshot first;
`upgrade` never lets the installer start n8n and checks the result; `status`
checks container health, bind mounts, the preload and backup age; the
network check is `test/netcheck.js`; the gallery sends CORS headers only to
the editor; the helper image is pinned; CI parses the preload, the network
check and the gallery code.

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
hand. The nightly backup reports only to
`~/Library/Logs/n8nctl-backup.log`, which is checked weekly.

**Fix:**

- In n8n: make one error workflow (an Error Trigger that sends an email
  through the existing Gmail credential), activate it (2.42 skips inactive
  error workflows), and set it as the error workflow on every active
  workflow.
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

## 4. Timezone and backup size

- **Timezone:** `GENERIC_TIMEZONE` is not set in `.env`, so schedules use
  n8n's default, `America/New_York`. That matches this Mac by chance; set it
  explicitly before activating the scheduled workflows (issues.md item 6).
- **Backup size:** the nightly snapshot grew from 45 MB
  (`20261011-030006`) to 114 MB (`20261012-030007`) in one day. Find out
  why (execution data, binary files, or the template import) and check
  that execution pruning keeps it in bounds.
  `backup` could print the change from the previous snapshot's size.
