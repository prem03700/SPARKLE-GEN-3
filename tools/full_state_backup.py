#!/usr/bin/env python3
"""Create an encrypted, verified GEN-3 state/config recovery bundle.

Never includes GEN-2 configuration, rclone credentials, or the backup key.
Remote upload is opt-in and only occurs after owner approval.
"""
from __future__ import annotations
import argparse
import hashlib
import os
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

STATE_DEFAULT = Path.home() / ".local/state/sparkle"
CONFIG_DEFAULT = Path.home() / ".config/sparkle"
# The live GEN-3 server currently stores its primary SQLite database in repo/data.
APP_DATA_DEFAULT = Path(__file__).resolve().parents[1] / "data"
OUTPUT_DEFAULT = Path.home() / ".local/state/sparkle/backups/encrypted"
EXCLUDED_CONFIG_NAMES = {"gen2.env", "backup-passphrase"}
EXCLUDED_STATE_DIRS = {"backups"}

class BackupError(RuntimeError):
    pass

def private_dir(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise BackupError("Output directory must be a real directory, not a symlink")
    st = path.stat()
    if st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) & 0o077:
        raise BackupError("Output directory must be owner-owned and inaccessible to group/other users")

def digest_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()

def sqlite_snapshot(source: Path, destination: Path) -> None:
    if source.is_symlink() or not source.is_file():
        raise BackupError("SQLite source is not a regular file")
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with closing(sqlite3.connect(f"file:{source.resolve()}?mode=ro", uri=True, timeout=15)) as src:
        source_check = src.execute("PRAGMA integrity_check").fetchone()
        if not source_check or source_check[0] != "ok":
            raise BackupError("A source SQLite database failed integrity_check")
        schema = tuple(src.execute("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"))
        if not schema:
            raise BackupError("A source SQLite database has no application schema")
        with closing(sqlite3.connect(destination, timeout=15)) as dst:
            src.backup(dst)
            dst.commit()
            check = dst.execute("PRAGMA integrity_check").fetchone()
            target_schema = tuple(dst.execute("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"))
            if not check or check[0] != "ok" or target_schema != schema:
                raise BackupError("A SQLite snapshot failed integrity/schema verification")
    os.chmod(destination, 0o600)

def copy_tree(source: Path, target: Path, *, is_config: bool = False) -> int:
    """Copy a tree, online-snapshotting SQLite files and rejecting symlinks."""
    if not source.exists():
        return 0
    if source.is_symlink() or not source.is_dir():
        raise BackupError("Recovery source must be a real directory, not a symlink")
    count = 0
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    for path in sorted(source.rglob("*")):
        rel = path.relative_to(source)
        if any(part in EXCLUDED_STATE_DIRS for part in rel.parts) and not is_config:
            continue
        if is_config and any(part in EXCLUDED_CONFIG_NAMES for part in rel.parts):
            continue
        if path.is_symlink():
            # Do not follow symlinks from mutable state/config directories.
            continue
        # SQLite's online backup API captures committed WAL content into the
        # snapshot. Never bundle live WAL/SHM/journal sidecars as independent
        # files; that can preserve transient or mismatched database state.
        if path.name.endswith(("-wal", "-shm", "-journal")):
            database = path.with_name(path.name.rsplit("-", 1)[0])
            if database.is_file() and database.suffix.lower() in {".sqlite", ".sqlite3", ".db"}:
                continue
        out = target / rel
        if path.is_dir():
            out.mkdir(mode=0o700, parents=True, exist_ok=True)
            continue
        if not path.is_file():
            continue
        out.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if path.suffix.lower() in {".sqlite", ".sqlite3", ".db"}:
            sqlite_snapshot(path, out)
        else:
            shutil.copyfile(path, out)
            os.chmod(out, 0o600)
        count += 1
    return count

def verify_archive(path: Path) -> int:
    count = 0
    with tarfile.open(path, "r:gz") as archive:
        for member in archive.getmembers():
            if not (member.isfile() or member.isdir()):
                raise BackupError("Recovery archive contains an unsupported entry type")
            if member.name.startswith("/") or ".." in Path(member.name).parts:
                raise BackupError("Recovery archive contains an unsafe path")
            if member.isfile() and Path(member.name).suffix.lower() in {".sqlite", ".sqlite3", ".db"}:
                stream = archive.extractfile(member)
                if stream is None:
                    raise BackupError("Could not read a bundled SQLite database")
                with tempfile.NamedTemporaryFile(prefix="sparkle-db-check-", suffix=Path(member.name).suffix) as tmp:
                    shutil.copyfileobj(stream, tmp)
                    tmp.flush()
                    with closing(sqlite3.connect(f"file:{tmp.name}?mode=ro", uri=True)) as db:
                        check = db.execute("PRAGMA integrity_check").fetchone()
                        schema = db.execute("SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchone()
                        if not check or check[0] != "ok" or not schema or schema[0] < 1:
                            raise BackupError("Bundled SQLite database failed integrity/schema verification")
                count += 1
    if count < 1:
        raise BackupError("Recovery archive contains no verified SQLite databases")
    return count

def build_bundle(state_dir: Path, config_dir: Path, output_dir: Path, app_data_dir: Path | None = None) -> tuple[Path, int]:
    private_dir(output_dir)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    final = output_dir / f"sparkle-gen3-fullstate-{stamp}-{os.getpid()}.tar.gz"
    if final.exists():
        raise BackupError("Recovery bundle already exists; refusing overwrite")
    with tempfile.TemporaryDirectory(prefix="sparkle-bundle-", dir=output_dir) as tmp:
        os.chmod(tmp, 0o700)
        root = Path(tmp) / "bundle"
        root.mkdir(mode=0o700)
        state_count = copy_tree(state_dir, root / "state")
        config_count = copy_tree(config_dir, root / "config", is_config=True)
        app_data_count = copy_tree(app_data_dir, root / "app-data") if app_data_dir is not None else 0
        if state_count + app_data_count < 1:
            raise BackupError("No application or state files were found to back up")
        # Record only inventory counts and timestamp, never filenames or user content.
        (root / "BACKUP-METADATA.txt").write_text(
            f"format=SPARKLE-GEN3-full-state-v1\ncreated_utc={stamp}\nstate_files={state_count}\nconfig_files={config_count}\napp_data_files={app_data_count}\n"
        )
        os.chmod(root / "BACKUP-METADATA.txt", 0o600)
        temporary = Path(tmp) / "bundle.tar.gz"
        with tarfile.open(temporary, "w:gz", compresslevel=6) as archive:
            archive.add(root, arcname="sparkle-gen3-recovery", recursive=True)
        os.chmod(temporary, 0o600)
        db_count = verify_archive(temporary)
        os.link(temporary, final)
    return final, db_count

def encrypt_verify(bundle: Path, key_file: Path) -> Path:
    if key_file.is_symlink() or not key_file.is_file():
        raise BackupError("Recovery passphrase file is missing or unsafe")
    st = key_file.stat()
    if st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) & 0o077 or st.st_size < 32:
        raise BackupError("Recovery passphrase file must be owner-only and contain at least 32 bytes")
    encrypted = bundle.with_suffix(bundle.suffix + ".gpg")
    with tempfile.TemporaryDirectory(prefix="sparkle-encrypt-verify-", dir=bundle.parent) as tmp:
        os.chmod(tmp, 0o700)
        temp_enc = Path(tmp) / "bundle.tar.gz.gpg"
        subprocess.run(["gpg", "--batch", "--pinentry-mode", "loopback", "--passphrase-file", str(key_file), "--symmetric", "--cipher-algo", "AES256", "--output", str(temp_enc), str(bundle)], check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=300)
        restored = Path(tmp) / "roundtrip.tar.gz"
        with restored.open("wb") as output:
            subprocess.run(["gpg", "--batch", "--pinentry-mode", "loopback", "--passphrase-file", str(key_file), "--decrypt", str(temp_enc)], check=True, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.PIPE, timeout=300)
        if digest_file(restored) != digest_file(bundle):
            raise BackupError("Encrypted bundle did not round-trip byte-for-byte")
        verify_archive(restored)
        os.link(temp_enc, encrypted)
        os.chmod(encrypted, 0o600)
    return encrypted

def validate_remote(remote: str) -> str:
    """Fail closed unless the exact owner-approved backup prefix is used."""
    if remote.rstrip("/") != "gdrive:SPARKLE-GEN3-Backups":
        raise BackupError("Remote must be the exact dedicated gdrive:SPARKLE-GEN3-Backups destination")
    return "gdrive:SPARKLE-GEN3-Backups"

def upload_verify(path: Path, remote: str) -> str:
    remote = validate_remote(remote)
    destination = remote + "/" + path.name
    try:
        subprocess.run(["rclone", "copyto", str(path), destination], check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=900)
        with tempfile.TemporaryFile() as f:
            subprocess.run(["rclone", "cat", destination], check=True, stdin=subprocess.DEVNULL, stdout=f, stderr=subprocess.PIPE, timeout=900)
            f.seek(0)
            h = hashlib.sha256()
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        if h.hexdigest() != digest_file(path):
            raise BackupError("Remote encrypted bundle checksum verification failed")
    except subprocess.CalledProcessError as exc:
        raise BackupError("Remote upload/verification failed; no backup was declared successful") from exc
    return destination

def backup_timestamp(name: str) -> datetime | None:
    match = re.fullmatch(r"sparkle-gen3-fullstate-(\d{8}T\d{6}Z)-\d+\.tar\.gz\.gpg", Path(name).name)
    if not match:
        return None
    try:
        return datetime.strptime(match.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None

def retained_remote_names(names: list[str], daily: int = 7, weekly: int = 4, monthly: int = 12) -> set[str]:
    """Keep newest 7 individual points, then 4 weekly and 12 monthly points.

    Only strict full-state backup filenames are eligible. Unknown remote objects
    are never selected for deletion. This selector is pure and separately tested.
    """
    if min(daily, weekly, monthly) < 1:
        raise BackupError("Retention windows must each keep at least one recovery point")
    records = [(backup_timestamp(name), Path(name).name) for name in names]
    records = sorted(((stamp, name) for stamp, name in records if stamp is not None), reverse=True)
    keep: set[str] = set()
    keep.update(name for _, name in records[:daily])
    covered_weeks = {(stamp.isocalendar().year, stamp.isocalendar().week) for stamp, name in records if name in keep}
    week_candidates: dict[tuple[int, int], tuple[datetime, str]] = {}
    for stamp, name in records:
        week = stamp.isocalendar()
        key = (week.year, week.week)
        if name in keep or key in covered_weeks:
            continue
        week_candidates.setdefault(key, (stamp, name))
    for key, (_, name) in sorted(week_candidates.items(), key=lambda item: item[1][0], reverse=True)[:weekly]:
        keep.add(name)
        covered_weeks.add(key)
    covered_months = {(stamp.year, stamp.month) for stamp, name in records if name in keep}
    month_candidates: dict[tuple[int, int], tuple[datetime, str]] = {}
    for stamp, name in records:
        key = (stamp.year, stamp.month)
        if name in keep or key in covered_months:
            continue
        month_candidates.setdefault(key, (stamp, name))
    for key, (_, name) in sorted(month_candidates.items(), key=lambda item: item[1][0], reverse=True)[:monthly]:
        keep.add(name)
        covered_months.add(key)
    return keep

def remote_list_files(remote: str) -> list[str]:
    try:
        result = subprocess.run(["rclone", "lsf", "--files-only", "--format", "p", remote],
                                check=True, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
    except subprocess.CalledProcessError as exc:
        raise BackupError("Could not list remote backups; refusing to prune") from exc
    return [line.strip() for line in result.stdout.splitlines() if line.strip() and "/" not in line.strip()]

def prune_remote(remote: str) -> tuple[int, int]:
    """Apply tiered retention only to our exact encrypted full-state filename pattern."""
    remote = validate_remote(remote)
    names = remote_list_files(remote)
    eligible = [name for name in names if backup_timestamp(name) is not None]
    keep = retained_remote_names(eligible)
    deleted = 0
    for name in eligible:
        if name in keep:
            continue
        destination = remote.rstrip("/") + "/" + name
        try:
            subprocess.run(["rclone", "deletefile", destination], check=True, stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=120)
        except subprocess.CalledProcessError as exc:
            raise BackupError("Remote retention pruning failed; verify the remote inventory manually") from exc
        deleted += 1
    remaining = remote_list_files(remote)
    remaining_eligible = {name for name in remaining if backup_timestamp(name) is not None}
    if not keep.issubset(remaining_eligible) or remaining_eligible != keep:
        raise BackupError("Remote retention verification failed; expected recovery-point set differs")
    return len(keep), deleted

def prune_local(output_dir: Path) -> tuple[int, int]:
    # Only strictly parsed recovery points are eligible. Malformed or unrelated
    # files must never be removed merely because their names share a prefix.
    candidates = [path for path in output_dir.glob("sparkle-gen3-fullstate-*.tar.gz.gpg")
                  if backup_timestamp(path.name) is not None and path.is_file() and not path.is_symlink()]
    names = [path.name for path in candidates]
    keep = retained_remote_names(names)
    deleted = 0
    for path in candidates:
        if path.name not in keep:
            path.unlink()
            deleted += 1
    remaining = {path.name for path in output_dir.glob("sparkle-gen3-fullstate-*.tar.gz.gpg")
                 if backup_timestamp(path.name) is not None and path.is_file() and not path.is_symlink()}
    if remaining != keep:
        raise BackupError("Local retention verification failed; expected recovery-point set differs")
    return len(keep), deleted

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=STATE_DEFAULT)
    parser.add_argument("--config-dir", type=Path, default=CONFIG_DEFAULT)
    parser.add_argument("--app-data-dir", type=Path, default=APP_DATA_DEFAULT,
                        help="Application data directory (includes the live GEN-3 SQLite database)")
    parser.add_argument("--output-dir", type=Path, default=OUTPUT_DEFAULT)
    parser.add_argument("--passphrase-file", type=Path, default=Path.home() / ".config/sparkle/backup-passphrase")
    parser.add_argument("--remote", help="Explicit authorized destination, e.g. gdrive:SPARKLE-GEN3-Backups")
    parser.add_argument("--build-only", action="store_true", help="Build and verify an unencrypted local archive; never upload")
    args = parser.parse_args()
    bundle = None
    try:
        bundle, db_count = build_bundle(args.state_dir, args.config_dir, args.output_dir, args.app_data_dir)
        if args.build_only:
            print(f"Verified local full-state bundle created; SQLite databases verified: {db_count}; SHA-256: {digest_file(bundle)}")
            return 0
        encrypted = encrypt_verify(bundle, args.passphrase_file)
        if args.remote:
            destination = upload_verify(encrypted, args.remote)
            print(f"Encrypted full-state bundle uploaded and checksum-verified; SQLite databases verified: {db_count}; remote path: {destination}; SHA-256: {digest_file(encrypted)}")
            retained, deleted = prune_remote(args.remote)
            print(f"Remote retention verified: {retained} encrypted recovery points retained; {deleted} older matching recovery points pruned.")
        else:
            print(f"Encrypted full-state bundle verified locally; SQLite databases verified: {db_count}; SHA-256: {digest_file(encrypted)}; no remote upload requested")
        local_retained, local_deleted = prune_local(args.output_dir)
        print(f"Local retention verified: {local_retained} encrypted recovery points retained; {local_deleted} older matching recovery points pruned.")
        return 0
    except (BackupError, OSError, sqlite3.Error, tarfile.TarError, subprocess.SubprocessError) as exc:
        print(f"Full-state backup failed: {exc}", file=sys.stderr)
        return 1
    finally:
        if bundle is not None:
            bundle.unlink(missing_ok=True)

if __name__ == "__main__":
    raise SystemExit(main())
