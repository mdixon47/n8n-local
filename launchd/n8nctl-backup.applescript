-- n8nctl Backup: the app the nightly LaunchAgent opens at 23:00.
--
-- macOS stops processes started by launchd from touching an external drive
-- unless they have permission. A plain /bin/bash job cannot ask for it; an
-- app can. The first run shows "n8nctl Backup would like to access files on
-- a removable volume"; Allow once and only this app gets that access.
--
-- The work is in launchd/nightly.sh (backup, prune, patch upgrade, update
-- check), so changing the job does not need a rebuild. The script logs to
-- ~/Library/Logs/n8nctl-backup.log and prints "NOTIFY:<text>" lines; each one
-- becomes a macOS notification.
--
-- Build and install (see docs/backup-plan.md, "The backup app"):
--   osacompile -o "$HOME/Applications/n8nctl Backup.app" launchd/n8nctl-backup.applescript
-- then set its bundle id, hide it from the Dock and re-sign it.
--
-- Never shows a dialog: notifications do not wait for a click, and errors go
-- to the log, so an unattended run cannot hang.

on run
	set logFile to (POSIX path of (path to home folder)) & "Library/Logs/n8nctl-backup.log"
	set jobPath to "/Volumes/Seagate HDD Media/projects/n8n-local/launchd/nightly.sh"
	set jobOutput to ""
	try
		set jobOutput to do shell script "/bin/bash " & quoted form of jobPath
	on error errMsg number errNum
		try
			do shell script "echo " & quoted form of ("=== n8nctl Backup app: error " & errNum & ": " & errMsg) & " >> " & quoted form of logFile
		end try
		set jobOutput to "NOTIFY:The nightly n8n job could not run (error " & errNum & "). See ~/Library/Logs/n8nctl-backup.log"
	end try
	repeat with aLine in paragraphs of jobOutput
		set aLine to aLine as text
		if aLine starts with "NOTIFY:" and (length of aLine) > 7 then
			display notification (text 8 thru -1 of aLine) with title "n8n"
		end if
	end repeat
end run
