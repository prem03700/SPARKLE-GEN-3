# SPARKLE GEN-3

SPARKLE GEN-3 is a private, local-first Personal AI workspace for one owner and their paired devices. The server and database run on the host computer. The default Nemotron reasoning model is hosted by NVIDIA; Ollama can be selected to keep inference local. It is not designed as a public multi-user service.

## Start

Requirements: Python 3.11+ and an NVIDIA API key with access to `nvidia/nemotron-3.5-lightning-30b-a3b` for the default AI chat route. Node.js 20+ is used for checks and tests. Ollama with `qwen3:8b` is available as an explicit local-only alternative.

```bash
cd "/home/prem-macharla/SPARKLE GEN-3"
npm run check
npm test
npm run test:server
npm run test:browser
```

The default engine is NVIDIA Nemotron 3.5 Lightning (`nvidia/nemotron-3.5-lightning-30b-a3b`). The server reads `NVIDIA_API_KEY` or `SPARKLE_LLM_API_KEY` from its process environment, or from `~/.config/sparkle/gen3.env` only when that file is owned by the current user and has no group/world permissions (for example, mode `0600`). Keep the key in this protected configuration only; never add credentials to source files or logs. NVIDIA mode sends conversation prompts and any explicitly enabled Knowledge snippets to NVIDIA's hosted API. There is no silent fallback if the selected provider is unavailable. To explicitly use the local model instead, start with `SPARKLE_MODEL_PROVIDER=ollama SPARKLE_MODEL=qwen3:8b npm start`.

Open **https://localhost:4173** on the host computer. Manual `npm start` binds to `127.0.0.1` by default. The enabled per-user `sparkle-gen3.service` serves HTTPS with a private, locally generated CA certificate, sets `SPARKLE_HOST=0.0.0.0` for paired devices on your trusted LAN, starts at login, and restarts after failures. The CA is stored at `~/.config/sparkle/gen3-tls/ca.crt`; a transfer copy is available at `~/Downloads/SPARKLE-GEN3-Private-CA.crt`. Verify the CA fingerprint and follow [`docs/PRIVATE_DEVICE_TLS.md`](docs/PRIVATE_DEVICE_TLS.md) before trusting it on a phone/tablet. Never transfer the CA private key (`ca.key`) or server private key (`server.key`). A GNOME autostart launcher remains as a fallback and exits if the server is already healthy. Do not launch a second copy if port 4173 is already in use. Server logs are written to `~/.local/state/sparkle-gen3/server.log`.

## Pair your devices

1. Open SPARKLE on the host computer using `https://localhost:4173`.
2. The per-user service starts automatically and exposes the app on the host's private LAN interface. The server rejects non-private source addresses; do not port-forward it or expose it through a public tunnel.
3. In Settings, copy the **Host address for your other devices**. Open that URL on another device connected to the same trusted LAN.
4. On the host browser, open **Settings → Private Core connection** and choose **Generate / show pairing code**. If you want AI chat on the host browser too, pair the host browser itself with that code first.
5. Generate a fresh code on the host for the next device. Each code is single-use and expires after 10 minutes. Enter it on the device being paired, along with a device name, then select **Pair this device**.
6. Generate a fresh code for every additional device. Use **Paired devices** to inspect or revoke access.

LAN access now uses TLS, but each device must trust the SPARKLE GEN-3 private CA before pairing. The server certificate currently covers `localhost`, `127.0.0.1`, and the host LAN address `10.58.17.55`; if the LAN address changes, regenerate the server certificate with the new address. Do not port-forward this server or expose it through a public tunnel. For access away from home, use a separately configured private VPN and complete a security review first.

The browser stores its device token locally. The server stores only a hash of each token. All paired devices share one workspace database.

## Working now

- Private Python server with authenticated API routes.
- Local SQLite storage for conversations (separate by specialist), tasks, goals, knowledge notes, project briefs, research drafts, learning plans, and R&D drafts.
- Optional, explicitly enabled local-note context for AI conversations; disabled by default.
- Provider-selectable text chat: NVIDIA Nemotron 3.5 Lightning is the default reasoning/planning/coding route; Ollama `qwen3:8b` is an explicit local-only alternative. No implicit provider fallback. The browser uses provider-native streaming when the server advertises support, otherwise it retains compatibility with the JSON chat endpoint. NVIDIA's internal thinking mode is disabled by default for faster direct answers; a per-turn reasoning-mode control is not yet exposed. Authenticated live streaming succeeded on 2026-10-11 in a disposable workspace (42 deltas; 2.724 s first token, 3.908 s total). Two direct provider-only probes completed in 0.569–0.681 s to first token and 0.961–1.134 s total, though one probe timed out. These are initial measurements, not a stable benchmark.
- Opt-in browser voice conversation beta: browser speech recognition feeds recognized text through the same authenticated Nemotron chat path, and browser speech synthesis reads the answer aloud. Voice mode stops when leaving the chat workspace and can be stopped manually. Browser speech providers may process microphone audio; use only if you accept that processing. This is not the full-duplex Gemini Live/Nemotron VoiceChat transport and depends on browser support, microphone permissions, and a secure browser context (localhost or trusted HTTPS; plain HTTP LAN addresses may block microphone access).
- Edit sent messages, retry a previous response, stop waiting for a pending response, recover interrupted responses after reload, delete individual conversations or clear all conversation history with confirmation, and attach small text/source-code files to a chat. Browser chat requests stop waiting after 95 seconds; the streaming route watches for client disconnects and closes its active upstream response, with a regression test for that lifecycle. Chat attachments are limited to 48 KB and 9,000 characters, are stored with the conversation, and are sent to the selected model when you send the message.
- Selected-model helpers for code explanation/review/test ideas, research-question refinement, learning assessments, project planning, and simulation setup drafts.
- Read-only Progress dashboard for task/goal completion, saved learning/project/research counts, and recent workspace activity.
- One-time device pairing, device listing, device revocation, and sign-out revocation.
- Revision-based conflict detection to prevent stale devices silently overwriting newer workspace data; Settings can reload the authoritative server version.
- A private audit log records pairing, device revocation/sign-out, workspace updates/conflicts, and model-use metadata without storing prompts or responses.
- Responsive browser interface, light/dark themes, accent and density preferences.
- Export, validated restore, and confirmed workspace-data clearing.
- Architecture, frontend, and server contract tests.

## Not yet ready

- Research can explicitly search Crossref for scholarly metadata, DOI links, and citation copying/saving. This is not general web search, full-text retrieval, peer-review verification, or a quality assessment; open and verify the original sources. The search phrase alone is sent to Crossref, not chat history or saved notes.
- Knowledge can import small text-readable files (including Markdown, CSV, and JSON) as plain-text notes up to 250 KB; these formats are not parsed into structured records. PDF/Office extraction and searchable semantic memory are not yet implemented.
- Realtime Nemotron VoiceChat is not connected to GEN-3 yet. Text Nemotron support is a separate capability; voice requires microphone/audio streaming, interruption handling, Personal Core delegation, authorization gates, and live acceptance before it can be enabled.
- Code execution, shell access, robotics simulation, and experiment execution remain disabled; the R&D and IDE workspaces prepare drafts only.
- The service now uses TLS on the LAN. Other devices must import/trust the CA certificate out-of-band; physical-device trust and access acceptance remain pending. Remote access outside your trusted LAN requires a private VPN and further hardening.
- The Personal Core service modules are still partly prototypes; the current server's SQLite workspace API is the active persistence authority.
- AI availability and quality depend on the selected provider, account/model access, network connection, and (for Ollama) host hardware/model.

## Privacy and data

- The SQLite database lives in `data/sparkle-gen3.sqlite3` and is excluded from version control.
- API routes other than health and host-only setup-code retrieval require a paired-device token.
- The web server refuses requests for source files outside the app shell and `src/`.
- NVIDIA mode sends chat prompts to `https://integrate.api.nvidia.com/v1/chat/completions`; the API key stays server-side. Ollama mode sends prompts only to `127.0.0.1:11434` on the host. The active provider is reported by `/api/health`.
- Do not store secrets in notes or use untrusted networks while using plain HTTP.
- Back up important data from Settings.

## Architecture

- `server.py` — private HTTP API, device pairing, NVIDIA Nemotron/Ollama text-model adapters, SQLite persistence.
- `src/app.js` — UI shell, state, API client, conversation flow, workspace synchronization.
- `src/core/agent-registry.js` — centralized specialist profiles and default provider/model selection.
- `src/core/personal-core/` — in-process contracts and prototypes; not yet the sole production authority for every domain.
- `src/domains/*/view.js` — workspace views.
- `tests/` — frontend and private-server tests.

No Git commit or push is performed by the run commands.
