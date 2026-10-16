import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from tools.backup_recovery import (
    BackupError,
    create_sqlite_snapshot,
    encrypt_and_verify,
    rotate_local,
    sha256_file,
    sqlite_integrity,
)


class BackupRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sparkle-backup-test-")
        self.root = Path(self.temp.name)
        os.chmod(self.root, 0o700)
        self.source = self.root / "source.sqlite3"
        with closing(sqlite3.connect(self.source)) as db:
            db.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
            db.execute("INSERT INTO sample(value) VALUES ('fixture-only')")
            db.commit()
        self.output = self.root / "backups"
        self.output.mkdir(mode=0o700)

    def tearDown(self):
        self.temp.cleanup()

    def test_snapshot_uses_sqlite_backup_and_preserves_schema_without_exposing_rows(self):
        snapshot = create_sqlite_snapshot(self.source, self.output)
        self.assertEqual(sqlite_integrity(snapshot), sqlite_integrity(self.source))
        self.assertEqual(snapshot.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o700)
        with closing(sqlite3.connect(snapshot)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM sample").fetchone()[0], 1)
        self.assertEqual(len(sha256_file(snapshot)), 64)

    def test_rejects_symlink_source(self):
        link = self.root / "linked.sqlite3"
        link.symlink_to(self.source)
        with self.assertRaises(BackupError):
            create_sqlite_snapshot(link, self.output)

    def test_rejects_group_or_other_accessible_output_directory(self):
        os.chmod(self.output, 0o755)
        with self.assertRaises(BackupError):
            create_sqlite_snapshot(self.source, self.output)

    def test_encrypts_and_verifies_exact_snapshot_with_private_passphrase_file(self):
        passphrase = self.root / "passphrase"
        passphrase.write_text("test-only-passphrase\n", encoding="utf-8")
        os.chmod(passphrase, 0o600)
        snapshot = create_sqlite_snapshot(self.source, self.output)
        encrypted = encrypt_and_verify(snapshot, passphrase)
        self.assertTrue(encrypted.is_file())
        self.assertGreater(encrypted.stat().st_size, 32)
        self.assertEqual(encrypted.stat().st_mode & 0o777, 0o600)
        self.assertNotEqual(sha256_file(encrypted), sha256_file(snapshot))

    def test_rejects_insecure_passphrase_file(self):
        passphrase = self.root / "insecure-passphrase"
        passphrase.write_text("test-only-passphrase\n", encoding="utf-8")
        os.chmod(passphrase, 0o644)
        snapshot = create_sqlite_snapshot(self.source, self.output)
        with self.assertRaises(BackupError):
            encrypt_and_verify(snapshot, passphrase)

    def test_local_rotation_never_deletes_the_newest_recovery_point(self):
        files = []
        for index in range(4):
            item = self.output / f"sparkle-gen3-20261014T00000{index}Z-{index}.sqlite3.gpg"
            item.write_bytes(b"fixture")
            os.chmod(item, 0o600)
            os.utime(item, (1000 + index, 1000 + index))
            files.append(item)
        rotate_local(self.output, 2)
        remaining = sorted(self.output.glob("sparkle-gen3-*.sqlite3.gpg"))
        self.assertEqual(len(remaining), 2)
        self.assertEqual({p.name for p in remaining}, {files[2].name, files[3].name})

    def test_rotation_requires_at_least_one_recovery_point(self):
        with self.assertRaises(BackupError):
            rotate_local(self.output, 0)


if __name__ == "__main__":
    unittest.main()
