# GEN-3 implementation status

## Implemented locally

- Static responsive frontend with minimalist design, light/dark mode, collapsible navigation, and specialist workspace concepts.
- Central agent registry at `src/core/agent-registry.js`.
- Frontend action policy at `src/core/action-policy.js`; it is not a substitute for backend authorization.
- Shared initial UI state at `src/core/ui-state.js`.
- Runtime contracts for handoffs and action proposals at `src/core/contracts.js`.
- Handoff proposal builder at `src/core/handoff-service.js`; proposal only, no dispatch or execution.
- Integration catalog at `src/integrations/registry.js`; all integrations disabled.
- Architecture smoke/unit tests in `tests/architecture.test.js`.
- Existing UI now imports the central agent registry and policy modules.

## Intentionally not connected

- Backend / Personal Core
- Model providers
- Persistent database or account service
- Web research and citation provider
- Code execution / shell
- Robotics simulators and experiment compute
- External writes and task/goal creation

## Known limitations

- The current workspace view functions still live in `src/app.js`; extract them into domain modules incrementally rather than duplicating them.
- Browser drafts are mostly transient. Theme preference is stored locally.
- Frontend policy flags are UX guardrails only. Real authorization must be enforced in the backend before integration.
- The Git remote is configured as `origin`; implementation files are being tracked and synchronized as part of the initial scaffold commit.

## Run and test

- `npm test` — architecture contract tests.
- `npm run check` — JavaScript syntax checks.
- `npm start` — serves the static frontend at port 4173.
