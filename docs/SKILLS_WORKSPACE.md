# SPARKLE GEN-3 — Skills workspace

## Status and contract

The Learning & Skills workspace contains two distinct record types:

- **Learning plans** describe a learner's study plan.
- **Reusable skill definitions** are versioned instruction templates. They are not conversations, executable code, tool adapters, or permission grants.

Skill definitions are stored in the existing shared workspace snapshot in the Python/SQLite Personal Core as skills. Bounded run metadata is stored in skillRuns. The normal revision check, device authentication, server validation, and workspace audit remain authoritative. Existing backups without these optional collections remain importable.

## Definition fields

Each definition stores a stable ID, unique case-insensitive name, description, instructions, expected inputs, expected outputs, declared dependencies, descriptive capabilities, enabled state, version, and timestamps. Limits are enforced in the Python workspace normalization boundary. Editing increments the version; prior run records retain the version they used. Removing a definition leaves existing run history intact.

The UI supports create, view, search, edit, enable/disable, remove, sample-input testing, manual invocation, and per-definition export. Export contains only the selected definition; it excludes conversation history, run history, tokens, and credentials.

## Invocation and security

A skill may be invoked using its UI button or from Chat with this explicit syntax:

@skill Skill Name: request or input

The selected definition's instructions, declared input/output contract, dependencies, and capabilities are included in the user message passed to the existing authenticated model route. The ordinary conversation remains a separate record from the skill definition; a run record tracks status, input, definition version, and timestamps.

The skills feature does **not** dispatch tools. Capability text is descriptive, not authority. Arbitrary code, shell, filesystem operations, simulator execution, and external writes remain disabled unless supported by existing, separately approved integration boundaries. The prompt tells the model to disclose unavailable dependencies/capabilities and to follow existing approval requirements. A skill definition cannot grant itself permissions.

## Supported vs. not implemented

- Supported: persistent skill CRUD, catalog search, versioned edits, enable/disable, explicit invocation, sample-input invocation, run status/history, and definition export.
- Not implemented: isolated sandbox execution of a skill's own code, automated tool chaining, machine-enforced dependency installation, imported skill definitions, or independent per-skill tool grants. A sample test uses the normal model route; it is not a sandbox or a guarantee of deterministic output.
- Natural-language invocation is explicit (@skill Name: ...), not heuristic auto-matching on arbitrary prose. This avoids silently applying a potentially unintended procedure.

## Verification

Run:

- node --check src/app.js
- node --check src/domains/learning/view.js
- node --test
- python3 -m unittest tests.test_personal_core -v
- python3 -m unittest tests.test_server.PrivateServerTests.test_pairing_and_persistent_workspace_roundtrip -v
- npm run test:browser

The browser workflow test covers catalog creation, search, enable/disable, edit/version increment, and confirmed removal. Provider-backed invocation requires a paired device and a configured reachable model provider; that external round-trip is not claimed by these UI tests.
