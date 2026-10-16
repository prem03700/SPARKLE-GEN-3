# SPARKLE GEN-3 backup and recovery runbook

**Status (2026-10-16):** The owner has authorized encrypted GEN-3 backups to the existing `gdrive:` rclone remote. Listing the dedicated `gdrive:SPARKLE-GEN3-Backups` destination has been inconsistent: the latest three-check sequence timed out once and then returned two successful empty listings. Upload/readback and remote retention remain unverified; no backup files have been uploaded or deleted. The local encrypted full-state backup verifies 36 SQLite databases, including the live server database under repository `data/`. The latest isolated restore drill decrypted the bundle into a disposable app copy, passed `/api/health` and `/`, paired a disposable device, and successfully read, wrote, and read back a synthetic workspace task against the restored primary database. A strong passphrase is stored at `~/.config/sparkle/backup-passphrase` with mode `0600`; its value is never printed. No removable/offline key-copy destination is detected, so an independent offline copy of the recovery key is still required before any remote upload. Daily timer and failure-notification unit templates exist in `deploy/systemd/` but are not installed or enabled. Remote retention has not run. Do not treat this as an accepted off-host backup until all remaining gates pass.

## What to protect

GEN-3 persists data across multiple SQLite databases under `~/.local/state/sparkle/` and the live server's primary SQLite database at `data/sparkle-gen3.sqlite3` inside the repository, plus application state/configuration files. `tools/full_state_backup.py` creates online SQLite snapshots and includes the GEN-3 state tree, repository `data/` application database directory, and `~/.config/sparkle/` configuration in an encrypted bundle. It excludes prior backups, symlinks, `gen2.env`, the backup passphrase, and rclone's own configuration. Provider integration credentials and TLS/CA material in the included GEN-3 config tree are sensitive and are only intended to travel inside the verified encrypted artifact. Never put unencrypted bundles in the web root, commit them to Git, attach them to bug reports, or upload them to an unapproved service.

## Required policy before enabling automation

1. Choose an off-host destination controlled by the owner (for example, an encrypted disk stored separately or a private server reached over SSH). Do not use a public/shared destination without an explicit privacy review.
2. Choose an encryption method and store its recovery key separately from the backup destination. Losing the key makes encrypted backups unrecoverable; storing it beside the backups defeats the protection.
3. Target: one daily backup, retain 7 daily, 4 weekly, and 12 monthly recovery points. Keep at least one copy physically or administratively separate from the SPARKLE host.
4. Restrict backup files and temporary working directories to the owner (mode 0600 for files, 0700 for directories). Avoid command lines or logs that print workspace data or secrets.
5. Alert the owner on a failed backup or verification. A scheduled job that silently fails is not a backup strategy.

## Creating a consistent database backup

Use SQLite's online backup API rather than copying the live database file with a generic file-copy command. This produces a consistent snapshot while SQLite is in use.

A minimal Python pattern for an owner-run backup utility is:

```python
import os
import sqlite3
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path

source = Path("/home/prem-macharla/SPARKLE-GEN3/data/sparkle-gen3.sqlite3")
staging = Path("/secure-local-staging")  # Dedicated owner-controlled directory, outside the repo/web root.
staging.mkdir(mode=0o700, parents=True, exist_ok=True)
info = staging.stat()
if staging.is_symlink() or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
    raise RuntimeError("Staging directory must be owner-owned and inaccessible to group/other users")
if not source.is_file():
    raise RuntimeError("Source database is not a regular file")

stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
destination = staging / f"sparkle-gen3-{stamp}-{os.getpid()}.sqlite3"
fd, temporary_name = tempfile.mkstemp(prefix=".sparkle-gen3-", suffix=".partial", dir=staging)
os.close(fd)
temporary = Path(temporary_name)
os.chmod(temporary, 0o600)
src = dst = None
try:
    src = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    dst = sqlite3.connect(temporary)
    src.backup(dst)
    result = dst.execute("PRAGMA integrity_check").fetchone()
    if not result or result[0] != "ok":
        raise RuntimeError("SQLite integrity check failed")
    dst.close()
    dst = None
    src.close()
    src = None
    # Hard-link publication fails rather than overwriting an existing recovery point.
    os.link(temporary, destination)
    os.chmod(destination, 0o600)
finally:
    if dst is not None:
        dst.close()
    if src is not None:
        src.close()
    temporary.unlink(missing_ok=True)

print(f"Verified SQLite snapshot: {destination}")
```

Replace the staging path with an owner-controlled directory outside the repository and web root. Ensure that directory is on a filesystem with sufficient space. Do not place the backup in a cloud-sync folder before encryption. The utility should use a unique timestamped filename, avoid overwriting the last known-good backup, and remove incomplete temporary files after failure.

## Implemented utility and current operating boundary

`tools/backup_recovery.py` is the tested implementation. It uses SQLite's online backup API, checks the snapshot's schema and integrity, encrypts with GPG AES-256, decrypts into a private temporary directory to verify the exact SHA-256 and SQLite integrity, and publishes files without overwriting an existing recovery point. Files are owner-only. The default output is `~/.local/state/sparkle/backups/encrypted`; the default key file is `~/.config/sparkle/backup-passphrase` and must be a non-empty regular file owned by the current user with mode `0600` or stricter. The key file has been created with owner-only permissions. Its value is intentionally not included in documentation or logs; keep an independent offline copy.

Run `python3 tools/backup_recovery.py --help` to inspect options. `--snapshot-only` deliberately creates an unencrypted SQLite snapshot and is for controlled local verification only. Normal runs require the passphrase file. Off-host transfer happens only when `--remote` or `SPARKLE_BACKUP_REMOTE` is explicitly set; the utility uploads the encrypted file with `rclone` and compares the downloaded remote bytes against the local SHA-256 before reporting success. Do not configure a remote until the owner approves the exact destination and separately protects the recovery passphrase.

Current limitations: `tools/backup_recovery.py` is a single-database helper, not a complete GEN-3 recovery point. `tools/full_state_backup.py` builds a private archive of the GEN-3 state tree (excluding prior backups), the live repository `data/` directory, and the owner config tree (excluding `gen2.env` and the backup key), snapshots each SQLite database through SQLite's online backup API, verifies each database, encrypts the archive with GPG AES-256, and verifies a byte-for-byte decrypt round trip. It does not include the rclone configuration. A read-only `gdrive:` root listing and creation of the dedicated destination passed. An initial destination listing timed out, but a subsequent bounded listing succeeded and returned zero entries. This confirms current list access, not upload/readback verification. No backup files have been uploaded or deleted. The recovery passphrase exists in the owner-only local config directory, but its independent offline copy has not yet been confirmed. Local single-database retention keeps up to 7 encrypted snapshots. Tiered remote retention logic (7 recent daily points, 4 additional weekly points, and 12 additional monthly points) is implemented and unit-tested, but remote pruning has not been run or verified. Full-state upload and remote pruning now fail closed unless the exact `gdrive:SPARKLE-GEN3-Backups` prefix is specified. Local pruning only removes files matching the strict full-state backup filename and timestamp format; malformed or unrelated matching-prefix files are preserved. Daily timer and failure-notification templates exist but are not installed or enabled. A local isolated application restore now passes for the primary server database, but off-host recovery remains pending.

## Encrypt, transfer, and verify

1. The implemented utility uses GPG symmetric AES-256 encryption with the owner-managed passphrase file. Keep an independently recoverable copy of the passphrase offline and separate from the backup destination; do not paste it into chat, put it in Git, or store it only beside remote backups.
2. Compute a SHA-256 checksum for the encrypted artifact. Transfer only the encrypted artifact and checksum to the chosen off-host destination over an authenticated channel.
3. On the destination, verify the checksum after transfer. Check that the remote artifact is readable, non-empty, encrypted, and retained according to policy. Do not rely on a successful transfer exit code alone.
4. Rotate old recovery points only after the newest backup has passed integrity and transfer checks. Preserve the last known-good copy if a new run fails.
5. Do not print credentials, encryption private keys, pairing codes, bearer tokens, or database rows in logs.

## Restore drill (use an isolated copy first)

1. Select one retained encrypted backup and verify its checksum before decryption.
2. Decrypt into a private temporary directory with restrictive permissions. Never decrypt directly into the live `data/` directory.
3. Restore into a **new disposable SQLite file**, run `PRAGMA integrity_check`, and compare the table/schema inventory with the expected application schema. A successful integrity check proves database consistency, not that every business workflow is correct.
4. Start a test instance against the disposable data directory, isolated from the production port and real provider credentials. Check login/pairing boundaries and representative workspace read/write flows without printing user content.
5. For actual recovery, stop the service first, preserve the current database as a separate rollback copy, place the verified restore in the expected location with owner-only permissions, and restart. Confirm health and representative workflows before deleting any rollback copy.
6. Record date, backup age, checksum verification, restore duration, integrity result, and any issues—never workspace contents or secrets.

## Recovery objectives and review

Until measured by repeated drills, recovery time and maximum data loss are **unknown**. The proposed daily cadence implies up to roughly 24 hours of data loss between successful backups, plus any missed runs. Review the cadence against actual needs after the first month.

A backup is accepted only when all are true:
- [ ] Encrypted off-host copy exists on an owner-controlled destination.
- [ ] Checksum verified after transfer.
- [ ] Retention rotation leaves the required recovery points.
- [ ] A restore to an isolated database passes integrity and schema checks.
- [ ] A test instance can read and write representative data.
- [ ] Recovery key is available independently of the backup destination.
- [ ] Owner records the drill result and knows how to restore without overwriting the only good copy.

**Latest verified full-state test (2026-10-16):** A local encrypted full-state bundle was created and verified across 36 SQLite databases, including the live GEN-3 server database under repository `data/`. The bundle passed byte-for-byte decrypt verification. It was then decrypted into a private disposable directory, its archive paths and file types were validated, and all 36 databases passed integrity/schema checks. A separate disposable application copy was launched against the restored primary database; `/api/health` and `/` returned HTTP 200, a disposable device paired successfully, and a synthetic workspace task passed write/readback verification. The disposable server and restored files were removed after the drill. No workspace rows, credentials, or key contents were printed. This is local verification only, not proof of off-host recovery.

**Remaining limitation:** The encrypted bundle has not been copied off-host. The Google Drive root preflight and dedicated-folder creation succeeded, but destination listing is inconsistent (one timeout followed by two successful empty listings in the latest sequence), so upload/readback and remote retention are unverified. The recovery key still needs an independent offline copy. The backup timer/notification templates are not installed or enabled. The failure unit now runs as the owner, attempts a desktop notification, and falls back to a critical syslog/journal entry if the desktop notification bus is unavailable; this fallback has been statically validated but not tested as an installed systemd unit. Remote retention has not been exercised against the live destination. The browser smoke test also passes the application's backup-export/validated-restore workflow, but neither that nor the local drill substitutes for verified off-host disaster recovery.
