/**
 * Full-duplex PCM16 WebSocket voice session for a private Nemotron VoiceChat service.
 * Browser authentication is sent in the first frame and consumed by SPARKLE's
 * same-origin relay; provider credentials never reach this module.
 */
export function createRealtimeWebSocketVoiceSession({
  WebSocketCtor = typeof WebSocket === "undefined" ? null : WebSocket,
  AudioContextCtor = typeof AudioContext === "undefined" ? null : AudioContext,
  getUserMedia,
  socketURL,
  token,
  instructions = "",
  onStatus = () => {},
  onTranscript = () => {},
  onTranscriptPartial = () => {},
  onError = () => {},
  setTimeoutFn = setTimeout
} = {}) {
  let socket = null, context = null, stream = null, source = null, processor = null;
  let active = false, starting = false, generation = 0, playbackGeneration = 0;
  let ready = false, nextPlaybackTime = 0;
  let inputTranscript = "", assistantTranscript = "";
  const playbackNodes = new Set();
  const finalTranscript = { user: "", assistant: "" };
  const TARGET_RATE = 24000;
  const MAX_TRANSCRIPT = 4000;

  function status(value) { onStatus(String(value || "").slice(0, 180)); }
  function sendJSON(value) {
    if (!socket || socket.readyState !== 1) return false;
    socket.send(JSON.stringify(value)); return true;
  }
  function transcript(role, value, final = true) {
    const text = String(value || "").slice(-MAX_TRANSCRIPT);
    if (!text.trim()) return;
    if (final) {
      const normalized = text.trim();
      if (normalized === finalTranscript[role]) return;
      finalTranscript[role] = normalized;
      onTranscript(role, normalized);
    } else onTranscriptPartial(role, text);
  }
  function stopPlayback() {
    playbackGeneration++;
    nextPlaybackTime = context?.currentTime || 0;
    for (const node of playbackNodes) { try { node.stop(); } catch {} try { node.disconnect(); } catch {} }
    playbackNodes.clear();
  }
  function handleEvent(raw) {
    let event;
    try { event = JSON.parse(String(raw)); } catch { return; }
    if (!event || typeof event !== "object") return;
    const type = String(event.type || "");
    if (type === "session.created") {
      if (!sendJSON({type:"session.update",session:{
        audio:{input:{format:{type:"audio/pcm",rate:TARGET_RATE}},output:{format:{type:"audio/pcm",rate:TARGET_RATE}}},
        instructions:String(instructions).slice(0,12000),tools:[]
      }})) onError("Could not configure the realtime voice session.");
    } else if (type === "session.updated") {
      ready = true; status("Connected · speak naturally");
    } else if (["conversation.item.input_audio_transcription.delta","input_audio_transcription.delta"].includes(type)) {
      inputTranscript = (inputTranscript + String(event.delta || "")).slice(-MAX_TRANSCRIPT);
      transcript("user", inputTranscript, false);
    } else if (["conversation.item.input_audio_transcription.completed","input_audio_transcription.completed","user.transcript"].includes(type)) {
      const value = event.transcript || event.text || inputTranscript;
      transcript("user", value, true); inputTranscript = "";
    } else if (["response.output_audio_transcript.delta","response.audio_transcript.delta","response.text.delta"].includes(type)) {
      assistantTranscript = (assistantTranscript + String(event.delta || "")).slice(-MAX_TRANSCRIPT);
      transcript("assistant", assistantTranscript, false);
    } else if (["response.output_audio_transcript.done","response.audio_transcript.done","response.text.done","assistant.transcript"].includes(type)) {
      transcript("assistant", event.transcript || event.text || assistantTranscript, true); assistantTranscript = "";
    } else if (type === "input_audio_buffer.speech_started") {
      // A new turn may legitimately repeat the same words as a previous turn.
      finalTranscript.user = ""; finalTranscript.assistant = "";
      // Full-duplex VoiceChat supports barge-in; immediately silence local playback.
      stopPlayback();
      sendJSON({type:"response.cancel"});
    } else if (type === "response.created") {
      finalTranscript.assistant = "";
    } else if (type === "response.output_audio.delta" || type === "response.audio.delta") {
      playAudioDelta(event.delta);
    } else if (type === "response.output_audio.done" || type === "response.audio.done" || type === "response.done") {
      status("Listening · speak naturally");
    } else if (type === "error") {
      const message = event.error?.message || event.message || "The realtime voice provider reported an error.";
      status("Voice provider error"); onError(String(message).slice(0,220));
    } else if (type === "session.end") {
      status("Voice session ended");
    }
  }
  function playAudioDelta(encoded) {
    if (typeof encoded !== "string" || !context || !encoded.length) return;
    let bytes;
    try {
      const binary = atob(encoded);
      if (!binary.length || binary.length > TARGET_RATE * 2 * 2) return;
      bytes = new Uint8Array(binary.length);
      for (let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
    } catch { return; }
    const samples = Math.floor(bytes.byteLength / 2);
    if (!samples) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const buffer = context.createBuffer(1, samples, TARGET_RATE);
    const channel = buffer.getChannelData(0);
    for (let i=0;i<samples;i++) channel[i] = view.getInt16(i*2, true) / 32768;
    const node = context.createBufferSource();
    node.buffer = buffer; node.connect(context.destination);
    const ticket = playbackGeneration; playbackNodes.add(node);
    const when = Math.max(context.currentTime + 0.025, nextPlaybackTime);
    nextPlaybackTime = when + buffer.duration;
    node.onended = () => { playbackNodes.delete(node); try { node.disconnect(); } catch {} };
    if (ticket === playbackGeneration) node.start(when);
    else { try { node.disconnect(); } catch {} }
  }
  function pcm16FromFloat(input, sourceRate) {
    const outputLength = Math.floor(input.length * TARGET_RATE / sourceRate);
    if (outputLength <= 0 || outputLength > TARGET_RATE) return null;
    const buffer = new ArrayBuffer(outputLength * 2);
    const view = new DataView(buffer);
    const ratio = sourceRate / TARGET_RATE;
    for (let i=0;i<outputLength;i++) {
      const position = i * ratio, left = Math.min(input.length - 1, Math.floor(position));
      const right = Math.min(input.length - 1, left + 1), fraction = position - left;
      const sample = Math.max(-1, Math.min(1, input[left] * (1-fraction) + input[right] * fraction));
      view.setInt16(i*2, sample < 0 ? sample*32768 : sample*32767, true);
    }
    return buffer;
  }
  function connectMicrophone(ticket) {
    source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(4096,1,1);
    processor.onaudioprocess = event => {
      const output = event.outputBuffer.getChannelData(0); output.fill(0);
      if (ticket !== generation || !ready || !socket || socket.readyState !== 1 || !stream?.active) return;
      const pcm = pcm16FromFloat(event.inputBuffer.getChannelData(0), event.inputBuffer.sampleRate || context.sampleRate);
      if (pcm && pcm.byteLength) { try { socket.send(pcm); } catch { status("Audio send failed"); } }
    };
    source.connect(processor); processor.connect(context.destination);
  }
  function cleanup({notify=true} = {}) {
    active = false; ready = false;
    if (processor) { processor.onaudioprocess=null; try {processor.disconnect();} catch {} processor=null; }
    if (source) { try {source.disconnect();} catch {} source=null; }
    if (stream) { for (const track of stream.getTracks()) try {track.stop();} catch {} stream=null; }
    if (socket) {
      const current=socket;socket=null;current.onopen=current.onmessage=current.onerror=current.onclose=null;
      try { if(current.readyState===1){if(notify)current.send(JSON.stringify({type:"session.close"}));current.close(1000,"SPARKLE voice stopped");}else current.close(); } catch {}
    }
    stopPlayback();
    if (context) { const current=context;context=null;try {current.close();} catch {} }
    inputTranscript="";assistantTranscript="";finalTranscript.user="";finalTranscript.assistant="";
  }
  async function start() {
    if (active) return true;
    if (starting) return false;
    if (typeof WebSocketCtor !== "function" || typeof AudioContextCtor !== "function" ||
        typeof getUserMedia !== "function" || typeof socketURL !== "string" || !token) {
      throw new Error("Realtime voice needs WebSocket, Web Audio, microphone permission, and a paired device.");
    }
    starting=true;const ticket=++generation;
    try {
      status("Requesting microphone permission…");
      stream=await getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      if(ticket!==generation){for(const track of stream.getTracks())try{track.stop();}catch{}stream=null;throw new Error("Voice startup was cancelled.");}
      context=new AudioContextCtor({sampleRate:TARGET_RATE});
      if(context.state==="suspended")await context.resume();
      socket=new WebSocketCtor(socketURL);socket.binaryType="arraybuffer";
      await new Promise((resolve,reject)=>{
        const timeout=setTimeoutFn(()=>reject(new Error("Timed out connecting to the private realtime voice service.")),10000);
        socket.onopen=()=>{if(ticket!==generation){clearTimeout(timeout);reject(new Error("Voice startup was cancelled."));return;}socket.send(JSON.stringify({type:"auth",token}));status("Authenticating private voice session…");};
        socket.onmessage=event=>{
          if(ticket!==generation)return;
          if(typeof event.data==="string"){
            let parsed;try{parsed=JSON.parse(event.data);}catch{return;}
            if(parsed.type==="error"&&!ready){clearTimeout(timeout);reject(new Error(parsed.error||"Private voice relay failed."));return;}
            handleEvent(event.data);
            if(ready&&!active){active=true;connectMicrophone(ticket);clearTimeout(timeout);resolve();}
          }
        };
        socket.onerror=()=>{if(!ready){clearTimeout(timeout);reject(new Error("Could not connect to the private realtime voice service."));}};
        socket.onclose=event=>{if(ticket!==generation)return;if(!ready){clearTimeout(timeout);reject(new Error(event.code===1008?"Device pairing was rejected by the voice relay.":"Realtime voice connection closed before setup completed."));}else{cleanup({notify:false});status("Voice disconnected");onError("Realtime voice disconnected. Check the private voice service and start voice again.");}};
      });
      if(ticket!==generation)throw new Error("Voice startup was cancelled.");
      return true;
    } catch(error) { if(ticket===generation)cleanup({notify:false});throw error; }
    finally { starting=false; }
  }
  function stop() { generation++;cleanup(); }
  return {start,stop,handleEvent,get active(){return active;},get starting(){return starting;}};
}
