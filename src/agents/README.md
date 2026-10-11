# Agent management

The central agent configuration registry lives at `src/core/agent-registry.js`. Each agent has a stable ID, display name, owned workspace, purpose, instruction profile identifier, model selection, allowed tools, memory scopes, handoff policy, and enabled state.

Keep agent definitions/configuration centralized. Put domain behavior in its domain module and shared runtime behavior in the orchestration layer. Do not duplicate agent config inside workspace views.

All model and tool connections are disabled in this frontend phase.
