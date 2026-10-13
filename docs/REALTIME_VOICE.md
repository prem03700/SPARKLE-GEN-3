# SPARKLE GEN-3 real-time voice — Gemini Live only

SPARKLE's only provider-backed real-time voice route is Google Gemini Live. The browser captures microphone audio, resamples it to 16 kHz mono PCM16, streams audio through SPARKLE's authenticated same-origin WebSocket relay, and plays Gemini's 24 kHz PCM16 audio as it arrives. Input/output transcriptions are shown in the current conversation. Voice is a conversational channel only: no tools or action calls are configured, and it cannot write workspace records or perform device actions.

## Provider protocol

- Official WebSocket host: `generativelanguage.googleapis.com:443` (fixed in the Python backend; not user-configurable).
- Endpoint: `/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`.
- Model: `models/gemini-3.8-live`.
- First provider message is `setup`, using `generationConfig.responseModalities: ["AUDIO"]`, requesting input/output transcription, with no tools.
- Gemini server messages are JSON payloads carried in binary WebSocket frames; the browser decodes these frames before processing setup, transcripts, audio, interruption, and turn completion.
- Input is `realtimeInput.audio` with `audio/pcm;rate=16000`; output PCM is read from `serverContent.modelTurn.parts[].inlineData` and played at 24 kHz.
- `serverContent.interrupted` stops queued playback. `turnComplete` finalizes transcripts.
- `sessionResumptionUpdate` stores the latest resumable handle in memory only; the next connection sends it as `sessionResumption.handle`. Handles are not written to local storage or the workspace.
- `goAway` triggers a reconnect before the provider closes the connection. Unexpected disconnects retry with bounded backoff (up to five attempts); the microphone stream and audio context are retained during reconnect and stopped when the user presses Stop or retries are exhausted.
- Context-window sliding compression is enabled for long conversations. Stop closes the WebSocket and microphone/audio resources. The provider API key is never sent to the browser.

Official references:
- https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket
- https://ai.google.dev/gemini-api/docs/live-api/session-management
- https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens

## Configure the Gemini API key

The server reads `GEMINI_API_KEY` from its process environment or the owner-only `~/.config/sparkle/gen3.env` file. That file must be a regular file owned by the service user and must not grant group/other permissions (recommended mode `0600`).

Add this line to the existing owner-only configuration file (do not replace its other settings):

```dotenv
GEMINI_API_KEY=your_GEMINI_API_key_here
```

Replace the placeholder locally with a valid Gemini API key. Do not paste the key into chat, browser code, URLs, documentation, or Git. Restart the existing `sparkle-gen3.service` through its current user supervisor after adding the key. The `/api/health` response should then report `realtime_voice_supported: true` and `realtime_voice_transport: "websocket"`.

If the key is absent or invalid, real-time voice remains disabled and the UI will not silently switch to Nemotron VoiceChat or browser-speech chat. The existing Nemotron text/reasoning model and NVIDIA image-generation provider remain separate and unchanged.

## Security and privacy

- Voice is opt-in; microphone capture starts only after the user activates it.
- The browser first sends its paired-device token to SPARKLE's same-origin relay. SPARKLE consumes and validates that token locally and never forwards it to Google.
- Only the Python server connects to Google's fixed HTTPS/TLS WebSocket endpoint and includes the Gemini key in the upstream handshake URL. The key is not returned by health or any client API.
- The relay checks same-origin browser requests, pairing, frame masking, and setup rate limits. TLS certificate verification remains enabled for Google.
- The Live session has no configured tools or function calls; voice cannot automatically create tasks/goals, execute code, control devices, or perform external writes.
- Audio and transcripts are sent to Google Gemini Live for processing. Configure and use this only if that provider/data transfer is acceptable for your use case.

## Validation and limitations

Automated tests cover the browser audio protocol (including binary WebSocket frames), transcripts, interruption cleanup, paired-device authentication, relay framing, isolation of the Gemini key, session-resumption handles, proactive GoAway reconnect, retained microphone/audio resources, and context compression configuration. A live provider round-trip has been verified with the configured key: Gemini accepted setup, returned output transcription and audio data, and completed the turn. This validates provider credentials/model access and audio response delivery, but it does not replace manual browser microphone-to-speaker/interruption testing on a paired device or measure acoustic quality. Provider session resumption is now implemented and fixture-tested; live long-duration reconnect behavior still requires a real Gemini session lasting through a provider connection rotation.
