import json
import sqlite3
import unittest

from personal_core import (
    WorkspaceValidationError,
    normalize_workspace_payload,
    read_workspace,
    save_workspace,
)


DEFAULT_DATA = {name: [] for name in (
    "chat", "conversations", "workspaceChats", "tasks", "goals",
    "knowledge", "projects", "researchDrafts", "learningPlans", "labDrafts",
)}
DEFAULT_PREFS = {"theme": "light", "density": "Comfortable", "accent": "#53684d", "memoryEnabled": False}


class PersonalCoreServiceTests(unittest.TestCase):
    def setUp(self):
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.con.execute("""CREATE TABLE workspace(
            id INTEGER PRIMARY KEY CHECK(id=1), data_json TEXT NOT NULL,
            prefs_json TEXT NOT NULL, updated_at TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 0)""")
        self.con.execute(
            "INSERT INTO workspace(id,data_json,prefs_json,updated_at,revision) VALUES(1,?,?,?,0)",
            (json.dumps(DEFAULT_DATA), json.dumps(DEFAULT_PREFS), "initial"),
        )
        self.con.commit()
        self.audit = []

    def tearDown(self):
        self.con.close()

    def audit_writer(self, connection, event_type, device_id, summary):
        self.audit.append((event_type, device_id, summary))

    def test_normalize_requires_known_collections_and_bounds_collection_size(self):
        with self.assertRaisesRegex(WorkspaceValidationError, "schema"):
            normalize_workspace_payload({"unknown": []}, {}, DEFAULT_DATA, DEFAULT_PREFS)
        with self.assertRaisesRegex(WorkspaceValidationError, "Invalid collection: tasks"):
            normalize_workspace_payload({**DEFAULT_DATA, "tasks": [None] * 10001}, {}, DEFAULT_DATA, DEFAULT_PREFS)

    def test_normalize_fills_missing_collections_and_filters_preferences(self):
        data, prefs = normalize_workspace_payload(
            {"tasks": [{"id": "t1"}]},
            {"theme": "dark", "density": "Compact", "accent": "#ABCDEF", "memoryEnabled": True, "extra": "ignored"},
            DEFAULT_DATA, DEFAULT_PREFS,
        )
        self.assertEqual(data["tasks"], [{"id": "t1"}])
        self.assertEqual(data["goals"], [])
        self.assertEqual(prefs, {"theme": "dark", "density": "Compact", "accent": "#ABCDEF", "memoryEnabled": True})

    def test_custom_theme_and_appearance_preferences_are_bounded_and_normalized(self):
        palette = {
            "name": "Robotics Lab", "bg": "#101820", "surface": "#1b2836",
            "surface2": "#26394a", "text": "#edf4fa", "muted": "#a9bdcd",
            "line": "#385064", "sidebar": "#0d1924", "bubble": "#26394a",
            "accent": "#56d8d1",
        }
        data, prefs = normalize_workspace_payload(
            DEFAULT_DATA,
            {
                "theme": "Robotics Lab",
                "customThemes": [palette, {"name": "Invalid", "accent": "url(javascript:alert(1))"}],
                "appearance": {"fontSize": 19, "radius": 24, "sidebar": "bordered",
                               "message": "outlined", "contrast": "high", "motion": "reduced"},
            },
            DEFAULT_DATA, DEFAULT_PREFS,
        )
        self.assertEqual(data["tasks"], [])
        self.assertEqual(prefs["theme"], "Robotics Lab")
        self.assertEqual(prefs["customThemes"], [palette])
        self.assertEqual(prefs["appearance"], {
            "fontSize": 19, "radius": 24, "sidebar": "bordered",
            "message": "outlined", "contrast": "high", "motion": "reduced",
        })

    def test_workspace_appearance_is_scoped_validated_and_bounded(self):
        data, prefs = normalize_workspace_payload(
            DEFAULT_DATA,
            {"workspaceAppearance": {
                "chat": {"theme": "ocean", "accent": "#123456", "density": "Compact", "layout": "focused"},
                "research": {"theme": "not-a-theme", "accent": "url(javascript:alert(1))", "density": "huge", "layout": "execute"},
                "unknown-view": {"theme": "midnight", "accent": "#ffffff", "density": "Compact", "layout": "compact"},
            }},
            DEFAULT_DATA, DEFAULT_PREFS,
        )
        self.assertEqual(data["tasks"], [])
        self.assertEqual(prefs["workspaceAppearance"]["chat"], {
            "theme": "ocean", "accent": "#123456", "density": "Compact", "layout": "focused",
        })
        self.assertEqual(prefs["workspaceAppearance"]["research"], {
            "theme": "global", "accent": "", "density": "global", "layout": "default",
        })
        self.assertNotIn("unknown-view", prefs["workspaceAppearance"])

    def test_save_and_read_use_authoritative_revisioned_workspace(self):
        data = {**DEFAULT_DATA, "tasks": [{"id": "t1", "title": "Study"}]}
        result = save_workspace(
            self.con, device_id="phone", expected_revision=0, data=data,
            preferences=DEFAULT_PREFS, updated_at="updated-1", audit_writer=self.audit_writer,
        )
        self.con.commit()
        self.assertEqual(result, {"ok": True, "updated_at": "updated-1", "revision": 1})
        snapshot = read_workspace(self.con)
        self.assertEqual(snapshot["data"]["tasks"][0]["title"], "Study")
        self.assertEqual(snapshot["revision"], 1)
        self.assertEqual(self.audit[-1][0:2], ("workspace.updated", "phone"))
        self.assertTrue(any(event[0] == "workspace.collection_changed" and "collection=tasks" in event[2] for event in self.audit))

    def test_code_file_records_are_bounded_and_typed_workspace_changes_are_audited(self):
        code_file = {"id": "code-1", "kind": "code_file", "name": "main.py", "language": "Python", "content": "print(42)", "updatedAt": "now"}
        data = {**DEFAULT_DATA, "projects": [code_file]}
        normalized, _ = normalize_workspace_payload(data, DEFAULT_PREFS, DEFAULT_DATA, DEFAULT_PREFS)
        self.assertEqual(normalized["projects"][0]["content"], "print(42)")
        with self.assertRaisesRegex(WorkspaceValidationError, "100,000 characters"):
            normalize_workspace_payload({**DEFAULT_DATA, "projects": [{**code_file, "content": "x" * 100001}]}, DEFAULT_PREFS, DEFAULT_DATA, DEFAULT_PREFS)
        with self.assertRaisesRegex(WorkspaceValidationError, "unsupported language"):
            normalize_workspace_payload({**DEFAULT_DATA, "projects": [{**code_file, "language": "Shell"}]}, DEFAULT_PREFS, DEFAULT_DATA, DEFAULT_PREFS)
        result = save_workspace(self.con, device_id="laptop", expected_revision=0, data=data,
                                preferences=DEFAULT_PREFS, updated_at="updated-code", audit_writer=self.audit_writer)
        self.con.commit()
        self.assertTrue(result["ok"])
        event = next(item for item in self.audit if item[0] == "workspace.collection_changed")
        self.assertIn("collection=projects", event[2])
        self.assertNotIn("print(42)", event[2], "audit metadata must not include project file contents")
        self.assertEqual(read_workspace(self.con)["data"]["projects"][0]["name"], "main.py")

    def test_stale_save_records_conflict_without_overwriting_data(self):
        first = {**DEFAULT_DATA, "tasks": [{"id": "t1", "title": "Authoritative"}]}
        save_workspace(
            self.con, device_id="phone", expected_revision=0, data=first,
            preferences=DEFAULT_PREFS, updated_at="updated-1", audit_writer=self.audit_writer,
        )
        self.con.commit()
        stale = {**DEFAULT_DATA, "tasks": [{"id": "t2", "title": "Stale overwrite"}]}
        result = save_workspace(
            self.con, device_id="computer", expected_revision=0, data=stale,
            preferences=DEFAULT_PREFS, updated_at="updated-2", audit_writer=self.audit_writer,
        )
        self.con.commit()
        self.assertFalse(result["ok"])
        self.assertEqual(result["conflict"]["revision"], 1)
        self.assertEqual(read_workspace(self.con)["data"]["tasks"], first["tasks"])
        self.assertEqual(self.audit[-1][0:2], ("workspace.conflict", "computer"))

    def create_proposal_table(self):
        self.con.execute("""CREATE TABLE action_proposals(
            id TEXT PRIMARY KEY, action_type TEXT NOT NULL, title TEXT NOT NULL,
            details TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('proposed','approved','rejected')),
            created_by TEXT NOT NULL, created_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT)""")
        self.con.commit()

    def test_proposal_is_persisted_and_audited_without_execution(self):
        from personal_core import create_action_proposal, list_action_proposals
        self.create_proposal_table()
        proposal = create_action_proposal(
            self.con, proposal_id="p1", action_type="create_task", title="Review plan",
            details="Draft only", device_id="phone", created_at="t1", audit_writer=self.audit_writer,
        )
        self.con.commit()
        self.assertEqual(proposal["status"], "proposed")
        self.assertEqual(list_action_proposals(self.con)[0]["id"], "p1")
        self.assertEqual(self.audit[-1][0:2], ("core.proposal.created", "phone"))
        self.assertNotIn("executed", proposal)

    def test_proposal_validation_rejects_unknown_action_and_unbounded_text(self):
        from personal_core import create_action_proposal
        self.create_proposal_table()
        with self.assertRaisesRegex(WorkspaceValidationError, "Unsupported proposal type"):
            create_action_proposal(self.con, proposal_id="p1", action_type="delete_everything",
                                   title="No", details="", device_id="phone", created_at="t1",
                                   audit_writer=self.audit_writer)
        with self.assertRaisesRegex(WorkspaceValidationError, "160 characters"):
            create_action_proposal(self.con, proposal_id="p2", action_type="create_task",
                                   title="x" * 161, details="", device_id="phone", created_at="t1",
                                   audit_writer=self.audit_writer)

    def test_approved_task_proposal_creates_exactly_one_workspace_record(self):
        from personal_core import create_action_proposal, decide_action_proposal
        self.create_proposal_table()
        create_action_proposal(self.con, proposal_id="p-task", action_type="create_task",
                               title="Study robotics", details="Review forward kinematics", device_id="phone",
                               created_at="t1", audit_writer=self.audit_writer)
        self.con.commit()
        result = decide_action_proposal(self.con, proposal_id="p-task", decision="approved",
                                       device_id="computer", decided_at="t2", audit_writer=self.audit_writer)
        self.con.commit()
        self.assertTrue(result["executed"])
        self.assertEqual(result["execution_result"]["collection"], "tasks")
        snapshot = read_workspace(self.con)
        self.assertEqual(snapshot["revision"], 1)
        self.assertEqual(len(snapshot["data"]["tasks"]), 1)
        self.assertEqual(snapshot["data"]["tasks"][0]["title"], "Study robotics")
        self.assertEqual(snapshot["data"]["tasks"][0]["details"], "Review forward kinematics")
        self.assertTrue(any(event[0] == "core.proposal.executed" for event in self.audit))
        repeated = decide_action_proposal(self.con, proposal_id="p-task", decision="approved",
                                         device_id="phone", decided_at="t3", audit_writer=self.audit_writer)
        self.assertEqual(repeated["status"], "already_decided")
        self.con.commit()
        self.assertEqual(len(read_workspace(self.con)["data"]["tasks"]), 1, "a second decision must not duplicate the record")

    def test_approved_goal_and_knowledge_proposals_write_only_their_named_collection(self):
        from personal_core import create_action_proposal, decide_action_proposal
        self.create_proposal_table()
        for index, (action_type, collection) in enumerate((
            ("create_goal", "goals"), ("update_knowledge", "knowledge")
        ), start=1):
            proposal_id = f"p{index}"
            create_action_proposal(self.con, proposal_id=proposal_id, action_type=action_type,
                                   title=f"Approved {collection}", details="Bounded local write",
                                   device_id="phone", created_at=f"t{index}", audit_writer=self.audit_writer)
            self.con.commit()
            result = decide_action_proposal(self.con, proposal_id=proposal_id, decision="approved",
                                            device_id="computer", decided_at=f"t{index}-decision",
                                            audit_writer=self.audit_writer)
            self.con.commit()
            self.assertTrue(result["executed"])
            self.assertEqual(result["execution_result"]["collection"], collection)
            record = read_workspace(self.con)["data"][collection][-1]
            self.assertEqual(record["title"], f"Approved {collection}")
            self.assertEqual(record["content"] if collection == "knowledge" else record["details"], "Bounded local write")

    def test_rejecting_a_task_proposal_creates_no_record(self):
        from personal_core import create_action_proposal, decide_action_proposal
        self.create_proposal_table()
        create_action_proposal(self.con, proposal_id="p-reject", action_type="create_task",
                               title="Rejected task", details="Should not be created", device_id="phone",
                               created_at="t1", audit_writer=self.audit_writer)
        self.con.commit()
        result = decide_action_proposal(self.con, proposal_id="p-reject", decision="rejected",
                                        device_id="computer", decided_at="t2", audit_writer=self.audit_writer)
        self.con.commit()
        self.assertFalse(result["executed"])
        self.assertEqual(read_workspace(self.con)["data"]["tasks"], [])

    def test_proposal_decision_is_explicit_single_use_and_never_executes_privileged_actions(self):
        from personal_core import create_action_proposal, decide_action_proposal
        self.create_proposal_table()
        create_action_proposal(self.con, proposal_id="p1", action_type="shell_execution",
                               title="Run a command", details="Must remain disabled", device_id="phone",
                               created_at="t1", audit_writer=self.audit_writer)
        self.con.commit()
        approved = decide_action_proposal(self.con, proposal_id="p1", decision="approved",
                                          device_id="computer", decided_at="t2", audit_writer=self.audit_writer)
        self.con.commit()
        self.assertTrue(approved["ok"])
        self.assertFalse(approved["executed"])
        self.assertEqual(approved["status"], "approved")
        self.assertEqual(read_workspace(self.con)["data"]["tasks"], [])
        repeated = decide_action_proposal(self.con, proposal_id="p1", decision="rejected",
                                          device_id="phone", decided_at="t3", audit_writer=self.audit_writer)
        self.assertEqual(repeated["status"], "already_decided")
        with self.assertRaisesRegex(WorkspaceValidationError, "Decision must"):
            decide_action_proposal(self.con, proposal_id="p1", decision="execute",
                                   device_id="phone", decided_at="t4", audit_writer=self.audit_writer)


if __name__ == "__main__":
    unittest.main()
