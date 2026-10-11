# SPARKLE GEN-3 — Architecture Proposal

**Status:** Frontend prototype and architecture document only  
**Backend:** Not connected  
**Execution:** Disabled  
**Persistence:** Theme preference only, in browser local storage; other drafts are transient  
**Approval gate:** Any backend integration, model call, tool execution, filesystem access, or external mutation requires explicit user approval.

## 1. Product structure

SPARKLE is a personal workspace with one user identity and multiple specialist workspaces. The interface should remain conversation-first, minimalist, accessible, and calm. Light and dark themes are supported; the sidebar collapses; each specialist has a focused interface.

### Primary workspaces
- **Main Assistant** — general conversation, intent clarification, coordination, and explicit handoffs.
- **Research** — literature review, source tracking, evidence synthesis, hypotheses, methodology, and paper drafting.
- **Learning & Skills** — lessons, practice, assessments, mastery checks, projects, and revision.
- **Coding & IDE** — code editor, explanation, debugging, review, refactoring, and test generation. Execution must eventually use an isolated runner.
- **Projects** — requirements, scope, milestones, dependencies, risks, deliverables, and approvals.
- **R&D Lab** — research questions, simulation setup, experiment protocols, data/results, papers, and reproducibility.
- **Knowledge** — user-controlled memory, notes, documents, artifacts, and retrieval provenance.
- **Tasks & Goals** — reviewed commitments and long-term outcomes.
- **Settings** — theme, accessibility, privacy, device, and permission preferences.

## 2. Proposed logical architecture

```text
Web / Desktop / Mobile Clients
          |
          v
Presentation Layer
  - navigation and workspace shells
  - accessible UI components
  - theme and user preferences
  - client-side state and drafts
          |
          v
Application / Interaction Layer
  - conversation orchestration contract
  - workspace-specific use cases
  - explicit handoff requests
  - action proposal and approval UX
          |
          v
Personal Core (NOT IMPLEMENTED / NOT CONNECTED)
  - identity and session boundary
  - permission and policy enforcement
  - memory / knowledge authority
  - task, goal, project, and artifact authority
  - audit and provenance
  - specialist routing and context assembly
          |
          +--> Main Assistant adapter
          +--> Research specialist adapter
          +--> Learning & Skills specialist adapter
          +--> Coding specialist adapter
          +--> Project specialist adapter
          +--> R&D / simulation / experiment adapters
          |
          +--> Optional approved integrations
                - model providers
                - search and citation retrieval
                - isolated code runner
                - simulation adapters
                - data / compute storage
```

This is a target architecture, not a claim that these services currently exist. The current implementation is a static frontend with local interactions.

## 3. Ownership boundaries

| Capability | Authoritative owner | Rule |
|---|---|---|
| Identity and sessions | Personal Core | Clients do not become identity authorities |
| Permissions and approvals | Policy / permission layer | UI visibility is not security enforcement |
| Memory and knowledge | Knowledge service in Personal Core | Specialists request context; they do not create private competing memories |
| Tasks and goals | Personal Core | Never create or update silently from conversation |
| Projects and artifacts | Personal Core / artifact service | Mutations must be attributable and reviewable |
| Assistant routing | Orchestrator | Specialists are replaceable adapters, not separate sources of truth |
| Code execution | Isolated runner | Never execute arbitrary code in the web process |
| Simulation | Explicit simulator adapter | Do not imply a simulation ran unless a real runner confirms it |
| Research sources | Retrieval provider plus provenance layer | Preserve citations and distinguish evidence from generated text |
| Theme | Client preferences | Can be local first; account sync can be added after approval |

## 4. Assistant model

One identity, many specialist workspaces, one authoritative Personal Core.

- Main Assistant coordinates; it does not silently perform privileged actions.
- Specialists are scoped by domain and receive only authorized context.
- A handoff has a declared purpose, input context, expected output, and permission boundary.
- Cross-assistant handoffs are proposed to the user by default. Automatic delegation should only be enabled later through an explicit, bounded preference.
- Different assistants may use different models or the same model with different policies. The product concept must not depend on one vendor.
- Ordinary chat content is non-executable. Tool actions are typed requests, validated by policy, and auditable.

## 5. R&D pipeline

Research question → literature and evidence → hypothesis/model → simulation setup → experiment protocol → execution → analysis → validation/reproduction → paper/report → archive.

Every run should eventually record:
- protocol and parameter values
- dataset and source versions
- code/model version
- environment and dependency snapshot
- random seeds and repetitions
- hardware/compute profile
- logs, outputs, and failure cases
- metrics and uncertainty
- approvals and human decisions

The frontend currently offers design forms only. It does not search literature, launch simulations, run experiments, execute code, or produce validated results.

## 6. Frontend module layout

```text
SPARKLE GEN-3/
├── index.html
├── src/
│   ├── styles.css       # design tokens, responsive layout, light/dark themes
│   └── app.js           # frontend-only view rendering and interactions
└── docs/
    └── GEN3_ARCHITECTURE.md
```

This is intentionally a small static prototype. Before production, split the UI into components, typed domain models, route/view modules, and testable application services. Do not add a backend dependency until separately approved.

## 7. Security and execution boundaries

1. The prototype must not make network requests to a backend or model provider.
2. No code, shell command, filesystem operation, simulation, or experiment is executed.
3. UI approval controls are not a substitute for server-side policy enforcement.
4. External actions require a typed request, authorization check, explicit approval when required, execution, and a verifiable result.
5. No specialist may silently write to tasks, goals, knowledge, or project state.
6. Context passed between workspaces must be purpose-bound and permission-aware.
7. Audit records should record action intent, approving actor, execution identity, result, and artifacts, without logging secrets.
8. Secrets must never be embedded in frontend source.

## 8. Suggested implementation phases

- **Phase 0 — Approved frontend prototype:** navigation, specialist workspaces, themes, IDE concept, Test Case Studio concepts, R&D Lab forms. Current state.
- **Phase 1 — UI engineering:** component boundaries, typed client state, accessibility, unit/UI tests, error states, responsive checks.
- **Phase 2 — Architecture contract review:** API schemas, identity/session boundary, permissions, data ownership, audit model. No live connection until approved.
- **Phase 3 — Personal Core integration:** read-only health/session/context first, with explicit test environment and no privileged actions.
- **Phase 4 — Specialist orchestration:** scoped routing, context assembly, citations, handoff previews, approval gates.
- **Phase 5 — Tool adapters:** isolated code execution, research retrieval, simulator adapters, experiment runner, dataset and artifact management.
- **Phase 6 — Hardening:** threat modeling, authorization tests, audit verification, recovery, export/deletion controls, performance and accessibility tests.

## 9. Acceptance criteria before backend approval

- Every workspace clearly identifies its role and current state.
- No backend requests occur in the frontend-only stage.
- No UI label falsely implies a job, simulation, test, or model call completed.
- Light/dark themes, collapsible navigation, and mobile layout work.
- User can distinguish a draft from a persisted artifact.
- Cross-workspace actions are visible and reviewable.
- No task/goal/project mutation occurs without explicit user action and later policy approval.
- Integration contracts and threat model are reviewed before enabling connections.

## 10. Current implementation truth

The prototype uses static HTML, CSS, and JavaScript. It is not yet a production-grade modular app. The only intended persistence is the theme preference in browser local storage; most form actions show preview messages and do not persist drafts. No backend, model provider, account system, database, code runner, search service, or simulator is connected.
