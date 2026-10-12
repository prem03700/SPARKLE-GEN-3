import test from "node:test";
import assert from "node:assert/strict";
import { createRealtimeVoiceSession } from "../src/core/realtime-voice.js";

function fixture({ failSignal = false } = {}) {
  const calls = { tracks: [], peer: null, audio: null, statuses: [], transcripts: [], errors: [] };
  class FakePeerConnection {
    constructor(options) { this.options = options; this.iceGatheringState = "complete"; this.connectionState = "new"; this.closed = false; calls.peer = this; }
    addTrack(track, stream) { calls.addedTrack = track; }
    createDataChannel(label) { calls.channelLabel = label; return { onmessage: null }; }
    async createOffer() { return { type: "offer", sdp: "v=0 test offer with enough SDP fixture content" }; }
    async setLocalDescription(offer) { this.localDescription = offer; }
    async setRemoteDescription(answer) { this.remoteDescription = answer; }
    close() { this.closed = true; }
  }
  const track = { stopped: false, stop() { this.stopped = true; } };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const audio = { style: {}, srcObject: null, setAttribute() {}, play: () => Promise.resolve(), pause() {}, remove() { this.removed = true; } };
  const session = createRealtimeVoiceSession({
    getUserMedia: async constraints => { calls.constraints = constraints; calls.tracks.push(track); return stream; },
    RTCPeerConnectionCtor: FakePeerConnection,
    createAudio: () => (calls.audio = audio),
    createMediaStream: tracks => ({ tracks }),
    apiRequest: async (path, options) => {
      calls.path = path; calls.offer = JSON.parse(options.body).sdp;
      if (failSignal) throw new Error("signaling unavailable");
      return { sdp: "v=0 test answer" };
    },
    onStatus: value => calls.statuses.push(value),
    onTranscript: (role, text) => calls.transcripts.push({ role, text }),
    onError: value => calls.errors.push(value),
    setTimeoutFn: fn => { fn(); return 1; }
  });
  return { calls, session, track, audio };
}

test("realtime voice establishes WebRTC, receives transcripts, and closes mic/audio on stop", async () => {
  const { calls, session, track, audio } = fixture();
  assert.equal(await session.start(), true);
  assert.equal(session.active, true);
  assert.equal(calls.path, "/api/voice/offer");
  assert.equal(calls.channelLabel, "oai-events");
  assert.equal(calls.peer.remoteDescription.type, "answer");
  assert.equal(calls.constraints.audio.echoCancellation, true);
  session.handleEvent(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "hello there" }));
  session.handleEvent(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "hello there" }));
  session.handleEvent(JSON.stringify({ type: "response.audio_transcript.done", transcript: "Hello back" }));
  assert.deepEqual(calls.transcripts, [{ role: "user", text: "hello there" }, { role: "assistant", text: "Hello back" }]);
  session.stop();
  assert.equal(session.active, false);
  assert.equal(calls.peer.closed, true);
  assert.equal(track.stopped, true);
  assert.equal(audio.removed, true);
});

test("realtime voice tears down partially-created resources when signaling fails", async () => {
  const { calls, session, track, audio } = fixture({ failSignal: true });
  await assert.rejects(session.start(), /signaling unavailable/);
  assert.equal(session.active, false);
  assert.equal(calls.peer.closed, true);
  assert.equal(track.stopped, true);
  assert.equal(audio.removed, true);
});

test("realtime voice refuses to start without required browser and signaling capabilities", async () => {
  const session = createRealtimeVoiceSession({});
  await assert.rejects(session.start(), /requires microphone, WebRTC, and authenticated signaling/);
});

test("realtime voice buffers transcript deltas and commits the completed utterance once", () => {
  const { session, calls } = fixture();
  session.handleEvent(JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "turn left " }));
  session.handleEvent(JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "at the next street" }));
  session.handleEvent(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed" }));
  session.handleEvent(JSON.stringify({ type: "response.audio_transcript.delta", delta: "I will " }));
  session.handleEvent(JSON.stringify({ type: "response.audio_transcript.delta", delta: "turn left." }));
  session.handleEvent(JSON.stringify({ type: "response.audio_transcript.done" }));
  assert.deepEqual(calls.transcripts, [
    { role: "user", text: "turn left at the next street" },
    { role: "assistant", text: "I will turn left." }
  ]);
});

test("realtime voice permits identical transcripts in separate turns while deduplicating duplicates within a turn", () => {
  const { session, calls } = fixture();
  const event = JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "yes" });
  session.handleEvent(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
  session.handleEvent(event);
  session.handleEvent(event);
  session.handleEvent(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
  session.handleEvent(event);
  assert.deepEqual(calls.transcripts, [{ role: "user", text: "yes" }, { role: "user", text: "yes" }]);
});

test("stopping while microphone permission is pending stops the late-arriving stream", async () => {
  let resolveMicrophone;
  let trackStopped = false;
  let peerCreated = false;
  const session = createRealtimeVoiceSession({
    getUserMedia: () => new Promise(resolve => { resolveMicrophone = resolve; }),
    RTCPeerConnectionCtor: class { constructor() { peerCreated = true; } },
    createAudio: () => ({}),
    apiRequest: async () => ({ sdp: "v=0 answer" })
  });
  const pending = session.start();
  assert.equal(session.starting, true);
  session.stop();
  resolveMicrophone({ getTracks: () => [{ stop() { trackStopped = true; } }], getAudioTracks: () => [] });
  await assert.rejects(pending, /startup was cancelled/);
  assert.equal(trackStopped, true);
  assert.equal(peerCreated, false);
  assert.equal(session.active, false);
  assert.equal(session.starting, false);
});

test("stopping during provider signaling rejects the late answer and closes resources", async () => {
  let resolveSignal;
  const calls = { trackStopped: false, peer: null, audio: null };
  class Peer {
    constructor() { this.iceGatheringState = "complete"; this.closed = false; calls.peer = this; }
    addTrack() {}
    createDataChannel() { return { onmessage: null, close() { this.closed = true; } }; }
    async createOffer() { return { type: "offer", sdp: "v=0 offer" }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) { this.remoteDescription = value; }
    close() { this.closed = true; }
  }
  const track = { stop() { calls.trackStopped = true; } };
  const audio = { style: {}, setAttribute() {}, pause() {}, remove() { this.removed = true; } };
  const session = createRealtimeVoiceSession({
    getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }),
    RTCPeerConnectionCtor: Peer,
    createAudio: () => (calls.audio = audio),
    apiRequest: () => new Promise(resolve => { resolveSignal = resolve; })
  });
  const pending = session.start();
  for (let i = 0; i < 20 && !resolveSignal; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(typeof resolveSignal, "function");
  session.stop();
  resolveSignal({ sdp: "v=0 answer" });
  await assert.rejects(pending, /startup was cancelled/);
  assert.equal(calls.peer.closed, true);
  assert.equal(calls.trackStopped, true);
  assert.equal(audio.removed, true);
  assert.equal(session.active, false);
});
