# Progress workspace

## Data ownership

Progress is a read-only aggregate view over the existing workspace payload. It does not create a new database or maintain duplicate authoritative counts. In a paired session, the existing `/api/data` persistence and revision-conflict behavior remains authoritative; local-only sessions use the existing browser persistence.

## Metric definitions

- **Tasks completed:** tasks where `done === true` or `status === "completed"` divided by all saved task records. This accommodates older records where the status and boolean may not both have been updated.
- **Goals completed:** goals where `done === true` or `status === "completed"` divided by all saved goals.
- **Denominators:** include all saved records in each category, including paused or archived records. This makes the denominator stable and explicit. Empty categories show `0 / 0` and a 0% progress bar; the UI also labels the category as empty.
- **Mastered topics:** topic records marked `masteryStatus: "mastered"` with at least one structurally valid assessment scoring at least 80% and written evidence of at least 30 non-whitespace characters. Scores are learner-reported, not independently verified.
- **Study time:** sum of non-negative `secondsStudied` values across saved learning topics, displayed as whole minutes. The number of valid assessments is a separate count; malformed assessment records are excluded from that count.
- **Activity range:** `All`, `7 days`, `30 days`, and `90 days` filters apply to dated workspace-history events, completed goal milestones, and learning assessments. The lower time boundary is inclusive. Invalid, missing, and future timestamps are excluded. Workspace totals are not date-filtered.
- **Recent activity:** only persisted workspace-history events, completed milestones with a `completedAt` timestamp, and learning assessments with a `createdAt` timestamp are shown. Record `updatedAt`/`createdAt` values are not re-labelled as activity because that would imply an event log that the app does not currently record.

## Navigation and accessibility

Metric cards and completion rows navigate to their owning workspace through the existing `data-view` navigation mechanism. Progress bars expose accessible labels and numeric values. The activity filter has an explicit label, and metric cards are keyboard-operable buttons.

## Known limitations / dependencies

- Activity history is only as complete as the existing workspace event writers. Some CRUD operations (especially task/goal edits and deletes) do not yet write a history event, so Progress intentionally does not claim to be a complete audit log.
- Navigation opens the owning workspace rather than selecting a specific record; deep-link selection is not yet supported by the current workspace routing contracts.
- Project milestones are not represented consistently in the current project record shape. Goal milestone completion is included when `completedAt` exists.
- Learning mastery changes are represented through persisted assessment events; the UI does not infer mastery changes from a current status alone.
