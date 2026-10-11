# Personal Core prototype

This module defines the first application-service boundary for SPARKLE GEN-3. It is **not connected to the UI, an HTTP server, a model, or a database**.

## Ownership
- `personal-core.js`: application-service façade and use-case coordination.
- `permission-service.js`: action decision policy prototype.
- `memory-store.js`: replaceable in-memory repository interface.
- `audit-service.js`: in-memory audit event interface.
- `index.js`: public module exports.

## Current limitations
- Data disappears when the process ends.
- No identity provider, authentication, authorization server, network listener, persistence, encryption, migrations, or external integrations.
- The policy function is a prototype only. Production permissions must be enforced in a trusted backend.
- Assistant handoffs are proposals only; this module never dispatches an assistant.
- Do not put secrets or sensitive production data in this module.

## Future implementation seam
Keep the service API stable while replacing in-memory storage with repositories and placing the service behind an authenticated API only after explicit approval.
