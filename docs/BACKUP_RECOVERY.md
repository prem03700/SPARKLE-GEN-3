# SPARKLE GEN-3 backup and recovery runbook

**Status:** Procedure drafted; off-host destination and automated rotation are not configured. Do not treat this document as proof that backups exist.

## What to protect

The authoritative workspace database is `data/sparkle-gen3.sqlite3`. Treat every backup as sensitive: it can contain workspace content, device records, audit events, and authentication-related hashes. Never put backups in the web root, commit them to Git, attach them to bug reports, or upload them to an unapproved service.

Also preserve the owner-managed deployment configuration and TLS/CA material using a separate encrypted, access-controlled procedure. Never copy private keys or provider credentials into the repository or into an unencrypted backup bundle.

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

## Encrypt, transfer, and verify

1. Encrypt the completed snapshot with a maintained tool such as age using an owner-controlled recipient key. Keep the private identity/recovery key offline or in a separate protected location.
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

**Latest verified local snapshot (2026-10-14):** The live authoritative SQLite database passed `PRAGMA integrity_check`. A consistent snapshot was created with SQLite's online backup API at `/home/prem-macharla/.local/state/sparkle/backups/sparkle-gen3-20261014T031344Z-344641.sqlite3` (owner-only mode `0600`, 278,528 bytes). The snapshot passed `PRAGMA integrity_check`, matched the source schema inventory (10 schema objects), and was restored into a separate disposable SQLite file that also passed integrity and schema checks. SHA-256: `aef17e60d66337c30fd105160860a96906cea47716b791c597e338ac28bdddc1`. No workspace rows were printed in the verification output.

**Remaining limitation:** This is a single local, unencrypted snapshot protected by owner-only filesystem permissions; it is not an encrypted off-host backup. No owner-approved off-host destination, encryption/recovery-key arrangement, recurring rotation, alerting, or full application disaster-recovery drill has been configured or verified. The browser smoke test separately passes the application backup-export/validated-restore workflow, but that is not a substitute for a full disaster-recovery rehearsal.
