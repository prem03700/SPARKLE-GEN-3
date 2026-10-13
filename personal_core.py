"""Python Personal Core workspace service.

This is the domain-service boundary for the private SQLite workspace. HTTP
authentication and device identity remain the server's responsibility; this
module does not expose a listener, call a model, execute code, or dispatch agents.
"""
from __future__ import annotations

import json
import secrets
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
