# Learning workspace status — 2026-10-16

## Scope and architecture

Learning uses the existing `learningPlans` collection inside the revisioned SQLite workspace. It does not introduce a second database or new service. Browser-local records continue to work when unpaired; paired records use the existing authenticated `/api/data` revision-checked sync.

## Implemented

- Create a learning plan with a target outcome, level, and optional ordered topics.
- Add, edit, and remove topics without removing the parent plan. Topic IDs and order are persisted.
- Start/resume and pause study sessions. Elapsed time is recorded on pause; a page reload pauses an interrupted timer and leaves the topic resumable.
- Record assessment counts, written evidence, and feedback. Percentages are calculated from actual correct/total values; records are labeled learner-reported.
- Backend validation bounds plan/topic/assessment counts, validates IDs and answer counts, recalculates scores, and refuses mastery status unless a valid assessment reaches 80% with at least 30 characters of written assessment evidence and mastery evidence.
- Suggested revision dates use a one-day interval after results below 80% and a seven-day interval at or above 80%. Revision can be started manually through the existing Learning assistant.
- Link plans to existing Goals and create a Tasks & Goals task from the next unfinished topic. Progress derives mastered-topic, study-time, and assessment totals from existing records.
- Backup restore retains topic and assessment history, recomputes scores, removes invalid mastery flags, and deliberately pauses active timers.

## Important limitations

- Assessment counts and written evidence are learner-reported. The system does not independently grade an assessment or verify an artifact, so the UI explicitly describes the evidence as self-reported.
- The Learning assistant can teach, quiz, and provide feedback in its conversation, but it does not silently write assessment results or change mastery.
- Revision dates are persisted recommendations, not push notifications. No reminder/automation integration was found to be wired to Learning in this pass; do not assume reminders are delivered.
- Study time is elapsed wall-clock time between Start/Resume and Pause & save, capped at 12 hours per single session. Pause before leaving to ensure the time is recorded.
- Browser/device and real-provider behavior must be distinguished from isolated automated checks. No live provider assessment, physical-device synchronization, or user-workspace data mutation was performed as part of this code audit.

## Verification

- Node syntax/project checks and view tests cover the Learning UI and action wiring.
- Python Personal Core tests cover score recomputation, mastery evidence requirements, invalid counts, duplicate topic IDs, and non-mutation of caller input.
- `npm run check`: passed. `npm test`: 62/62 passed. `npm run test:server`: 90/90 passed. `npm run test:browser`: passed, including plan creation/edit, ordered topic creation, study-session elapsed-time persistence, assessment score calculation, learner-reported evidence, mastery state, revision date, and existing workspace CRUD/sync/backup regressions. `git diff --check`: passed.
