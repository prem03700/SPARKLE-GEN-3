/** Optional WebRTC realtime voice transport. Provider credentials and SDP signaling stay behind the authenticated Python API. */
export function createRealtimeVoiceSession({
  getUserMedia,
  RTCPeerConnectionCtor,
  createAudio,
  createMediaStream = tracks => new MediaStream(tracks),
  apiRequest,
  onStatus = () => {},
  onTranscript = () => {},
  onError = () => {},
  setTimeoutFn = setTimeout
} = {}) {
  let peer = null, stream = null, audio = null, channel = null;
  let active = false, starting = false, generation = 0, startGeneration = 0;
  let inputTranscriptBuffer = "", assistantTranscriptBuffer = "";
  const lastTranscript = { user: "", assistant: "" };

  function status(value) { onStatus(String(value).slice(0, 180)); }
  function transcript(role, value) {
    const text = String(value || "").trim().slice(0, 4000);
    if (!text || text === lastTranscript[role]) return;
    lastTranscript[role] = text;
    onTranscript(role, text);
  }
  function handleEvent(raw) {
    let event;
    try { event = JSON.parse(String(raw)); } catch { return; }
    if (!event || typeof event !== "object") return;
    const type = String(event.type || "");
    if (["input_audio_buffer.speech_started", "input_audio_buffer.committed", "conversation.item.input_audio_transcription.started"].includes(type)) {
      inputTranscriptBuffer = "";
      lastTranscript.user = "";
    } else if (type === "response.created") {
      assistantTranscriptBuffer = "";
      lastTranscript.assistant = "";
    } else if (["conversation.item.input_audio_transcription.delta", "input_audio_transcription.delta"].includes(type)) {
      inputTranscriptBuffer = (inputTranscriptBuffer + String(event.delta || "")).slice(-4000);
    } else if (["conversation.item.input_audio_transcription.completed", "input_audio_transcription.completed", "user.transcript"].includes(type)) {
      const value = event.transcript || event.text || inputTranscriptBuffer;
      transcript("user", value);
      inputTranscriptBuffer = "";
    } else if (["response.audio_transcript.delta", "response.output_audio_transcript.delta", "response.text.delta"].includes(type)) {
      assistantTranscriptBuffer = (assistantTranscriptBuffer + String(event.delta || "")).slice(-4000);
    } else if (["response.audio_transcript.done", "response.output_audio_transcript.done", "response.text.done", "assistant.transcript"].includes(type)) {
      transcript("assistant", event.transcript || event.text || assistantTranscriptBuffer);
      assistantTranscriptBuffer = "";
    } else if (type === "error") {
      status("Voice provider reported an error");
      onError("The realtime voice provider reported an error.");
    }
  }
  function cleanupResources() {
    active = false;
    if (channel) {
      try { channel.onmessage = null; channel.close?.(); } catch {}
      channel = null;
    }
    if (peer) {
      try { peer.ontrack = null; peer.onconnectionstatechange = null; peer.ondatachannel = null; peer.close(); } catch {}
      peer = null;
    }
    if (stream) {
      for (const track of stream.getTracks()) { try { track.stop(); } catch {} }
      stream = null;
    }
    if (audio) {
      try { audio.pause?.(); audio.srcObject = null; audio.remove?.(); } catch {}
      audio = null;
    }
  }
  async function start() {
    if (active) return true;
    if (starting) return false;
    if (typeof getUserMedia !== "function" || typeof RTCPeerConnectionCtor !== "function" ||
        typeof createAudio !== "function" || typeof apiRequest !== "function") {
      throw new Error("Realtime voice requires microphone, WebRTC, and authenticated signaling support.");
    }
    starting = true;
    const ticket = ++generation;
    startGeneration = ticket;
    const assertCurrent = () => {
      if (ticket !== generation) throw new Error("Realtime voice startup was cancelled.");
    };
    try {
      status("Requesting microphone permission…");
      const acquiredStream = await getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (ticket !== generation) {
        for (const track of acquiredStream.getTracks()) { try { track.stop(); } catch {} }
        throw new Error("Realtime voice startup was cancelled.");
      }
      stream = acquiredStream;
      peer = new RTCPeerConnectionCtor({ iceServers: [] });
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
      audio = createAudio();
      audio.autoplay = true; audio.playsInline = true;
      audio.setAttribute?.("aria-label", "SPARKLE realtime voice response");
      audio.style && (audio.style.display = "none");
      peer.ontrack = event => {
        if (ticket !== generation || !audio) return;
        audio.srcObject = event.streams?.[0] || createMediaStream([event.track]);
        Promise.resolve(audio.play?.()).catch(() => status("Connected · tap the page if audio playback is blocked"));
      };
      peer.onconnectionstatechange = () => {
        if (!peer || ticket !== generation) return;
        const connection = peer.connectionState;
        status(connection === "connected" ? "Connected · speak naturally" :
          connection === "connecting" ? "Connecting realtime audio…" :
          connection === "failed" ? "Connection failed · stop and retry" : "Voice " + connection);
      };
      peer.ondatachannel = event => {
        if (ticket !== generation) { try { event.channel.close?.(); } catch {} return; }
        if (channel && channel !== event.channel) { try { channel.close?.(); } catch {} }
        channel = event.channel;
        channel.onmessage = message => { if (ticket === generation) handleEvent(message.data); };
      };
      channel = peer.createDataChannel("oai-events");
      channel.onmessage = message => { if (ticket === generation) handleEvent(message.data); };
      const offer = await peer.createOffer();
      assertCurrent();
      await peer.setLocalDescription(offer);
      assertCurrent();
      if (peer.iceGatheringState !== "complete") {
        await Promise.race([
          new Promise(resolve => { peer.addEventListener("icegatheringstatechange", () => { if (ticket === generation && peer?.iceGatheringState === "complete") resolve(); }); }),
          new Promise(resolve => setTimeoutFn(resolve, 2500))
        ]);
      }
      assertCurrent();
      const answer = await apiRequest("/api/voice/offer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp: peer.localDescription?.sdp || offer.sdp })
      });
      assertCurrent();
      if (typeof answer?.sdp !== "string" || !answer.sdp.includes("v=0")) throw new Error("Voice provider returned an invalid session answer.");
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      assertCurrent();
      active = true;
      status("Connecting realtime audio…");
      return true;
    } catch (error) {
      if (ticket === generation) cleanupResources();
      throw error;
    } finally {
      if (startGeneration === ticket) starting = false;
    }
  }
  function stop() {
    generation++;
    cleanupResources();
    inputTranscriptBuffer = "";
    assistantTranscriptBuffer = "";
    lastTranscript.user = "";
    lastTranscript.assistant = "";
  }
  return { start, stop, get active() { return active; }, get starting() { return starting; }, handleEvent };
}
