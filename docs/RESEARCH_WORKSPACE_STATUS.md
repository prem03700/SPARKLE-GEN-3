# SPARKLE GEN-3 — Research Workspace Audit

Date: 2026-10-16

## Current state

- Authenticated Python API routes already provide Crossref scholarly metadata search, public web search with Bing then DuckDuckGo fallback, and explicit HTML source retrieval.
- Retrieval uses bounded requests, HTTPS-only public-host validation, redirect blocking and pinned DNS resolution; search/source errors are returned rather than replaced with fabricated results.
- Crossref returns bibliographic metadata, not paper full text. Public web retrieval returns bounded readable page text and publisher-supplied metadata marked unverified.
- Research questions, workspace history, Knowledge notes and search snapshots use the existing workspace persistence/sync path. No second Knowledge store or research database was introduced.

## Changes in this audit

- Search sessions now retain the query, provider, up to eight complete result records, and any retrieved source excerpt inside the existing `workspaceHistory` collection.
- The latest saved research search is restored from local workspace data on startup.
- Added Research UI history cards with Open session and confirmed Delete actions.
- Added Markdown evidence export that labels the output as search evidence, preserves source URLs and metadata/snippets, and explicitly avoids presenting generated analysis as verified fact.
- Added accessible, step-oriented progress messaging and clearer empty-result messaging for searches.

## Verification

- `npm run check`: passed after changes.
- `npm test`: 58/58 passed.
- `npm run test:server`: 84 tests passed.
- `git diff --check`: passed.
- `npm run test:browser`: failed at an existing backup-export assertion before completing the suite. The test expects 11 workspace collections, while the current working tree exports 13, including `skills` and `skillRuns`. This is outside Research ownership; no test or unrelated workspace code was changed to hide the mismatch. The browser run had already passed its initial Crossref result/link and Knowledge-save checks before reaching that assertion.
- No live external search-provider round-trip or manual visual browser acceptance was performed in this audit. Provider connectivity remains dependent on outbound network access and upstream availability.

## Remaining gaps / dependencies

- Public search source IDs are cached in server memory and expire; old sessions retain source links and result snapshots, but an expired source ID may require a fresh search before text retrieval.
- Source-to-claim mapping is not yet a structured evidence graph. AI analysis is still a chat response and is not automatically persisted as a versioned research report.
- Research history is bounded by the existing workspace history retention limit. The current app's backup-export/browser-test collection mismatch should be resolved by the owner of the backup workflow, not by Research.
- Real-provider failure modes are covered partly by server error handling and unit tests, but upstream rate-limit/network behavior has not been exercised live in this pass.

No commits, pushes, staging, resets, cleans, service restarts, deployment changes, or protected-file access were performed.
