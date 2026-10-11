# SPARKLE GEN-3 implementation status

## Working and verified

- Responsive browser UI with ten workspaces: Main, Research, Learning & Skills, Coding & IDE, Projects, R&D Lab, Knowledge, Tasks & Goals, Progress, and Settings.
- Python standard-library private server with SQLite-backed workspace persistence.
- One-time pairing code available only from the host computer's loopback connection; code expires after ten minutes and is single-use.
- Per-device random bearer tokens, hashed token storage, session checks, device listing, revocation, and sign-out revocation.
- Authenticated workspace API with input validation, strict JSON request framing (rejects missing length and transfer-encoding), request size limits, static-file allowlist, security headers, and revision-based stale-write conflict detection. Provider inference is bounded to two simultaneous calls globally in addition to per-device chat rate limits; unauthenticated health polling caches the upstream provider-availability check for 30 seconds. URL paths are decoded before allowlist checks to block percent-encoded traversal; regression tests cover encoded dot-segments.
- Manual `npm start` binds to loopback by default. The enabled per-user service binds for trusted-LAN access and the server rejects non-private source IPs; public port forwarding and tunnels remain prohibited.
- Provider-selectable text chat wired to NVIDIA Nemotron 3.5 Lightning by default (`nvidia/nemotron-3.5-lightning-30b-a3b`) and Ollama `qwen3:8b` as an explicit local alternative. No silent fallback. NVIDIA API key is read from server environment or a permission-checked owner-only `~/.config/sparkle/gen3.env` file.
- Explicit Crossref scholarly search with bounded DOI-linked metadata, copyable citations, opt-in save to Knowledge, and source metadata available to the research assistant on request. Search queries are not written to audit logs. General web search/full-text retrieval remain unavailable. Other selected-model actions help with coding explanation/review/test ideas, research-question refinement, learning assessments, project planning, and simulation-setup drafting; they do not run code or execute experiments.
- Saved Knowledge notes can be explicitly opted into model context from Settings; a previous Ollama live test verified the model received and recalled a private test note.
- Persisted conversations, tasks, goals, knowledge notes, project briefs, research drafts, learning plans, R&D drafts, and preferences. A read-only Progress dashboard derives task/goal completion rates and recent activity from these records without duplicating or mutating them.
- Edit sent messages, retry a previous response, delete individual conversations, or clear all conversation history with confirmation. A pending response can be stopped from the UI, and client waits time out after 95 seconds. The streaming endpoint monitors client disconnects and closes the active upstream response; automated tests verify this lifecycle, though physical-device cancellation has not yet been tested. Persisted in-flight assistant placeholders are recovered into an explicit interrupted-response message with a Retry affordance after a reload, rather than remaining stuck on “Thinking…” indefinitely. Chat accepts explicitly selected small text/source-code attachments (48 KB and 9,000-character limits); attachment text is shown by filename, included in the model request, retained in the conversation record, and preserved by validated backup restore.
- JSON backup export and validated restore; confirmed workspace clearing.
- Private audit log records pairing, sign-out/revocation, workspace updates/conflicts, and local-model usage metadata; it deliberately omits prompts and responses and retains only the latest 1,000 events.
- HTML escaping for user and model text before rendering.
- Enabled per-user `sparkle-gen3.service` starts the server at login and restarts on failure; GNOME autostart launcher remains as a fallback.
- Audit rerun on 2026-10-11 after Nemotron adapter work: `npm run check` passed; 28 Node tests passed, including interrupted-response recovery, chat-attachment validation/prompt composition, read-only Progress dashboard calculations, and browser voice capability/spoken-text helpers; 28 Python server tests passed, including Crossref query validation, authenticated search, DOI URL validation and query privacy, a real TLS listener/HSTS check, cached provider health checks, fail-closed non-loopback startup, malformed/oversized request bodies, explicit two-device stale-write conflict, provider-concurrency limits, legacy schema migration, expired/concurrent one-time pairing, mocked NVIDIA request/auth handling, protected-key-file permissions, security headers, private-network allowlisting, persistence, sign-out/revocation, audit logging, and encoded-path traversal; browser smoke and `git diff --check` passed.
- Opt-in browser speech mode is implemented as a voice-conversation beta: browser speech recognition sends recognized text through the same authenticated chat endpoint and browser speech synthesis reads the answer. It is not full-duplex streaming voice; browser speech processing can send microphone audio to the browser's speech service. The user can start/stop voice explicitly; switching away from Chat stops the mode. Automated capability/text-cleanup tests cover feature detection and spoken Markdown cleanup, but physical microphone interaction remains to be manually verified. Voice mode checks for a secure browser context before requesting speech, treats browser speech-service network failures as fatal rather than retrying indefinitely, and stops when signing out or leaving Chat.
- Earlier on 2026-10-11, live NVIDIA inference was verified using an isolated SQLite workspace. After disabling internal thinking by default, authenticated `/api/chat/stream` succeeded against a disposable database with 42 text deltas (2.724 s to first delta, 3.908 s total). Two direct provider-only probes completed in under 1.2 s, while another probe timed out. Treat these as initial acceptance samples rather than a stable latency benchmark. The test workspace was automatically discarded and did not modify the user's persistent workspace. The existing protected owner-only NVIDIA credential was copied into `~/.config/sparkle/gen3.env` with mode `0600`; its value was never displayed or written to repository files. After acceptance, `sparkle-gen3.service` was restarted and its live health endpoint now reports `model_provider=nvidia`, `provider_label=NVIDIA Nemotron`, `model=nvidia/nemotron-3.5-lightning-30b-a3b`, and `model_available=true`. A live probe also caught an answer that began with a reasoning-trace style preamble; the system instruction now explicitly asks for concise explanations rather than private chain-of-thought, and a regression test covers that prompt boundary. This is provider acceptance, not a guarantee every answer will obey every style instruction.
- A repeatable, dependency-free headless Chrome smoke test is checked into `tests/browser-smoke.mjs` and exposed as `npm run test:browser`. It uses a temporary copied app/server, isolated SQLite database, and disposable browser profile; verifies all major workspaces render without runtime exceptions, light/dark theme toggling, desktop sidebar collapse, phone-sized navigation without horizontal overflow, pairing, task/goal/learning/project/R&D persistence and sync, browser-local persistence, task recovery after reload, Crossref search/query privacy and citation save, interrupted-response recovery, streamed incremental chat/timing, edit/retry, cancellation, validated backup restore, and confirmed workspace clearing. All temporary files and processes are cleaned up. Latest run passed. This does not exercise physical microphone/speaker hardware or test a second physical device.
- A percent-encoded static-path traversal issue was reproduced during this audit and fixed. The regression test now verifies both lower- and upper-case encoded dot-segments are rejected.

- GEN-2's NVIDIA Nemotron VoiceChat (`nvidia/nemotron-voicechat`) is a separate real-time audio route from its Nemotron text reasoning model. GEN-3 currently offers browser-native speech recognition/synthesis as an opt-in beta; the true full-duplex Gemini Live/Nemotron VoiceChat transport and server-owned voice session lifecycle are not yet integrated. GEN-2's hosted NVIDIA voice route remained blocked from production because required PersonalAgent function delegation was not reliably emitted. Do not mark realtime voice parity as ready until an authorization-safe provider/session path passes live acceptance.

## P0 acceptance register — 2026-10-11

| P0 area | Status | Evidence / boundary |
|---|---|---|
| Authentication, pairing, revocation | Implemented and verified | One-time 10-minute pairing code, single-use concurrency protection, rate limits, hashed bearer-token storage, sign-out and device revocation tests. |
| Input and overload safety | Implemented and verified | Malformed/oversized JSON and ambiguous HTTP framing tests; provider concurrency gate and per-device chat limit. |
| Persistence and recovery | Implemented and verified | SQLite persistence, legacy `revision` migration test, backup/restore browser flow, and automatic recovery of persisted in-flight assistant placeholders. |
| Cross-device data integrity | API-level verified | Two paired tokens exercise stale-revision rejection; conflicts remain explicit and require reload. A second physical device has not yet been acceptance-tested. |
| Live selected model | Live inference verified; broader benchmark pending | After disabling Nemotron thinking by default, authenticated streaming through the real route succeeded in an isolated temporary database (HTTP 200, 42 deltas, 2.724 s first token, 3.908 s total). Two direct provider-only probes completed in 0.569–0.681 s to first token and 0.961–1.134 s total; one direct probe timed out. Broader and physical-device measurements remain open. |
| Encrypted LAN transport | Host verified; physical-device network test blocked | HTTPS is enabled using a private local CA; server fails closed if a non-loopback bind is requested without TLS. Strict CA and IP-SAN verification passed against both loopback and the live LAN endpoint; TLS 1.3, HSTS, CSP, and other security headers were verified. The host listener is `0.0.0.0:4173`, but the phone TCP test times out and the host neighbor entry for the phone is `FAILED`, despite both reporting the same Wi-Fi AP/subnet. Host UFW is active and `/etc/default/ufw` sets `DEFAULT_INPUT_POLICY=DROP`; the specific live allow rules could not be inspected through the current remote command restrictions, so host firewall filtering is also a possible blocker. The user confirmed the phone VPN is disconnected, and read-only Android settings show no always-on VPN or global HTTP proxy. No VPN, firewall, router, or trust settings were changed. Next safe step: test on a trusted private network that permits peer-to-peer traffic, or ask the Wi-Fi administrator to check client isolation/ACLs; effective UFW rules remain unverified because administrator commands are blocked. Only the public CA certificate was copied to Downloads; it has not been installed or trusted. Do not expose the service to the public internet. |
| Physical microphone/speaker | **Not verified** | Automated tests cover browser voice capability and interrupted-response recovery, not physical audio hardware. |

## Known limitations

- HTTPS now encrypts bearer tokens and workspace data in transit. The local CA must be installed/trusted separately on every device before using the LAN URL; the host Chromium trust probe and server-side TLS chain have been verified; phone/tablet CA installation and physical-device access have not yet been verified. Do not port-forward this server or expose it through a public tunnel.
- Cross-device edits use revision checks and detect stale writes; a two-device API test now verifies a stale second-device write cannot overwrite the first device. When a conflict occurs, the user must reload the authoritative server copy. There is no automatic merge.
- Explicit Crossref scholarly metadata search is connected with authenticated access, rate limits, bounded results, DOI-only links, and audit logs that record query length rather than query text. General web search, full-text retrieval, and automatic source-quality verification remain unavailable; users must open and verify original sources.
- Knowledge imports text-readable files up to 250 KB as plain-text notes (Markdown/CSV/JSON are not parsed into structured records). Authenticated private-host extraction now supports text-based PDF (first 30 pages), DOCX, XLSX, and PPTX up to 250 KB, with bounded archive expansion and output limits; scanned-image OCR, legacy Office formats, and semantic search remain unimplemented. PDF/Office extraction uses host-side parsing and never executes document macros. Arbitrary code execution, shell access, robotics simulation, experiment execution, and external write integrations remain disabled.
- The Personal Core service modules remain partly prototype code; the SQLite API is currently the active workspace persistence authority.
- No account system or cloud sync exists; this is a single-owner host with paired devices.
- The per-user systemd service starts with the user's systemd session; it is not a system-wide service that runs before login. Physical second-device acceptance and physical microphone/speaker tests have not been performed by the automated suite.

## Run and test

```bash
cd "/home/prem-macharla/SPARKLE GEN-3"
npm start
npm run check
npm test
npm run test:server
npm run test:browser
```

Open https://localhost:4173 on the host computer. The enabled per-user service is running with TLS on port 4173 and reports the current HTTPS LAN URL in Settings. Use Settings to generate one-time pairing codes. Import/trust the private CA on every client device before pairing; do not expose the service publicly. See README.md and `docs/PRIVATE_DEVICE_TLS.md` for certificate trust and pairing boundaries.


### Retest after Android VPN disconnect — 2026-10-11 09:44 UTC

- User confirmed the Android VPN is already disconnected; Chrome still times out / cannot reach the site.
- Read-only host checks confirm `0.0.0.0:4173` is listening and strict local HTTPS health succeeds with the private CA; health reports the expected LAN URL and selected NVIDIA model available.
- Host route to `10.58.17.255` is directly through `wlp0s20f3`, but host neighbor discovery reports `10.58.17.255 FAILED`.
- Android route table shows `10.58.0.0/19 dev wlan0 src 10.58.17.255`; its neighbor table reports `10.58.17.55 FAILED`, and a TCP probe to `10.58.17.55:4173` returns `No route to host`.
- Both peers can resolve the gateway, but cannot resolve each other. This is strong evidence of peer-to-peer/L2 filtering or another Wi-Fi/client policy, rather than an HTTPS or application failure. It is not definitive proof of client isolation. UFW's effective allow rules remain unverified because the remote terminal policy blocks `sudo`; do not change firewall/router settings. Next safe discriminator: test on a trusted private network that permits peer-to-peer traffic, or ask the current Wi-Fi administrator to check client isolation/VLAN/ACL policy. Keep public exposure disabled.


## Phase 1 acceptance rerun — 2026-10-11 16:27 IST

- `npm run check`: passed (JavaScript syntax and Python compilation).
- `npm test`: 31/31 Node tests passed.
- `npm run test:server`: 30/30 Python server tests passed.
- `npm run test:browser`: passed; covered workspace rendering/navigation, responsive layout, pairing, task/goal/learning/project/R&D persistence, research citations, interrupted-response recovery, streaming, edit/retry, cancellation, backup restore, and confirmed workspace clearing.
- `git diff --check`: passed.
- Live service: `sparkle-gen3.service` is active; strict-CA HTTPS health succeeds on both loopback and `https://10.58.17.55:4173`, with NVIDIA model availability and streaming reported. Unauthenticated `/api/data` and `/api/knowledge/extract` both return HTTP 401.
- Physical-device acceptance is still blocked: Desktop Commander lists no online Android device and `adb devices -l` is empty. Host neighbor discovery for the phone's previously observed address `10.58.17.255` still reports `FAILED`; the phone cannot reach port 4173 on the current Wi-Fi. The host's UFW input default is `DROP`, but effective allow rules are not readable without administrator access. No firewall, VPN, router, certificate-trust, or mobile-project settings were changed.
- Phase 1 is **not yet fully accepted** until a phone can securely reach the host, trust the private CA, pair, sync and persist a workspace change, then successfully sign out and revoke the session. Next discriminator: use a trusted private network with peer-to-peer connectivity, or have the Wi-Fi administrator inspect client isolation/VLAN/ACLs and the host administrator verify the inbound 4173 rule. Do not expose the service publicly.


## Phase 1 — Knowledge document ingestion (started 2026-10-11)

- Added authenticated `/api/knowledge/extract` for PDF, DOCX, XLSX, and PPTX imports. Inputs are limited to 250 KB, Office archive expansion is capped, PDF extraction is limited to 30 pages and 15 seconds, output is capped at 200,000 characters, and audit records include only file extension and extracted character count. The browser imports extracted text into Knowledge; AI context still requires the explicit saved-notes memory setting.
- Added server tests for DOCX text extraction, invalid signatures/types/size, endpoint authentication, and malformed-document handling. `npm run check`, 28 Node tests, 30 Python server tests, browser smoke tests, and `git diff --check` passed after this change.
- Added local keyword search over Knowledge note titles and extracted text, ranking notes by matched terms. This is intentionally labeled keyword matching, not semantic search. Remaining ingestion limits: no OCR for scanned PDFs, no legacy Office formats, no structured spreadsheet/table representation, and no semantic search yet.

## Phase 2 — Conversation reliability and context quality (started 2026-10-11)

### Completed in the working repository

- Extracted server-side conversation context assembly into `build_chat_context`, with explicit specialist role instructions and a bounded 24,000-character history window. The latest user turn is preserved; older turns are dropped before recent turns when the budget is exceeded. A further edge-case fix drops any leading assistant turn left orphaned by the budget boundary, so context starts on a user turn.
- Saved Knowledge is only attached when memory is explicitly enabled and a note has lexical overlap with the latest user message. Removed the previous fallback that injected the two newest notes even when nothing matched, reducing irrelevant context and unnecessary disclosure to the selected provider.
- Memory context is bounded to five ranked notes and 6,000 characters, with each note snippet limited to 1,400 characters. Context text labels saved notes as reference data, not instructions.
- Added server tests for relevant-note selection, no-match behavior, bounded history, preservation of the latest user message, and rejection of a history that does not end in a user turn.
- Added authenticated `/api/chat/stream` using NVIDIA SSE and Ollama JSON-line streaming; the existing JSON chat endpoint remains available for compatibility. The browser renders partial text incrementally and displays first-token and total-generation timing. NVIDIA requests disable Nemotron's internal thinking mode by default and the system prompt now asks for concise answers unless the user requests depth; this reduces avoidable time-to-first-token and prevents internal reasoning budget from crowding out the answer.
- Stream audit records contain provider/model/agent and timing metadata only. Streamed provider failures return sanitized error messages, and the global provider semaphore is released on success or failure.

### Latest validation after streaming work (2026-10-11)

- `npm run check`: passed.
- `npm test`: 28/28 passed.
- `npm run test:server`: 28/28 passed, including NVIDIA SSE parsing, Ollama JSON-line parsing, authenticated stream events/timing, sanitized provider failure, disconnect-triggered upstream closure, and capacity release.
- `npm run test:browser`: passed, including incremental partial rendering/timing, edit and retry flows, task/goal/learning/project/R&D creation and sync, Crossref/citation flow, interrupted-response recovery, cancellation, backup restore, and confirmed workspace clearing.
- `git diff --check`: passed on the latest retest.
- Full retest on 2026-10-11 repeated `npm run check`, all 28 Node tests, all 28 Python server tests, and the browser smoke suite successfully. The oversized-request test was made deterministic: it now sends the declared oversized `Content-Length` without racing to upload a multi-megabyte body after the server correctly rejects the request early.
- Live HTTPS health was independently rechecked with strict CA verification at `https://127.0.0.1:4173/api/health`; it reports the selected NVIDIA Nemotron provider available and streaming support enabled. This confirms host service health, not physical-device reachability.
- After adding `chat_template_kwargs.enable_thinking=false` and concise-default instructions, authenticated live NVIDIA streaming passed through `/api/chat/stream` in a disposable SQLite workspace: HTTP 200, 42 deltas, 234 answer characters, 2,724 ms to first delta and 3,908 ms total. Two short direct provider-only probes also passed with 569/681 ms first-token times and 961/1,134 ms total times; one other direct probe timed out. Before this change, comparable short multi-turn probes took 4.4–29.2 s to first output and returned roughly 2.2k characters. This is encouraging evidence of reduced reasoning overhead, but provider variability and the failed probe mean more realistic samples are still required.

### Still open in Phase 2

- Streaming cancellation now has a server-side disconnect watcher that closes the active upstream HTTP response without waiting for the next model delta. A regression test verifies that disconnect closes the upstream response and releases provider capacity; physical live-provider cancellation remains an external acceptance check.
- The first low-thinking latency baseline is available, but optimization should wait for more realistic multi-turn prompts and measurements on the physical device/network; one direct probe still timed out.
- Edit/retry now have basic end-to-end browser coverage, and interruption recovery is tested; additional edge cases across long multi-turn histories, concurrent edits, and provider-specific cancellation remain open.
- The paths `/home/prem-macharla/SPARKLE GEN-3` and `/home/prem-macharla/SPARKLE-GEN3` resolve to the same repository location. After the automated suite passed, `sparkle-gen3.service` was restarted and HTTPS health now advertises `streaming_supported=true`; the stream route also returned `401` without a paired token. Authenticated live streaming has now passed in a disposable workspace after transient provider timeouts; deployment and initial live inference samples are verified, while a broader realistic-prompt latency benchmark and physical-device acceptance remain open.


## Home landing page (2026-10-11)

- Added a dedicated Home navigation entry and responsive overview landing page. It summarizes open tasks, active goals, saved project briefs, learning plans, and recent work, with shortcuts into the existing workspaces.
- Home is a secondary destination; the Main Assistant conversation remains the initial view. Dashboard summaries are read-only, and quick actions only create records after the user explicitly clicks and confirms the existing add flow.
- Browser smoke test covers Home as a navigable workspace; automated checks passed after implementation.

## R&D Lab: built-in simulation and experiment runner

The R&D Lab now includes a browser-side, deterministic simulation engine with four registered models: damped pendulum dynamics, a planar two-link robot arm, PID motor/setpoint response, and a simple swarm moving toward a target. The Simulation workspace provides Start, Pause, single-step, Reset, adjustable parameters, live canvas visualization, and telemetry. A five-point parameter sweep runs 1,800 fixed time steps per value and reports final, peak, and RMS metrics. Simulation runs and sweep results are saved in the existing `labDrafts` data collection and synced through the existing workspace persistence path when paired.

Important limits: these are mathematical demonstration models, not a substitute for calibrated physical simulation or real hardware telemetry. External engines (Gazebo/ROS 2, MuJoCo, Isaac Sim, etc.) are not connected yet. No user-supplied or AI-generated code is executed. The engine is intentionally an adapter-friendly first foundation; each future external engine needs an explicit, reviewed adapter, dependency setup, resource limits, and validation before being advertised as supported.
## Browser UI visual audit (October 2026)

Audited the running web app in headless Chrome at desktop (1440×1000), tablet (768×1024), standard mobile (390×844), and narrow mobile (320×720) viewports. Captured light/dark chat, Home, R&D Simulation, and mobile Settings screenshots. No horizontal overflow was observed at the tested viewport widths; mobile Settings and R&D layouts stack correctly, and the simulation controls remain visible and usable.

Polish fixes from the audit:
- Prefer the platform system UI font stack with Noto Sans as a local fallback; do not depend on a remote font request. This avoids the previous Inter declaration implying a font that is not installed on the host.
- Darkened the light-theme muted text token (#6b7068) to improve contrast against both the warm page background and white panels; the dark theme keeps its existing high-contrast muted token.
- Made the Compact / Comfortable / Spacious density selector actually affect layout spacing and ensured density is applied after settings load and on render.
- Increased mobile touch targets for topbar icon controls, tab buttons, and text actions; enlarged slider hit areas and telemetry labels.
- Prevented mobile breadcrumb wrapping on narrow screens.

Verification after changes: npm run check, npm test, and npm run test:browser passed, including assertions for font-stack selection, density presets changing panel padding, theme toggling, and mobile horizontal overflow. git diff --check passed. No commit/push was performed.