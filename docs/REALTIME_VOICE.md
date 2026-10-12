# SPARKLE GEN-3 real-time voice

SPARKLE now supports full-duplex PCM16 VoiceChat over a private WebSocket service. The browser captures microphone audio, streams 24 kHz mono PCM16, plays provider audio as it arrives, and renders live/final transcript events in the existing conversation. The shared recent chat and selected workspace agent are included as bounded session instructions. Voice has no tools; it cannot silently execute workspace actions.

## Provider contract

The adapter targets the documented NVIDIA Nemotron VoiceChat WebSocket protocol, compatible with NeMo-Speech.cpp:

- WebSocket endpoint: `/v1/realtime`
- Readiness endpoint: `/v1/realtime/health`
- Client sends `session.update`, then binary mono little-endian PCM16 microphone frames.
- Server returns transcript events and `response.output_audio.delta` frames containing base64 PCM16 at 24 kHz.
- User speech-start events cancel queued local playback and send `response.cancel` for barge-in.
- `session.close` is sent when voice stops.

Official references:
- https://github.com/NVIDIA/NeMo-Speech.cpp/blob/main/docs/server.md
- https://github.com/NVIDIA/NeMo-Speech.cpp/blob/main/docs/api.md
- https://github.com/NVIDIA/NeMo-Speech.cpp/blob/main/docs/s2s/README.md

## Configure the private provider

The SPARKLE server reads optional voice settings from the process environment or the owner-only file `~/.config/sparkle/gen3.env`. The file must be a regular file owned by the current user with permissions `0600` or stricter. Example for a local provider:

```dotenv
SPARKLE_VOICECHAT_URL=ws://127.0.0.1:8080/v1/realtime
SPARKLE_VOICECHAT_TOKEN=
```

For a separate trusted computer on the private LAN, replace `127.0.0.1` with its private IP. If the provider requires a bearer token, put it in `SPARKLE_VOICECHAT_TOKEN`; it remains server-side and is sent only to the configured upstream. Do not put provider tokens in browser code, URLs, chat messages, or Git.

Run the compatible provider on the local machine or a trusted private GPU host, verify `GET /v1/realtime/health` reports readiness, then restart the existing SPARKLE GEN-3 service through its existing supervisor so it reads the setting. SPARKLE exposes a same-origin authenticated WebSocket endpoint at `/api/voice/ws`; its first frame must contain the paired device token. The relay consumes that frame locally and never forwards it upstream. The relay rejects unpaired sessions, cross-origin browser connections, public upstreams, embedded credentials, URL query strings, redirects, and invalid WebSocket handshakes.

## Hardware and runtime note

The current host's RTX 4060 Laptop GPU has approximately 8 GiB VRAM. NVIDIA's NeMo-Speech.cpp guide recommends at least 16 GB GPU-accessible memory for the recommended Q4_K_M VoiceChat model. Do not assume this host can run the full model locally; use a supported larger-GPU private host or an officially available hosted real-time endpoint. The SPARKLE browser/backend integration is tested with protocol fixtures, but a real provider is not currently configured on this host.

## Privacy and safety

- Voice is opt-in and microphone capture begins only after the user presses Voice.
- Microphone capture, Web Audio context, WebSocket, playback nodes, and session state are cleaned up when stopped or disconnected.
- Live/final transcripts become messages in the current shared conversation; they do not write tasks, goals, projects, or device actions.
- Voice provider credentials remain on the Python server. The upstream URL is constrained to loopback/private hosts.
- The browser uses the existing same-origin SPARKLE server and device pairing. No public voice relay or cloud credentials are exposed to the browser.
- Browser speech remains the fallback when a full-duplex provider is not configured.

## Validation

The automated tests cover PCM16 capture/playback, partial and final transcripts, barge-in cancellation, cleanup during stop/start races, authenticated WebSocket upgrade, unpaired-device rejection, upstream credential isolation, and frame-by-frame protocol relay. End-to-end acoustic latency, audio quality, and provider readiness require a real VoiceChat runtime and are not claimed by the fixture tests.
