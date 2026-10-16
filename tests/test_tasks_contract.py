import unittest

from personal_core import WorkspaceValidationError, normalize_workspace_payload
from server import DEFAULT_DATA, DEFAULT_PREFS


class TaskRecordContractTests(unittest.TestCase):
    def normalize(self, tasks):
        data = {**DEFAULT_DATA, "tasks": tasks}
        return normalize_workspace_payload(data, {}, DEFAULT_DATA, DEFAULT_PREFS)[0]["tasks"]

    def test_accepts_structured_task_and_preserves_calendar_date(self):
        task = {
            "id": "task-1", "title": "Study robotics", "details": "Solve dynamics problems",
            "done": False, "status": "in-progress", "priority": "high",
            "dueDate": "2026-10-31", "tags": ["study", "robotics"],
            "goalId": "goal-1", "projectId": "project-1",
        }
        self.assertEqual(self.normalize([task]), [task])

    def test_rejects_invalid_calendar_date(self):
        with self.assertRaisesRegex(WorkspaceValidationError, "valid YYYY-MM-DD"):
            self.normalize([{"id": "task-1", "title": "Bad date", "dueDate": "2026-02-30"}])

    def test_rejects_duplicate_task_ids(self):
        with self.assertRaisesRegex(WorkspaceValidationError, "Task IDs must be unique"):
            self.normalize([{"id": "same", "title": "First"}, {"id": "same", "title": "Second"}])

    def test_rejects_invalid_priority_and_status(self):
        for field, value in (("priority", "critical-ish"), ("status", "finished-ish")):
            with self.subTest(field=field), self.assertRaises(WorkspaceValidationError):
                self.normalize([{"id": "task-1", "title": "Task", field: value}])

    def test_normalizes_legacy_comma_separated_tags_without_changing_existing_shape(self):
        task = {"id": "task-1", "title": "Legacy", "tags": "one, two"}
        normalized, _ = normalize_workspace_payload({**DEFAULT_DATA, "tasks": [task]}, {}, DEFAULT_DATA, DEFAULT_PREFS)
        self.assertEqual(normalized["tasks"][0]["tags"], ["one", "two"])
        self.assertEqual(task["tags"], "one, two")


if __name__ == "__main__":
    unittest.main()
