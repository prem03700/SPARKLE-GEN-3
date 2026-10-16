# Settings and Themes Audit

## Scope

This branch isolates Settings and Themes changes from the shared development worktree. It does not include changes from other workspace owners.

## Changes

- Added an explicit save action for the opt-in Knowledge-memory preference, including local storage failure feedback and the existing private sync path.
- Added a global appearance reset that restores the default theme, density, and advanced appearance while retaining per-workspace overrides.
- Made custom-theme preview non-destructive: preview no longer creates a saved palette, changes the active theme, or persists the proposed palette.
- Added contrast validation to custom palette creation and imported theme validation (4.5:1 for primary text surfaces; 3:1 for muted text and accent).
- Kept image analysis local and explicitly described it as heuristic structural analysis, not semantic vision or exact reconstruction. Analysis now respects the selected 2D/3D mode and stores proposed advanced appearance in a preview state until the user saves.
- Revoke replaced image object URLs and display the selected source filename.

## Verification

- `npm run check` — passed.
- `npm test` — 58 tests passed.
- `python3 -m unittest discover -s tests -p 'test_*.py'` — passed (see command exit status).
- `npm run test:browser` — passed, including Settings save preference and custom-theme preview regression assertions, responsive layout, and application workflows.
- `git diff --check` — passed.

No provider credentials were read or changed. No live provider or physical-device verification was performed. Image-analysis behavior was tested through the existing browser workflow; it remains a local heuristic rather than a generated or semantically understood theme.
