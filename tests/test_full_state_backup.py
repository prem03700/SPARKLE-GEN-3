import sqlite3
import tarfile
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

from tools.full_state_backup import (
    BackupError, backup_timestamp, build_bundle, encrypt_verify, prune_local, retained_remote_names, validate_remote, verify_archive,
)

class FullStateBackupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.state = self.root / "state"
        self.config = self.root / "config"
        self.app_data = self.root / "app-data"
        self.output = self.root / "encrypted"
        self.state.mkdir(mode=0o700)
        self.config.mkdir(mode=0o700)
        self.app_data.mkdir(mode=0o700)
        (self.state / "data_environment").mkdir()
        (self.state / "backups").mkdir()
        db = sqlite3.connect(self.state / "data_environment" / "sample.sqlite3")
        db.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)")
        db.execute("INSERT INTO sample(value) VALUES ('test-fixture')")
        db.commit()
        db.close()
        # Sidecars are transient SQLite runtime files; online snapshotting
        # captures committed content into the database snapshot itself.
        (self.state / "data_environment" / "sample.sqlite3-wal").write_bytes(b"stale-wal-fixture")
        (self.state / "data_environment" / "sample.sqlite3-shm").write_bytes(b"stale-shm-fixture")
        (self.state / "application.json").write_text('{"fixture": true}')
        (self.state / "backups" / "old-backup.bin").write_bytes(b"must-not-be-included")
        (self.config / "gen3.env").write_text("fixture-config-not-a-secret")
        (self.config / "gen2.env").write_text("must-not-be-included")
        (self.config / "backup-passphrase").write_text("must-not-be-included")
        (self.config / "server.key").write_text("fixture-key-material")
        try:
            (self.state / "unsafe-link").symlink_to(self.root / "outside-secret")
        except OSError:
            pass
        (self.root / "outside-secret").write_text("outside")

    def tearDown(self):
        self.tmp.cleanup()

    def test_bundle_contains_state_config_and_verified_sqlite(self):
        bundle, db_count = build_bundle(self.state, self.config, self.output)
        self.assertEqual(db_count, 1)
        self.assertEqual(verify_archive(bundle), 1)
        with tarfile.open(bundle, "r:gz") as archive:
            names = set(archive.getnames())
        self.assertIn("sparkle-gen3-recovery/state/data_environment/sample.sqlite3", names)
        self.assertNotIn("sparkle-gen3-recovery/state/data_environment/sample.sqlite3-wal", names)
        self.assertNotIn("sparkle-gen3-recovery/state/data_environment/sample.sqlite3-shm", names)
        self.assertIn("sparkle-gen3-recovery/config/gen3.env", names)
        self.assertIn("sparkle-gen3-recovery/config/server.key", names)
        self.assertNotIn("sparkle-gen3-recovery/config/gen2.env", names)
        self.assertNotIn("sparkle-gen3-recovery/config/backup-passphrase", names)
        self.assertFalse(any("old-backup.bin" in name for name in names))
        self.assertFalse(any("unsafe-link" in name for name in names))
        self.assertEqual(bundle.stat().st_mode & 0o777, 0o600)

    def test_encryption_round_trip_and_private_output(self):
        bundle, _ = build_bundle(self.state, self.config, self.output)
        key = self.root / "fixture-recovery-key"
        key.write_bytes(b"fixture-only-strong-passphrase-for-tests-0123456789")
        key.chmod(0o600)
        encrypted = encrypt_verify(bundle, key)
        self.assertTrue(encrypted.is_file())
        self.assertEqual(encrypted.stat().st_mode & 0o777, 0o600)
        self.assertGreater(encrypted.stat().st_size, 32)

    def test_bundle_includes_live_application_data_database(self):
        db = sqlite3.connect(self.app_data / "sparkle-gen3.sqlite3")
        db.execute("CREATE TABLE app_state (id INTEGER PRIMARY KEY, value TEXT)")
        db.execute("INSERT INTO app_state(value) VALUES ('app-fixture')")
        db.commit()
        db.close()
        (self.app_data / "sparkle-gen3.sqlite3-wal").write_bytes(b"stale-wal-fixture")
        bundle, db_count = build_bundle(self.state, self.config, self.output, self.app_data)
        self.assertEqual(db_count, 2)
        with tarfile.open(bundle, "r:gz") as archive:
            names = set(archive.getnames())
        self.assertIn("sparkle-gen3-recovery/app-data/sparkle-gen3.sqlite3", names)
        self.assertNotIn("sparkle-gen3-recovery/app-data/sparkle-gen3.sqlite3-wal", names)

    def test_rejects_source_symlink(self):
        link = self.root / "state-link"
        link.symlink_to(self.state, target_is_directory=True)
        with self.assertRaises(BackupError):
            build_bundle(link, self.config, self.output)

    def test_rejects_archive_without_sqlite_database(self):
        empty_state = self.root / "empty-state"
        empty_state.mkdir()
        with self.assertRaises(BackupError):
            build_bundle(empty_state, self.config, self.output)

    def test_timestamp_parser_rejects_unrelated_remote_objects(self):
        self.assertIsNotNone(backup_timestamp("sparkle-gen3-fullstate-20261014T094000Z-123.tar.gz.gpg"))
        self.assertIsNone(backup_timestamp("unrelated-important-file.zip"))
        self.assertIsNone(backup_timestamp("sparkle-gen3-fullstate-not-a-date-123.tar.gz.gpg"))

    def test_remote_must_be_the_exact_dedicated_backup_prefix(self):
        self.assertEqual(validate_remote("gdrive:SPARKLE-GEN3-Backups"), "gdrive:SPARKLE-GEN3-Backups")
        self.assertEqual(validate_remote("gdrive:SPARKLE-GEN3-Backups/"), "gdrive:SPARKLE-GEN3-Backups")
        for unsafe in ("gdrive:", "gdrive:somewhere-else", "gdrive:SPARKLE-GEN3-Backups/nested", "/tmp/backups"):
            with self.subTest(remote=unsafe), self.assertRaises(BackupError):
                validate_remote(unsafe)

    def test_tiered_retention_keeps_recent_daily_weekly_monthly_and_ignores_unknowns(self):
        current = date(2024, 1, 1)
        names = []
        index = 0
        while current <= date(2026, 10, 14):
            names.append(f"sparkle-gen3-fullstate-{current.strftime('%Y%m%d')}T120000Z-{index}.tar.gz.gpg")
            current += timedelta(days=1)
            index += 1
        names.append("important-user-file.zip")
        keep = retained_remote_names(names)
        self.assertGreater(len(keep), 7)
        self.assertLessEqual(len(keep), 23)
        self.assertNotIn("important-user-file.zip", keep)
        self.assertTrue(all(backup_timestamp(name) for name in keep))
        self.assertTrue(set(names[-8:-1]).issubset(keep))
        self.assertLessEqual(len(keep), 23)

    def test_local_retention_never_deletes_malformed_or_unrelated_matching_names(self):
        self.output.mkdir(mode=0o700)
        valid = []
        start = date(2025, 1, 1)
        for index in range(40):
            day = start + timedelta(days=index * 10)
            name = f"sparkle-gen3-fullstate-{day.strftime('%Y%m%d')}T120000Z-{index}.tar.gz.gpg"
            (self.output / name).write_bytes(b"fixture")
            valid.append(name)
        malformed = self.output / "sparkle-gen3-fullstate-not-a-date-99.tar.gz.gpg"
        unrelated = self.output / "sparkle-gen3-fullstate-not-our-format.tar.gz.gpg"
        malformed.write_bytes(b"keep-malformed")
        unrelated.write_bytes(b"keep-unrelated")
        retained, deleted = prune_local(self.output)
        self.assertGreater(retained, 0)
        self.assertEqual(deleted, len(valid) - retained)
        self.assertTrue(malformed.exists())
        self.assertTrue(unrelated.exists())

    def test_retention_rejects_zero_windows_and_deduplicates_week_and_month_coverage(self):
        with self.assertRaises(BackupError):
            retained_remote_names([], daily=0)
        names = [
            "sparkle-gen3-fullstate-20260102T120000Z-1.tar.gz.gpg",
            "sparkle-gen3-fullstate-20260102T120000Z-2.tar.gz.gpg",
            "sparkle-gen3-fullstate-20251215T120000Z-3.tar.gz.gpg",
            "sparkle-gen3-fullstate-20251115T120000Z-4.tar.gz.gpg",
            "sparkle-gen3-fullstate-20251015T120000Z-5.tar.gz.gpg",
            "sparkle-gen3-fullstate-20250915T120000Z-6.tar.gz.gpg",
            "notes.txt",
        ]
        keep = retained_remote_names(names, daily=1, weekly=2, monthly=2)
        self.assertEqual(len(keep), 5)
        self.assertNotIn("notes.txt", keep)
        self.assertTrue(all(backup_timestamp(name) is not None for name in keep))

if __name__ == "__main__":
    unittest.main()
