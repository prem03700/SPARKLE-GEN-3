# SPARKLE GEN-3 — Tasks workspace implementation status

Date: 2026-10-16

## Scope and current implementation

Tasks continue to use the existing `tasks` collection in the authoritative Personal Core workspace snapshot and SQLite-backed `/api/data` revision flow. No separate task database or scheduler was introduced.

Implemented in this pass:
- Task list with immediate client-side search, status filtering, and deterministic due-date / created-date / priority / title sorting.
- Expandable per-task record details, plus a separate selection checkbox so bulk actions cannot confuse selection with completion.
- Task create/edit with title, details, status, priority, local calendar due date, tags, and optional goal/project links.
- Completion and reopening through the existing checkbox; status and legacy `done` are kept in sync by UI mutations.
- Overdue display based on local calendar date and `YYYY-MM-DD` date-only values, avoiding UTC-midnight date drift.
- Explicitly confirmed bulk completion and deletion with selection independent from completion checkboxes.
- Responsive task cards and filters; goal records remain visible in a collapsible section.
- Server-side task field validation in the existing workspace normalization boundary, including unique IDs, title/details bounds, status, priority, due date, tags, and relationship-ID shape. Older minimal records remain accepted.
- Existing revision conflict behavior remains authoritative: stale full-snapshot writes are rejected; no automatic merge is claimed.

## Verification performed

- `node --check src/app.js` — passed.
- `node --check src/domains/tasks/view.js` — passed.
- `npm run check` — passed on the final code.
- `npm test` — 65/65 passed, including task view and legacy-record checks.
- `npm run test:server` — 96/96 passed, including five task schema/date contract tests.
- `npm run test:browser` — passed in headless Chrome, including task metadata edit, calendar date round-trip, tag search, status filtering, complete/reopen transitions, CRUD, reload recovery, revision sync, and server sync. This is automated browser verification, not a manual visual test on a physical mobile device.

## Explicit limitations

- No real reminder scheduler is connected, so tasks do not claim to send reminders.
- Cross-device stale-write conflicts are detected and require reload from server; there is no automatic three-way merge.
- Tasks are part of the existing shared snapshot rather than independent per-record API endpoints.
- Related goal/project IDs are stored and shown when the linked record exists. Goal deletion clears its task/plan/project links in the current UI; project deletion does not yet clean up task `projectId` references.
- Learning can create a linked task and now checks the source topic before creating another. Conversations, Research, and Projects do not yet expose dedicated context-to-task creation controls; their assistants do not silently write tasks, consistent with the current approval boundary.
- Device-to-device sync is exercised by the existing isolated browser/server smoke test; no separate physical device was used for this task audit.

## Ownership and integration notes

Only the Tasks view, task-specific interaction paths in `src/app.js`, task styles, Personal Core task validation, and dedicated task tests/docs were intended for this work. `src/app.js`, `personal_core.py`, `src/styles.css`, and several tests already had unrelated uncommitted changes when work began; those changes were preserved. No commit, push, reset, clean, or staging command was run. `source_code.zip`, GEN-1, GEN-2, and Android projects were not accessed.
