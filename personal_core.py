"""Python Personal Core workspace service.

This is the domain-service boundary for the private SQLite workspace. HTTP
authentication and device identity remain the server's responsibility; this
module does not expose a listener, call a model, execute code, or dispatch agents.
"""
from __future__ import annotations

import json
import secrets
from datetime import date
from typing import Any, Callable


class WorkspaceValidationError(ValueError):
    """A workspace or preferences payload violates the current schema."""


def normalize_workspace_payload(
    data: Any,
    preferences: Any,
    default_data: dict[str, list],
    default_preferences: dict[str, Any],
) -> tuple[dict[str, list], dict[str, Any]]:
    """Validate and normalize a complete workspace snapshot without mutating it."""
    allowed = set(default_data)
    if not isinstance(data, dict) or set(data) - allowed:
        raise WorkspaceValidationError("Workspace data schema is invalid.")
    for collection, records in data.items():
        if not isinstance(records, list) or len(records) > 10_000:
            raise WorkspaceValidationError(f"Invalid collection: {collection}")
    if not isinstance(preferences, dict):
        raise WorkspaceValidationError("Preferences schema is invalid.")

    merged = {name: data.get(name, []) for name in default_data}
    # Copy task records before normalization so the caller's payload is untouched.
    merged["tasks"] = [dict(task) if isinstance(task, dict) else task for task in merged.get("tasks", [])]
    # Tasks remain records in the existing authoritative workspace snapshot.
    # Validate new structured fields while tolerating older minimal records.
    task_ids: set[str] = set()
    for task in merged.get("tasks", []):
        if not isinstance(task, dict):
            raise WorkspaceValidationError("Each task must be an object.")
        identifier = task.get("id")
        if identifier is not None:
            if not isinstance(identifier, str) or not identifier.strip() or len(identifier) > 100:
                raise WorkspaceValidationError("Each task needs a valid ID.")
            if identifier in task_ids:
                raise WorkspaceValidationError("Task IDs must be unique.")
            task_ids.add(identifier)
        if "title" in task and (not isinstance(task["title"], str) or not task["title"].strip() or len(task["title"]) > 160):
            raise WorkspaceValidationError("Task title must contain 1–160 characters.")
        for field, limit in (("details", 2000), ("description", 2000)):
            if field in task and (not isinstance(task[field], str) or len(task[field]) > limit):
                raise WorkspaceValidationError(f"Task {field} must be text no longer than {limit} characters.")
        if "done" in task and not isinstance(task["done"], bool):
            raise WorkspaceValidationError("Task done flag must be boolean.")
        if "status" in task and (not isinstance(task["status"], str) or task["status"] not in {"open", "in-progress", "completed", "cancelled"}):
            raise WorkspaceValidationError("Task status is invalid.")
        if "priority" in task and (not isinstance(task["priority"], str) or task["priority"] not in {"low", "medium", "high", "urgent"}):
            raise WorkspaceValidationError("Task priority is invalid.")
        due_date = task.get("dueDate", "")
        if due_date:
            if not isinstance(due_date, str) or len(due_date) != 10:
                raise WorkspaceValidationError("Task due date must use YYYY-MM-DD.")
            try:
                if date.fromisoformat(due_date).isoformat() != due_date:
                    raise ValueError("non-canonical date")
            except ValueError as exc:
                raise WorkspaceValidationError("Task due date must be a valid YYYY-MM-DD calendar date.") from exc
        tags = task.get("tags", [])
        if isinstance(tags, str):
            tags = [part.strip() for part in tags.split(",") if part.strip()]
            task["tags"] = tags
        if not isinstance(tags, list) or len(tags) > 12 or any(not isinstance(tag, str) or not tag.strip() or len(tag) > 40 for tag in tags):
            raise WorkspaceValidationError("Task tags must contain at most 12 labels of up to 40 characters.")
        for field in ("goalId", "projectId"):
            if field in task and (not isinstance(task[field], str) or len(task[field]) > 100):
                raise WorkspaceValidationError(f"Task {field} must be a short record ID.")
    # Reusable skills are bounded instruction definitions, never executable
    # code or permission grants. Validate at the authoritative server boundary.
    skills = merged.get("skills", [])
    if len(skills) > 200:
        raise WorkspaceValidationError("Skill catalog is limited to 200 definitions.")
    skill_ids, skill_names = set(), set()
    skill_fields = {"name": 80, "description": 300, "instructions": 12000,
                    "inputs": 2000, "outputs": 2000, "dependencies": 1000,
                    "capabilities": 500}
    for skill in skills:
        if not isinstance(skill, dict):
            raise WorkspaceValidationError("Each skill definition must be an object.")
        identifier = skill.get("id")
        if not isinstance(identifier, str) or not identifier.strip() or len(identifier) > 100:
            raise WorkspaceValidationError("Each skill needs a valid ID.")
        if identifier in skill_ids:
            raise WorkspaceValidationError("Skill IDs must be unique.")
        skill_ids.add(identifier)
        for field, limit in skill_fields.items():
            value = skill.get(field, "")
            if not isinstance(value, str) or len(value) > limit:
                raise WorkspaceValidationError(f"Skill {field} must be text no longer than {limit} characters.")
            if field in {"name", "instructions"} and not value.strip():
                raise WorkspaceValidationError(f"Skill {field} is required.")
        normalized_name = skill["name"].strip().casefold()
        if normalized_name in skill_names:
            raise WorkspaceValidationError("Skill names must be unique.")
        skill_names.add(normalized_name)
        if not isinstance(skill.get("enabled", True), bool):
            raise WorkspaceValidationError("Skill enabled flag must be boolean.")
        version = skill.get("version", 1)
        if not isinstance(version, int) or isinstance(version, bool) or not 1 <= version <= 10000:
            raise WorkspaceValidationError("Skill version must be an integer from 1 to 10000.")
        for field in ("createdAt", "updatedAt"):
            value = skill.get(field, "")
            if not isinstance(value, str) or len(value) > 80:
                raise WorkspaceValidationError(f"Skill {field} must be a short timestamp string.")
    runs = merged.get("skillRuns", [])
    if len(runs) > 500:
        raise WorkspaceValidationError("Skill execution history is limited to 500 records.")
    valid_run_statuses = {"running", "succeeded", "failed"}
    for run in runs:
        if not isinstance(run, dict):
            raise WorkspaceValidationError("Each skill run must be an object.")
        if not isinstance(run.get("id"), str) or not run["id"].strip() or len(run["id"]) > 100:
            raise WorkspaceValidationError("Each skill run needs a valid ID.")
        if not isinstance(run.get("skillId"), str) or len(run["skillId"]) > 100:
            raise WorkspaceValidationError("Each skill run needs a valid skill reference.")
        if not isinstance(run.get("skillName", ""), str) or len(run.get("skillName", "")) > 80:
            raise WorkspaceValidationError("Skill run name is invalid.")
        if not isinstance(run.get("input", ""), str) or len(run.get("input", "")) > 4000:
            raise WorkspaceValidationError("Skill run input exceeds 4000 characters.")
        if run.get("status") not in valid_run_statuses:
            raise WorkspaceValidationError("Skill run status is invalid.")
        if not isinstance(run.get("resultSummary", ""), str) or len(run.get("resultSummary", "")) > 800:
            raise WorkspaceValidationError("Skill run result summary exceeds 800 characters.")
        if not isinstance(run.get("error", ""), str) or len(run.get("error", "")) > 400:
            raise WorkspaceValidationError("Skill run error exceeds 400 characters.")
        if not isinstance(run.get("completedAt", ""), str) or len(run.get("completedAt", "")) > 80:
            raise WorkspaceValidationError("Skill run completion timestamp is invalid.")
        if not isinstance(run.get("version", 1), int) or isinstance(run.get("version", 1), bool) or not 1 <= run.get("version", 1) <= 10000:
            raise WorkspaceValidationError("Skill run version is invalid.")
    # Learning records share the workspace snapshot with every other domain.
    # Recompute assessment percentages at the trusted boundary and never accept
    # a mastered flag without a valid learner-reported result plus written evidence.
    plans = json.loads(json.dumps(merged.get("learningPlans", []), ensure_ascii=False))
    merged["learningPlans"] = plans
    if len(plans) > 500:
        raise WorkspaceValidationError("Learning plans are limited to 500 records.")
    plan_ids = set()
    for plan in plans:
        if not isinstance(plan, dict):
            raise WorkspaceValidationError("Each learning plan must be an object.")
        identifier, title = plan.get("id"), plan.get("topic")
        if not isinstance(identifier, str) or not identifier.strip() or len(identifier) > 100:
            raise WorkspaceValidationError("Each learning plan needs a valid ID.")
        if identifier in plan_ids:
            raise WorkspaceValidationError("Learning plan IDs must be unique.")
        plan_ids.add(identifier)
        if not isinstance(title, str) or not title.strip() or len(title) > 180:
            raise WorkspaceValidationError("Learning plan topic must be 1–180 characters.")
        if not isinstance(plan.get("goal", ""), str) or len(plan.get("goal", "")) > 2000:
            raise WorkspaceValidationError("Learning plan goal exceeds 2000 characters.")
        topics = plan.get("topics", [])
        if not isinstance(topics, list) or len(topics) > 200:
            raise WorkspaceValidationError("Each learning plan may contain at most 200 topics.")
        topic_ids = set()
        for topic in topics:
            if not isinstance(topic, dict):
                raise WorkspaceValidationError("Each learning topic must be an object.")
            topic_id, topic_title = topic.get("id"), topic.get("title")
            if not isinstance(topic_id, str) or not topic_id.strip() or len(topic_id) > 100:
                raise WorkspaceValidationError("Each learning topic needs a valid ID.")
            if topic_id in topic_ids:
                raise WorkspaceValidationError("Learning topic IDs must be unique within a plan.")
            topic_ids.add(topic_id)
            if not isinstance(topic_title, str) or not topic_title.strip() or len(topic_title) > 180:
                raise WorkspaceValidationError("Learning topic title must be 1–180 characters.")
            assessments = topic.get("assessments", [])
            if not isinstance(assessments, list) or len(assessments) > 100:
                raise WorkspaceValidationError("Each learning topic may contain at most 100 assessments.")
            valid_assessments = []
            for assessment in assessments:
                if not isinstance(assessment, dict):
                    raise WorkspaceValidationError("Learning assessment must be an object.")
                total, correct = assessment.get("total"), assessment.get("correct")
                evidence = assessment.get("evidence", "")
                if (not isinstance(total, int) or isinstance(total, bool) or not 1 <= total <= 1000
                        or not isinstance(correct, int) or isinstance(correct, bool) or not 0 <= correct <= total):
                    raise WorkspaceValidationError("Learning assessment answer counts are invalid.")
                if not isinstance(evidence, str) or len(evidence) > 1500:
                    raise WorkspaceValidationError("Learning assessment evidence is invalid.")
                valid_assessments.append({**assessment, "score": round(correct / total * 100),
                                          "evidence": evidence, "source": "learner-reported"})
            topic["assessments"] = valid_assessments
            seconds = topic.get("secondsStudied", 0)
            if not isinstance(seconds, (int, float)) or isinstance(seconds, bool) or not 0 <= seconds <= 31536000:
                raise WorkspaceValidationError("Recorded learning time is invalid.")
            evidence_text = topic.get("masteryEvidence", "")
            if not isinstance(evidence_text, str) or len(evidence_text) > 1500:
                raise WorkspaceValidationError("Learning mastery evidence is invalid.")
            has_evidence = any(a["score"] >= 80 and len(a["evidence"].strip()) >= 30 for a in valid_assessments)
            if topic.get("masteryStatus") == "mastered" and not (has_evidence and len(evidence_text.strip()) >= 30):
                topic["masteryStatus"] = "not-mastered"
            elif topic.get("masteryStatus") != "mastered":
                topic["masteryStatus"] = "not-mastered"
            topic["activeSession"] = bool(topic.get("activeSession", False))
            if not topic["activeSession"]:
                topic["activeSince"] = None
            elif not isinstance(topic.get("activeSince"), str):
                topic["activeSession"] = False
                topic["activeSince"] = None
            status = topic.get("status")
            if status not in {"not-started", "in-progress", "assessed", "completed"}:
                topic["status"] = "not-started"
    # Coding & IDE files are durable text records in the shared workspace, not
    # executable artifacts. Enforce their shape and size at the trusted boundary.
    for record in merged.get("projects", []):
        if isinstance(record, dict) and record.get("kind") == "code_file":
            name, language, content = record.get("name"), record.get("language"), record.get("content")
            if not isinstance(name, str) or not name.strip() or len(name) > 120:
                raise WorkspaceValidationError("A code file must have a name of 1–120 characters.")
            if not isinstance(language, str) or language not in {"Python", "C++", "JavaScript", "C", "Text"}:
                raise WorkspaceValidationError("A code file has an unsupported language label.")
            if not isinstance(content, str) or len(content) > 100_000:
                raise WorkspaceValidationError("Code files must contain text no longer than 100,000 characters.")
    clean = dict(default_preferences)
    if isinstance(preferences.get("memoryEnabled"), bool):
        clean["memoryEnabled"] = preferences["memoryEnabled"]
    allowed_themes = {"light", "dark", "system", "aurora", "midnight", "forest", "sunset", "ocean", "lavender", "rose", "sand", "graphite", "mint", "cobalt", "custom"}
    if preferences.get("theme") in allowed_themes:
        clean["theme"] = preferences["theme"]
    if preferences.get("density") in ("Comfortable", "Compact", "Spacious"):
        clean["density"] = preferences["density"]
    accent = preferences.get("accent")
    if (
        isinstance(accent, str)
        and len(accent) == 7
        and accent.startswith("#")
        and all(char in "0123456789abcdefABCDEF" for char in accent[1:])
    ):
        clean["accent"] = accent
    # Presentation-only custom palettes and advanced appearance are bounded
    # and normalized at the authoritative private workspace boundary.
    color_keys = ("bg", "surface", "surface2", "text", "muted", "line", "sidebar", "bubble", "accent")
    custom_themes = preferences.get("customThemes")
    if isinstance(custom_themes, list):
        valid_themes = []
        for theme in custom_themes[:24]:
            if not isinstance(theme, dict):
                continue
            name = theme.get("name")
            if not isinstance(name, str) or not name.strip() or len(name) > 40:
                continue
            if all(isinstance(theme.get(key), str) and len(theme[key]) == 7 and theme[key].startswith("#") and all(c in "0123456789abcdefABCDEF" for c in theme[key][1:]) for key in color_keys):
                valid_themes.append({"name": name.strip(), **{key: theme[key].lower() for key in color_keys}})
        clean["customThemes"] = valid_themes
        selected_theme = preferences.get("theme")
        if isinstance(selected_theme, str) and selected_theme in {theme["name"] for theme in valid_themes}:
            clean["theme"] = selected_theme
    workspace_appearance = preferences.get("workspaceAppearance")
    if isinstance(workspace_appearance, dict):
        allowed_workspaces = {"home", "chat", "tasks", "projects", "research", "knowledge", "learning", "lab", "coding", "progress"}
        allowed_layouts = {"default", "compact", "focused"}
        valid_workspace_appearance = {}
        for key, item in list(workspace_appearance.items())[:10]:
            if key not in allowed_workspaces or not isinstance(item, dict):
                continue
            theme = item.get("theme", "global")
            if not isinstance(theme, str) or len(theme) > 40 or not (theme in allowed_themes or theme == "global"):
                # Named custom themes are permitted only when present in the validated palette list.
                if not (isinstance(theme, str) and theme in {t["name"] for t in clean.get("customThemes", [])}):
                    theme = "global"
            accent = item.get("accent", "")
            if not isinstance(accent, str) or not (len(accent) == 7 and accent.startswith("#") and all(c in "0123456789abcdefABCDEF" for c in accent[1:])):
                accent = ""
            density = item.get("density", "global")
            if density not in {"global", "Compact", "Comfortable", "Spacious"}:
                density = "global"
            layout = item.get("layout", "default")
            if layout not in allowed_layouts:
                layout = "default"
            valid_workspace_appearance[key] = {"theme": theme, "accent": accent.lower(), "density": density, "layout": layout}
        clean["workspaceAppearance"] = valid_workspace_appearance
    appearance = preferences.get("appearance")
    if isinstance(appearance, dict):
        clean["appearance"] = {
            "fontSize": appearance.get("fontSize") if appearance.get("fontSize") in (13, 15, 17, 19) else 15,
            "radius": appearance.get("radius") if appearance.get("radius") in (8, 12, 18, 24) else 12,
            "sidebar": appearance.get("sidebar") if appearance.get("sidebar") in ("solid", "subtle", "bordered") else "solid",
            "message": appearance.get("message") if appearance.get("message") in ("soft", "outlined", "minimal") else "soft",
            "contrast": appearance.get("contrast") if appearance.get("contrast") in ("normal", "high") else "normal",
            "motion": appearance.get("motion") if appearance.get("motion") in ("system", "reduced", "full") else "system",
        }
    return merged, clean


def read_workspace(connection) -> dict[str, Any]:
    """Read the authoritative workspace snapshot from the caller's connection."""
    row = connection.execute(
        "SELECT data_json,prefs_json,updated_at,revision FROM workspace WHERE id=1"
    ).fetchone()
    if row is None:
        raise RuntimeError("The Personal Core workspace has not been initialized.")
    return {
        "data": json.loads(row["data_json"]),
        "preferences": json.loads(row["prefs_json"]),
        "updated_at": row["updated_at"],
        "revision": row["revision"],
    }


def save_workspace(
    connection,
    *,
    device_id: str,
    expected_revision: int,
    data: dict[str, list],
    preferences: dict[str, Any],
    updated_at: str,
    audit_writer: Callable,
) -> dict[str, Any]:
    """Persist one complete snapshot with optimistic concurrency and audit.

    The caller must authenticate the device before invoking this service and
    supply the existing transaction-scoped connection. A stale write records
    a conflict and never overwrites the current revision.
    """
    connection.execute("BEGIN IMMEDIATE")
    current = connection.execute(
        "SELECT revision,updated_at,data_json FROM workspace WHERE id=1"
    ).fetchone()
    if current is None:
        raise RuntimeError("The Personal Core workspace has not been initialized.")
    if expected_revision != current["revision"]:
        audit_writer(
            connection,
            "workspace.conflict",
            device_id,
            f"stale_revision={expected_revision}; current_revision={current['revision']}",
        )
        return {
            "ok": False,
            "conflict": {
                "error": "Workspace changed on another device. Reload server data before saving again.",
                "revision": current["revision"],
                "updated_at": current["updated_at"],
            },
        }

    revision = current["revision"] + 1
    connection.execute(
        "UPDATE workspace SET data_json=?,prefs_json=?,updated_at=?,revision=? "
        "WHERE id=1 AND revision=?",
        (
            json.dumps(data, ensure_ascii=False),
            json.dumps(preferences, ensure_ascii=False),
            updated_at,
            revision,
            expected_revision,
        ),
    )
    previous_data = json.loads(current["data_json"])
    for collection in sorted(data):
        before = previous_data.get(collection, [])
        after = data.get(collection, [])
        if before != after:
            before_count = len(before) if isinstance(before, list) else 0
            after_count = len(after) if isinstance(after, list) else 0
            audit_writer(
                connection,
                "workspace.collection_changed",
                device_id,
                f"collection={collection}; before={before_count}; after={after_count}; revision={revision}",
            )
    audit_writer(
        connection,
        "workspace.updated",
        device_id,
        f"revision={revision}; collections={len(data)}",
    )
    return {"ok": True, "updated_at": updated_at, "revision": revision}


# Approval records are durable proposals only. They never invoke tools or perform actions.
PROPOSAL_TYPES = frozenset({
    "create_task", "create_goal", "update_knowledge", "agent_handoff",
    "external_write", "code_execution", "shell_execution", "robotics_execution",
})
PROPOSAL_STATUSES = frozenset({"proposed", "approved", "rejected"})


def create_action_proposal(
    connection,
    *,
    proposal_id: str,
    action_type: str,
    title: str,
    details: str,
    device_id: str,
    created_at: str,
    audit_writer: Callable,
) -> dict[str, Any]:
    """Persist a bounded user-requested proposal; creation never executes it."""
    if not isinstance(action_type, str) or action_type not in PROPOSAL_TYPES:
        raise WorkspaceValidationError("Unsupported proposal type.")
    title = title.strip()
    details = details.strip()
    if not title or len(title) > 160:
        raise WorkspaceValidationError("Proposal title must contain 1–160 characters.")
    if len(details) > 2000:
        raise WorkspaceValidationError("Proposal details must be at most 2000 characters.")
    connection.execute(
        "INSERT INTO action_proposals(id,action_type,title,details,status,created_by,created_at) "
        "VALUES(?,?,?,?,?,?,?)",
        (proposal_id, action_type, title, details, "proposed", device_id, created_at),
    )
    audit_writer(connection, "core.proposal.created", device_id,
                 f"type={action_type}; proposal={proposal_id}")
    return {
        "id": proposal_id, "action_type": action_type, "title": title,
        "details": details, "status": "proposed", "created_by": device_id,
        "created_at": created_at, "decided_by": None, "decided_at": None,
    }


def list_action_proposals(connection, *, limit: int = 50) -> list[dict[str, Any]]:
    """Return recent proposal metadata, newest first, with a hard upper bound."""
    bounded_limit = max(1, min(int(limit), 100))
    rows = connection.execute(
        "SELECT id,action_type,title,details,status,created_by,created_at,decided_by,decided_at "
        "FROM action_proposals ORDER BY created_at DESC,id DESC LIMIT ?",
        (bounded_limit,),
    ).fetchall()
    return [dict(row) for row in rows]


def decide_action_proposal(
    connection,
    *,
    proposal_id: str,
    decision: str,
    device_id: str,
    decided_at: str,
    audit_writer: Callable,
) -> dict[str, Any]:
    """Record a decision; execute only an approved bounded local-record operation."""
    if decision not in ("approved", "rejected"):
        raise WorkspaceValidationError("Decision must be approved or rejected.")
    connection.execute("BEGIN IMMEDIATE")
    row = connection.execute(
        "SELECT id,action_type,title,details,status,created_by FROM action_proposals WHERE id=?",
        (proposal_id,),
    ).fetchone()
    if row is None:
        return {"ok": False, "status": "not_found"}
    if row["status"] != "proposed":
        return {"ok": False, "status": "already_decided", "current_status": row["status"]}

    # Only these tightly bounded, local record operations are executable after
    # explicit approval. Privileged actions and integrations remain disabled.
    executed = False
    execution_result = None
    safe_collection = {"create_task": "tasks", "create_goal": "goals", "update_knowledge": "knowledge"}.get(row["action_type"])
    if decision == "approved" and safe_collection:
        workspace = connection.execute(
            "SELECT data_json,revision FROM workspace WHERE id=1"
        ).fetchone()
        if workspace is None:
            raise RuntimeError("The Personal Core workspace has not been initialized.")
        data = json.loads(workspace["data_json"])
        records = data.get(safe_collection)
        if not isinstance(records, list) or len(records) >= 10_000:
            raise WorkspaceValidationError("The target workspace collection is unavailable or full.")
        record_id = "core-" + safe_collection.rstrip("s") + "-" + secrets.token_hex(12)
        if safe_collection == "knowledge":
            record = {"id": record_id, "title": row["title"], "content": row["details"], "createdAt": decided_at}
        else:
            record = {"id": record_id, "title": row["title"], "details": row["details"], "done": False, "createdAt": decided_at}
        records.append(record)
        next_revision = workspace["revision"] + 1
        connection.execute(
            "UPDATE workspace SET data_json=?,updated_at=?,revision=? WHERE id=1 AND revision=?",
            (json.dumps(data, ensure_ascii=False), decided_at, next_revision, workspace["revision"]),
        )
        audit_writer(connection, "workspace.updated", device_id,
                     f"revision={next_revision}; approved_core_proposal={proposal_id}; collection={safe_collection}")
        audit_writer(connection, "core.proposal.executed", device_id,
                     f"proposal={proposal_id}; type={row['action_type']}; record_id={record_id}")
        executed = True
        execution_result = {"collection": safe_collection, "record_id": record_id, "revision": next_revision}

    connection.execute(
        "UPDATE action_proposals SET status=?,decided_by=?,decided_at=? "
        "WHERE id=? AND status='proposed'",
        (decision, device_id, decided_at, proposal_id),
    )
    audit_writer(connection, "core.proposal.decided", device_id,
                 f"proposal={proposal_id}; decision={decision}; type={row['action_type']}")
    return {
        "ok": True, "id": row["id"], "action_type": row["action_type"],
        "title": row["title"], "status": decision, "created_by": row["created_by"],
        "decided_by": device_id, "decided_at": decided_at,
        "executed": executed, "execution_result": execution_result,
    }
