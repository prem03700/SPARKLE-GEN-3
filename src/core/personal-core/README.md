# Personal Core prototype and Python workspace service

The JavaScript modules in this directory remain an in-process proposal/policy prototype and are **not** the trusted backend or persistent workspace repository. A first production-boundary slice now lives in the root-level Python module `personal_core.py`: the authenticated Python server uses it to normalize workspace snapshots, read the authoritative SQLite workspace, and persist revision-checked writes with audit events. The HTTP server still owns device authentication; the Python service does not create a second database or bypass authentication.

## Ownership
- `personal-core.js`: application-service façade and use-case coordination.
- `permission-service.js`: action decision policy prototype.
- `memory-store.js`: replaceable in-memory repository interface.
- `audit-service.js`: in-memory audit event interface.
- `index.js`: public module exports.

## JavaScript prototype limitations
- Records held by the JavaScript memory store disappear when the process ends and are not the authoritative workspace.
- The JavaScript policy function is a prototype, not an authorization boundary. Production permissions must be enforced in the trusted Python backend.
- Assistant handoffs remain proposals only; this module never dispatches an assistant.
- Do not put secrets or sensitive production data in this module.

## Python service boundary
- `personal_core.py` validates and normalizes the existing workspace schema, reads the SQLite-backed snapshot, and saves snapshots using optimistic revision checks and the existing audit writer.
- Durable action proposals can be created, listed, and explicitly approved/rejected through authenticated API routes and the paired-device Settings panel. Proposals are audit-logged and single-decision. Approval can create one local task, goal, or Knowledge record atomically with the decision; privileged actions and external integrations remain unexecuted.
- The service expects a caller-supplied, transaction-scoped SQLite connection. HTTP authentication stays in `server.py`; callers must authenticate before invoking writes. Revision-checked workspace saves emit per-collection change audit events containing only collection names, record counts, and revision—not record contents. Saved Coding & IDE files are bounded text records validated at this trusted boundary; they are never executed.
- The workspace is still one owner-controlled snapshot, not a multi-user identity system. Agent proposal execution, per-record authorization scopes, semantic memory, and broader Personal Core use cases remain unimplemented.

## Next integration work
Keep the Python service as the single workspace authority. Next, expand typed domain operations and richer agent-handoff proposals, then add per-record authorization scopes and explicit cross-device acceptance. Do not expose an unauthenticated endpoint or dispatch agent actions from the browser.
