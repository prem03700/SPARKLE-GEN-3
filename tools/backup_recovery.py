#!/usr/bin/env python3
"""Create and verify encrypted SPARKLE GEN-3 SQLite recovery points.

Remote upload is opt-in and must target an owner-approved rclone destination.
The program never exports workspace rows to stdout.
"""
from __future__ import annotations
import argparse
from contextlib import closing
import hashlib
import os
import sqlite3
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "data" / "sparkle-gen3.sqlite3"
DEFAULT_OUTPUT = Path.home() / ".local/state/sparkle/backups/encrypted"

class BackupError(RuntimeError):
    pass

def require_private_file(path: Path, label: str) -> None:
    if path.is_symlink() or not path.is_file():
        raise BackupError(f"{label} must be a regular, non-symlink file")
    info = path.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise BackupError(f"{label} must be owner-owned with no group/other permissions")
    if info.st_size == 0:
        raise BackupError(f"{label} must not be empty")

def ensure_private_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise BackupError("Backup directory must be a real directory, not a symlink")
    info = path.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise BackupError("Backup directory must be owner-owned with no group/other permissions")

def schema_inventory(connection: sqlite3.Connection) -> tuple[tuple[str, str], ...]:
    return tuple(connection.execute(
        "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    ).fetchall())

def sqlite_integrity(path: Path) -> tuple[tuple[str, str], ...]:
    with closing(sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True, timeout=10)) as connection:
        result = connection.execute("PRAGMA integrity_check").fetchone()
        if not result or result[0] != "ok":
            raise BackupError("SQLite integrity check failed")
        schema = schema_inventory(connection)
        if not schema:
            raise BackupError("SQLite database has no application schema")
        return schema

def create_sqlite_snapshot(source: Path, output_dir: Path) -> Path:
    if source.is_symlink() or not source.is_file():
        raise BackupError("Source database must be a regular, non-symlink file")
    ensure_private_directory(output_dir)
    source_schema = sqlite_integrity(source)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    final = output_dir / f"sparkle-gen3-{stamp}-{os.getpid()}.sqlite3"
    fd, temp_name = tempfile.mkstemp(prefix=".sparkle-gen3-", suffix=".partial", dir=output_dir)
    os.close(fd)
    temporary = Path(temp_name)
    os.chmod(temporary, 0o600)
    src = dst = None
    try:
        src = sqlite3.connect(f"file:{source.resolve()}?mode=ro", uri=True, timeout=10)
        dst = sqlite3.connect(temporary, timeout=10)
        src.backup(dst)
        dst.commit()
        result = dst.execute("PRAGMA integrity_check").fetchone()
        if not result or result[0] != "ok":
            raise BackupError("New SQLite snapshot failed integrity check")
        if schema_inventory(dst) != source_schema:
            raise BackupError("Snapshot schema does not match the source database")
        dst.close(); dst = None
        src.close(); src = None
        os.chmod(temporary, 0o600)
        os.link(temporary, final)  # Atomic, no-overwrite publication.
        return final
    finally:
        if dst is not None:
            dst.close()
        if src is not None:
            src.close()
        temporary.unlink(missing_ok=True)

def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def encrypt_and_verify(snapshot: Path, passphrase_file: Path) -> Path:
    require_private_file(passphrase_file, "Encryption passphrase file")
    output = snapshot.with_suffix(snapshot.suffix + ".gpg")
    if output.exists():
        raise BackupError("Encrypted recovery-point filename already exists")
    fd, temp_name = tempfile.mkstemp(prefix=".sparkle-encrypted-", suffix=".partial", dir=snapshot.parent)
    os.close(fd)
    encrypted_temp = Path(temp_name)
    os.chmod(encrypted_temp, 0o600)
    try:
        subprocess.run([
            "gpg", "--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase-file", str(passphrase_file),
            "--symmetric", "--cipher-algo", "AES256", "--output", str(encrypted_temp), str(snapshot),
        ], check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=120)
        if not encrypted_temp.is_file() or encrypted_temp.stat().st_size < 32:
            raise BackupError("Encryption did not produce a valid artifact")
        with tempfile.TemporaryDirectory(prefix="sparkle-verify-", dir=snapshot.parent) as tmp_name:
            os.chmod(tmp_name, 0o700)
            restored = Path(tmp_name) / "verified.sqlite3"
            with restored.open("wb") as handle:
                os.chmod(restored, 0o600)
                subprocess.run([
                    "gpg", "--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase-file", str(passphrase_file),
                    "--decrypt", str(encrypted_temp),
                ], check=True, stdin=subprocess.DEVNULL, stdout=handle, stderr=subprocess.PIPE, timeout=120)
            if sha256_file(restored) != sha256_file(snapshot):
                raise BackupError("Encrypted artifact did not round-trip to the exact SQLite snapshot")
            sqlite_integrity(restored)
        os.link(encrypted_temp, output)
        os.chmod(output, 0o600)
        return output
    except subprocess.CalledProcessError as exc:
        raise BackupError("GPG encryption/decryption verification failed; check the configured key file") from exc
    finally:
        encrypted_temp.unlink(missing_ok=True)

def upload_and_verify(encrypted_file: Path, remote: str) -> str:
    """Upload to an explicitly configured rclone path and verify remote bytes."""
    if not remote or ":" not in remote or remote.startswith(":"):
        raise BackupError("Remote must be an explicit rclone destination such as remote:path")
    destination = remote.rstrip("/") + "/" + encrypted_file.name
    try:
        subprocess.run(["rclone", "copyto", str(encrypted_file), destination], check=True,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=600)
        with tempfile.TemporaryFile() as handle:
            subprocess.run(["rclone", "cat", destination], check=True, stdin=subprocess.DEVNULL,
                           stdout=handle, stderr=subprocess.PIPE, timeout=600)
            handle.seek(0)
            digest = hashlib.sha256()
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != sha256_file(encrypted_file):
            raise BackupError("Remote encrypted backup checksum verification failed")
        return destination
    except subprocess.CalledProcessError as exc:
        raise BackupError("Remote upload or remote byte-for-byte verification failed") from exc

def rotate_local(output_dir: Path, keep: int) -> None:
    if keep < 1:
        raise BackupError("At least one local recovery point must be retained")
    candidates = sorted(output_dir.glob("sparkle-gen3-*.sqlite3.gpg"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in candidates[keep:]:
        old.unlink()

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--passphrase-file", type=Path, default=Path.home() / ".config/sparkle/backup-passphrase")
    parser.add_argument("--remote", default=os.environ.get("SPARKLE_BACKUP_REMOTE"),
                        help="Explicit, owner-approved rclone destination (example: gdrive:SPARKLE-GEN3-Backups)")
    parser.add_argument("--keep-local", type=int, default=7)
    parser.add_argument("--snapshot-only", action="store_true", help="Create and verify an unencrypted snapshot only")
    return parser.parse_args(argv)

def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    snapshot: Path | None = None
    try:
        snapshot = create_sqlite_snapshot(args.source, args.output_dir)
        if args.snapshot_only:
            print(f"Verified SQLite snapshot created: {snapshot.name}; SHA-256 {sha256_file(snapshot)}")
            return 0
        encrypted = encrypt_and_verify(snapshot, args.passphrase_file)
        digest = sha256_file(encrypted)
        remote_location = upload_and_verify(encrypted, args.remote) if args.remote else None
        rotate_local(args.output_dir, args.keep_local)
        count = len(list(args.output_dir.glob("sparkle-gen3-*.sqlite3.gpg")))
        print(f"Encrypted backup verified: {encrypted.name}; SHA-256 {digest}")
        print(f"Local encrypted recovery points retained: {count}")
        if remote_location:
            print("Off-host copy uploaded and checksum-verified.")
        else:
            print("WARNING: no off-host destination configured; off-host recovery is not yet complete.")
        return 0
    except (BackupError, OSError, sqlite3.Error, subprocess.TimeoutExpired) as exc:
        print(f"Backup failed: {exc}", file=sys.stderr)
        return 1
    finally:
        if snapshot is not None and not args.snapshot_only:
            snapshot.unlink(missing_ok=True)

if __name__ == "__main__":
    raise SystemExit(main())
