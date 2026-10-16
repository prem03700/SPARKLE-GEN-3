# SPARKLE GEN-3 — Research Workspace Audit

Date: 2026-10-16

## Existing infrastructure

The Python API already provides Crossref scholarly metadata search, public web search with provider fallback, and explicit source-text retrieval. This change reuses those APIs and the existing `workspaceHistory` persistence; it does not introduce a duplicate research or Knowledge store.

Crossref results are bibliographic metadata, not full-text papers. Retrieved public web content remains unverified publisher text. Search/provider errors are surfaced rather than replaced with fabricated results.

## Changes in this branch

- Persist query, provider, up to eight complete result records, and retrieved excerpt with the existing Research workspace history record.
- Restore the latest opened/search session after local initialization and after server workspace refreshes.
- Add Research history cards with open and confirmation-gated delete controls.
- Export current retrieved evidence as Markdown with source URLs and metadata/snippets, and an explicit note that the export is not a verified literature review.
- Improve accessible progress and empty-result messaging.
- Add a regression test for saved-session rendering and action controls.

## Verification

- `npm run check`: passed.
- `npm test`: 59 tests passed.
- `git diff --check`: passed.
- No live external provider round-trip or manual visual browser acceptance was performed for this branch.

## Remaining limitations

- Public-search source IDs are held in server memory and can expire; saved snapshots preserve URLs and result metadata, but a new search may be needed before retrieving old source text.
- Explicit cross-result deduplication and structured claim-to-source traceability remain future work.
- AI analysis is not yet saved as a versioned standalone research report.
- Real provider/network/rate-limit behavior was not exercised live in this pass.
