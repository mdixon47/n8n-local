-- n8nctl Backup: the app the nightly LaunchAgent opens to run the backup.
--
-- macOS stops processes started by launchd from touching an external drive
-- unless they have permission. A plain /bin/bash job cannot ask for it; an
-- app can. The first run shows "n8nctl Backup would like to access files on
-- a removable volume"; Allow once and only this app gets that access.
--
-- Build and install (see docs/backup-plan.md, "The backup app"):
--   osacompile -o "$HOME/Applications/n8nctl Backup.app" launchd/n8nctl-backup.applescript
-- then set its bundle id, hide it from the Dock and re-sign it.
--
-- Never shows a dialog: every outcome, including errors, goes to the log, so
-- an unattended run cannot hang waiting for a click.

on run
	set logFile to (POSIX path of (path to home folder)) & "Library/Logs/n8nctl-backup.log"
	set projectDir to "/Volumes/Seagate HDD Media/projects/n8n-local"
	set cmd to "export PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin NO_COLOR=1; " & ¬
		"{ echo \"=== $(date '+%Y-%m-%d %H:%M:%S %Z') n8nctl Backup app: start\"; " & ¬
		"cd " & quoted form of projectDir & " && ./n8nctl.sh -y backup && ./n8nctl.sh -y backups --prune 14; " & ¬
		"echo \"=== $(date '+%Y-%m-%d %H:%M:%S %Z') n8nctl Backup app: exit $?\"; } >> " & quoted form of logFile & " 2>&1"
	try
		do shell script cmd
	on error errMsg number errNum
		try
			do shell script "echo " & quoted form of ("=== n8nctl Backup app: error " & errNum & ": " & errMsg) & " >> " & quoted form of logFile
		end try
	end try
end run
