# SPARKLE GEN-3 security and acceptance review

**Review date:** 2026-10-14
**Scope:** Current GEN-3 repository and its local HTTPS listener only. This is a focused engineering review, not an independent penetration test or a claim of production certification.

## Verified in this review

- The current process serves the repository's src/app.js byte-for-byte (SHA-256 comparison); the server process started after the current server.py modification timestamp.
- HTTPS health and application routes return HTTP 200. Strict verification with the configured private CA succeeds for https://127.0.0.1:4173 and https://10.58.17.55:4173. The old address 10.210.108.19 is no longer reachable from this host.
- The current server certificate is valid from 2026-10-11 through 2027-11-12 and contains SANs for localhost, 127.0.0.1, 10.58.17.55, and 10.210.108.19. The private CA verified the active endpoint; no private key was read or displayed.
- Live response headers include HSTS, CSP, X-Content-Type-Options: nosniff, X-Frame-Options: DENY, Referrer-Policy: no-referrer, a restrictive Permissions Policy, and cache control. After restarting the existing user-managed service, the live CSP was verified on loopback and the current LAN host; it now allows the matching secure WebSocket origin instead of generic WebSocket schemes.
- Firefox 157 headless compatibility probe loaded the app successfully and exercised the live CSP: the same-origin secure WebSocket attempt was not blocked by CSP (the unauthenticated relay handshake failed as expected), while a cross-origin WebSocket attempt raised a `connect-src` violation. This is a browser-policy check, not a paired-device voice test.
- Unauthenticated requests to /api/session, /api/data, /api/audit, /api/devices, /api/core/proposals, and a generated-image resource returned HTTP 401.
- Source inspection confirms pairing codes are generated only from loopback, expire after ten minutes, are single-use, and pairing attempts are rate limited. Device tokens are hashed in SQLite and can be revoked.
- Source inspection confirms private-network peer checks, bounded JSON request bodies, rejection of transfer-encoded request bodies, a static-file allowlist, server-side provider credentials, authenticated image generation/storage, rate limits, image-size/storage limits, and no enabled arbitrary shell/code/robotics execution.
- Automated validation on the current working tree at the 2026-10-14 stabilization baseline: `npm run check` passed, `npm test` passed (58/58), `npm run test:server` passed (66/66), `npm run test:browser` passed, and `git diff --check` passed.
- The browser smoke test runs in an isolated temporary app/server/database/profile and covers workspace CRUD/sync, simulated second-client updates without refresh, reload/recovery, edit/retry/cancellation, backup export and validated restore, and confirmed clearing. This is browser/API evidence, not physical-device reverse-sync proof.
- Fresh live checks on 2026-10-14: strict private-CA verification succeeds for loopback and `https://10.58.17.55:4173`; both health and app routes return 200; `/api/session`, `/api/data`, `/api/audit`, `/api/devices`, `/api/core/proposals`, and a syntactically valid generated-image ID return 401 without credentials. Pairing-code access returns 200 over loopback and 403 over the LAN address. CSP `connect-src` is origin-specific for each HTTPS host, and the served `src/app.js` SHA-256 matches the current repository file.
- A stale loopback-only server was found occupying port 4173 and causing the managed TLS/LAN service to restart repeatedly. It was stopped gracefully; `sparkle-gen3.service` is now active with zero restarts since recovery and listens on `0.0.0.0:4173` with TLS. Provider config, CA/server private keys, live database, service log, and backup file permissions were verified owner-only.

## Threat model and controls

| Threat / failure | Existing control | Residual limitation |
|---|---|---|
| Unpaired LAN client reads or mutates workspace | Bearer-token authentication on workspace APIs; one-time loopback pairing; private-network restriction | Devices on a trusted private network can still attempt to reach the listener; pairing secrets and CA trust must be protected |
| Stolen device token | Random token, hashed token storage, sign-out and remote revocation | No per-user identity/role system; revoke the affected device promptly |
| Passive network interception | HTTPS with a private CA; TLS minimum 1.2; HSTS when TLS is enabled | Each device must trust the correct CA out-of-band; a self-managed CA creates owner-operated trust lifecycle responsibilities |
| Browser script injection / clickjacking | Escaped rendered text, CSP, frame denial, same-origin frontend API, nosniff | WebSocket origin is derived from the request Host header after a restrictive character check; verify trusted-host behavior if reverse proxies or custom hostnames are introduced |
| Request smuggling / oversized payload | Requires Content-Length, rejects Transfer-Encoding, validates JSON object shape and bounds body size | The built-in threaded HTTP server is intentionally small and is not a hardened general-purpose internet-facing server |
| Pairing brute force / provider abuse | Pairing and endpoint rate limits; per-device quotas; bounded provider concurrency; bounded image storage | No public deployment or hostile-network load test has been performed |
| Server-side request forgery from research fetch | URL validation, public-IP pinning, TLS hostname verification, redirects blocked, private/local targets refused | Search/fetch source quality and hostile upstream behavior still need ongoing review |
| Unsafe agent/tool action | Proposal/approval boundary; privileged execution and external write adapters remain disabled | Future tool adapters require a separate threat model and sandbox before activation |
| Lost/corrupt workspace | SQLite persistence, revision conflicts, JSON backup/restore validation, interrupted-response recovery, and a verified owner-only local snapshot; owner procedure documented in [backup and recovery runbook](BACKUP_RECOVERY.md) | Snapshot is unencrypted and local only; no off-host destination, rotation, alerting, or full application disaster-recovery drill is configured |
| Provider outage / session expiry | Bounded chat timeouts/cancellation; Gemini Live session resumption and bounded reconnect logic | Long-duration real-provider reconnect and physical-device interruption are not verified in this review |

## Current deployment posture

- Listener is bound to 0.0.0.0:4173 with TLS. Application-level peer filtering accepts private/link-local IP ranges; this is suitable only for a trusted private network, not a public service.
- Current host address observed: 10.58.17.55; another private interface is 172.16.0.2. The active CA-verified endpoint is https://10.58.17.55:4173.
- No port forwarding or public tunnel was configured as part of this review.
- Android was not connected to ADB at review time. Physical reverse-direction sync, device revocation behavior on a real client, and physical microphone/speaker interruption remain external acceptance tasks.
- No live image-generation request was made because it may consume provider quota. Configuration and mocked integration tests do not prove a successful real image was generated.
- Gemini Live session-resumption and reconnect behavior is fixture-tested; no prolonged live provider session was opened during this review.
- No credentials, API keys, pairing codes, bearer tokens, database contents, or private keys were printed. No Git staging, commit, push, reset, or clean was performed.

## Release gates still open

1. Explicitly authorize and run one minimal live image-generation acceptance request; verify the returned image can be retrieved only by a paired device, then delete the test artifact and verify deletion.
2. Run a prolonged Gemini Live session through an actual provider connection rotation and test Stop/interruption/cancellation on real hardware.
3. Reconnect a physical Android device on the current private network and verify CA trust, pairing, host-to-phone and phone-to-host UI sync, sign-out, and revocation.
4. Configure an owner-approved encrypted off-host destination, independent recovery-key storage, retention/alerting, and rehearse a full application restore. A fresh local snapshot and isolated SQLite restore were verified on 2026-10-14; the snapshot is not encrypted or off-host, and full application disaster recovery remains untested.
5. Test the narrowed WebSocket CSP on supported browsers and a paired physical device, including any custom-host or reverse-proxy deployment before enabling one.
6. Do not expose this listener to the public internet. Any remote-access design needs a separate security review.

**Conclusion:** The current code has meaningful local-network protections and a passing automated regression suite. SPARKLE GEN-3 remains a private single-owner MVP with explicit live-provider, physical-device, and recovery gates; this review does not certify it as production-ready.
