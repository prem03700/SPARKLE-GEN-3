# SPARKLE GEN-3 — Architecture Proposal

**Status:** Private local-first MVP with a Python HTTP API and SQLite workspace store.

**Backend:** Connected for authenticated device sessions, workspace persistence, and provider-selectable text chat.

**Default reasoning model:** NVIDIA Nemotron 3.5 Lightning (`nvidia/nemotron-3.5-lightning-30b-a3b`) through NVIDIA's hosted API. Ollama `qwen3:8b` is an explicit local-only alternative; fallback is disabled.

**Execution:** Arbitrary code, shell, simulation, and external writes remain disabled.

**Persistence:** SQLite on the host plus browser-local state and portable JSON backups.

**Access:** Short-lived one-time pairing code, per-device bearer tokens, and device revocation. The server must not be exposed directly to the public internet.

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
Private API / SQLite persistence (PARTIAL IMPLEMENTATION)
  - per-device identity tokens and session checks
  - shared workspace persistence with revision conflict detection
  - provider adapter (NVIDIA Nemotron default; Ollama optional) and specialist instruction profiles
  - task, goal, project, and note storage
  - remaining: permission-aware memory authority, structured audit/provenance, and unified specialist orchestration
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

This is the target architecture. The current implementation has a real private HTTP API, SQLite persistence, per-device authentication, and a selectable text-model adapter. NVIDIA Nemotron is the default hosted reasoning route; Ollama is an explicit local option. Research retrieval, file ingestion, production memory retrieval, and privileged tool adapters remain future work.

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

The R&D workspace provides model-assisted planning drafts and protocol forms. It does not search literature, launch simulations, run experiments, execute code, or produce validated results. Chat file attachments currently accept small text/source-code files only; the selected provider receives their contents as part of the prompt.

## 6. Frontend module layout

```text
SPARKLE GEN-3/
├── index.html
├── src/
│   ├── app.js                   # shell, navigation, event dispatch
│   ├── styles.css               # shared design system and themes
│   ├── core/                    # agent registry, policy, contracts, handoffs, UI state
│   │   ├── agent-management.js  # centralized validated agent configuration
│   │   └── personal-core/       # in-process service prototype, permission, memory, audit
│   ├── agents/                  # agent-management ownership documentation
│   ├── domains/                 # one view module per workspace/domain
│   │   ├── chat/
│   │   ├── research/
│   │   ├── learning/
│   │   ├── coding/
│   │   ├── projects/
│   │   ├── rd-lab/
│   │   ├── knowledge/
│   │   ├── tasks/
│   │   └── settings/
│   └── integrations/            # provider/runner registry; all disabled
├── tests/
└── docs/
```

The UI remains a lightweight vanilla-JavaScript app. The backend uses only Python's standard library and SQLite to minimize moving parts for a single-owner deployment. Further work should focus on tested capabilities and security, not adding abstractions without a concrete need.

## 7. Security and execution boundaries

1. The browser may call only the same-origin private API; the backend calls the selected provider. NVIDIA credentials remain server-side; Ollama traffic stays on loopback.
2. No arbitrary code, shell command, filesystem operation, simulation, or experiment is executed by SPARKLE.
3. The server authenticates device requests and limits API routes; UI approval controls are not a substitute for server-side authorization.
4. External actions require a typed request, authorization check, explicit approval when required, execution, and a verifiable result.
5. No specialist may silently write to tasks, goals, knowledge, or project state.
6. Context passed between workspaces must be purpose-bound and permission-aware.
7. Audit records should record action intent, approving actor, execution identity, result, and artifacts, without logging secrets.
8. Secrets must never be embedded in frontend source.

## 8. Suggested implementation phases

- **Phase 0 — Local-first workspace:** navigation, specialist workspaces, themes, task/goal/notes CRUD, local AI, and backups. Implemented as an MVP.
- **Phase 1 — Private service:** authenticated API, SQLite persistence, pairing, device revocation, local model adapter, and revision conflict detection. Implemented in part.
- **Phase 2 — Reliability:** automated browser tests, conflict/recovery tests, service startup verification, accessibility, and real-device validation. In progress.
- **Phase 3 — Personal Core integration:** replace scattered server handlers with the single permission-aware service authority; add audited context assembly and typed mutation proposals.
- **Phase 4 — Specialist orchestration:** scoped routing, context assembly, citations, handoff previews, approval gates.
- **Phase 5 — Tool adapters:** isolated code execution, research retrieval, simulator adapters, experiment runner, dataset and artifact management.
- **Phase 6 — Hardening:** threat modeling, authorization tests, audit verification, recovery, export/deletion controls, performance and accessibility tests.

## 9. Acceptance criteria before considering GEN-3 ready

- Every workspace clearly identifies its role and current state.
- Browser API calls stay same-origin and require authentication for private data.
- No UI label falsely implies a job, simulation, test, or model call completed.
- Light/dark themes, collapsible navigation, and mobile layout work.
- User can distinguish a draft from a persisted artifact.
- Cross-workspace actions are visible and reviewable.
- No task/goal/project mutation occurs without explicit user action and later policy approval.
- Integration contracts and threat model are reviewed before enabling connections.

## 10. Personal Core prototype boundary

The centralized agent manager at `src/core/agent-management.js` validates agent configuration changes and defaults to proposals; applying a change is in-memory only. Authenticated text inference supports NVIDIA Nemotron by default and explicit Ollama selection. Tool execution and privileged external integrations remain disabled.

The first Personal Core service façade now exists under `src/core/personal-core/`. It coordinates in-process repository operations, action-policy decisions, handoff proposals, and an ephemeral audit log. It is not an HTTP server and is not wired to the frontend. It has no database, authentication, external model, or persistence. All state is lost when its process ends. This is an architectural seam and testable prototype, not production authorization.

## 11. Model-provider parity and voice boundary

The default text route now matches GEN-2's primary reasoning/planning/coding provider: NVIDIA Nemotron 3.5 Lightning (`nvidia/nemotron-3.5-lightning-30b-a3b`) through the NVIDIA hosted chat-completions API. Credentials are read from server environment variables only, and the provider is not silently changed if it fails. Ollama `qwen3:8b` remains an explicit local-only choice (`SPARKLE_MODEL_PROVIDER=ollama`). NVIDIA mode sends prompts and explicitly opted-in Knowledge snippets to NVIDIA; this must remain visible to the user.

Do not conflate the text model with GEN-2's separate `nvidia/nemotron-voicechat` realtime speech model. GEN-2's Nemotron VoiceChat transport was observed live, but its production gate remained closed because the hosted route did not reliably emit the required PersonalAgent function delegation. GEN-2's accepted production voice route was Gemini Live. GEN-3 currently implements the Nemotron **text** adapter only; realtime voice transport, microphone capture, streamed audio, interruption, tool delegation, and authorization-safe acceptance are not implemented here. Voice must remain unavailable until those components pass real provider acceptance.

## 12. Current implementation truth

The app uses HTML, CSS, JavaScript, a Python standard-library server, and SQLite. The default text model is NVIDIA Nemotron via its hosted API; Ollama can be selected explicitly for local inference. Workspace data persists on the host and is shared by authenticated paired devices. Stale writes are rejected and can be reloaded, but there is no automatic merge. This remains a private MVP, not a fully hardened product: Physical-device CA trust/HTTPS acceptance, general web search/full-text retrieval, file ingestion, semantic memory, and secure tool runners remain incomplete. Explicit Crossref scholarly metadata search is available through an authenticated server route. The server refuses non-loopback HTTP binding and supports TLS using owner-controlled certificate/key files. Current host TLS uses a local CA at `~/.config/sparkle/gen3-tls/ca.crt`; the CA private key and server private key are mode `0600`, excluded from the repository, and must never be copied to client devices.
