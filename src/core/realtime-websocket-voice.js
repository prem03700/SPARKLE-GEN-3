/**
 * Full-duplex Gemini Live voice session over SPARKLE's authenticated same-origin relay.
 * Only the paired-device token reaches SPARKLE; the Gemini API key remains server-side.
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
  const TARGET_RATE = 16000;
  const OUTPUT_RATE = 24000;
  const MAX_TRANSCRIPT = 4000;

  function status(value) { onStatus(String(value || "").slice(0, 180)); }
  function sendJSON(value) {
    if (!socket || socket.readyState !== 1) return false;
    socket.send(JSON.stringify(value)); return true;
  }
  function appendTranscript(previous, chunk) {
    const next=String(chunk||"");
    if(!previous)return next.slice(-MAX_TRANSCRIPT);
    if(next.startsWith(previous))return next.slice(-MAX_TRANSCRIPT);
    if(previous.endsWith(next))return previous.slice(-MAX_TRANSCRIPT);
    return (previous+next).slice(-MAX_TRANSCRIPT);
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
    if (event.type === "relay.ready") {
      const setup = {setup:{model:"models/gemini-3.8-live",responseModalities:["AUDIO"],
        systemInstruction:{parts:[{text:String(instructions).slice(0,12000)}]},
        inputAudioTranscription:{},outputAudioTranscription:{},sessionResumption:{}}};
      if (!sendJSON(setup)) onError("Could not configure the Gemini Live session.");
      else status("Configuring Gemini Live…");
      return;
    }
    if (event.setupComplete) {
      ready = true; status("Connected · Gemini Live · speak naturally");
      return;
    }
    if (event.error) {
      const message = event.error.message || event.error.status || "Gemini Live reported an error.";
      status("Gemini Live error"); onError(String(message).slice(0,220));
      return;
    }
    const content = event.serverContent;
    if (!content) return;
    if (content.interrupted) {
      stopPlayback(); assistantTranscript = ""; finalTranscript.user = ""; finalTranscript.assistant = "";
      status("Interrupted · listening");
    }
    if (content.inputTranscription?.text) {
      if(!inputTranscript){finalTranscript.user="";finalTranscript.assistant="";}
      inputTranscript = appendTranscript(inputTranscript, content.inputTranscription.text);
      transcript("user", inputTranscript, false);
    }
    if (content.outputTranscription?.text) {
      assistantTranscript = appendTranscript(assistantTranscript, content.outputTranscription.text);
      transcript("assistant", assistantTranscript, false);
    }
    for (const part of content.modelTurn?.parts || []) {
      if (part.inlineData?.data && String(part.inlineData.mimeType || "").startsWith("audio/pcm")) playAudioDelta(part.inlineData.data);
    }
    if (content.turnComplete || content.generationComplete) {
      if (inputTranscript.trim()) transcript("user", inputTranscript, true);
      if (assistantTranscript.trim()) transcript("assistant", assistantTranscript, true);
      inputTranscript = ""; assistantTranscript = "";
      status("Listening · Gemini Live");
    }
  }
  function playAudioDelta(encoded) {
    if (typeof encoded !== "string" || !context || !encoded.length) return;
    let bytes;
    try {
      const binary = atob(encoded);
      if (!binary.length || binary.length > OUTPUT_RATE * 2 * 2) return;
      bytes = new Uint8Array(binary.length);
      for (let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
    } catch { return; }
    const samples = Math.floor(bytes.byteLength / 2);
    if (!samples) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const buffer = context.createBuffer(1, samples, OUTPUT_RATE);
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
  function base64FromBytes(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let offset=0;offset<bytes.length;offset+=0x8000) binary += String.fromCharCode(...bytes.subarray(offset,Math.min(offset+0x8000,bytes.length)));
    return btoa(binary);
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
    processor = context.createScriptProcessor(1024,1,1);
    processor.onaudioprocess = event => {
      const output = event.outputBuffer.getChannelData(0); output.fill(0);
      if (ticket !== generation || !ready || !socket || socket.readyState !== 1 || !stream?.active) return;
      const pcm = pcm16FromFloat(event.inputBuffer.getChannelData(0), event.inputBuffer.sampleRate || context.sampleRate);
      if (pcm && pcm.byteLength) { try { sendJSON({realtimeInput:{audio:{data:base64FromBytes(pcm),mimeType:"audio/pcm;rate=16000"}}}); } catch { status("Audio send failed"); } }
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
      try { if(current.readyState===1)current.close(1000,"SPARKLE voice stopped");else current.close(); } catch {}
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
        const timeout=setTimeoutFn(()=>reject(new Error("Timed out connecting to Gemini Live.")),10000);
        socket.onopen=()=>{if(ticket!==generation){clearTimeout(timeout);reject(new Error("Voice startup was cancelled."));return;}socket.send(JSON.stringify({type:"auth",token}));status("Authenticating private voice session…");};
        socket.onmessage=event=>{
          if(ticket!==generation)return;
          if(typeof event.data==="string"){
            let parsed;try{parsed=JSON.parse(event.data);}catch{return;}
            if((parsed.type==="error"||parsed.error)&&!ready){clearTimeout(timeout);reject(new Error(typeof parsed.error==="string"?parsed.error:(parsed.error?.message||"Gemini Live relay failed.")));return;}
            handleEvent(event.data);
            if(ready&&!active){active=true;connectMicrophone(ticket);clearTimeout(timeout);resolve();}
          }
        };
        socket.onerror=()=>{if(!ready){clearTimeout(timeout);reject(new Error("Could not connect to Gemini Live."));}};
        socket.onclose=event=>{if(ticket!==generation)return;if(!ready){clearTimeout(timeout);reject(new Error(event.code===1008?"Device pairing was rejected by the voice relay.":"Gemini Live connection closed before setup completed."));}else{cleanup({notify:false});status("Voice disconnected");onError("Gemini Live disconnected. Check the Gemini API configuration and start voice again.");}};
      });
      if(ticket!==generation)throw new Error("Voice startup was cancelled.");
      return true;
    } catch(error) { if(ticket===generation)cleanup({notify:false});throw error; }
    finally { starting=false; }
  }
  function stop() { generation++;cleanup(); }
  return {start,stop,handleEvent,get active(){return active;},get starting(){return starting;}};
}
