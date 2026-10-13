/**
 * Full-duplex Gemini Live voice session over SPARKLE's authenticated same-origin relay.
 * Gemini resumption handles are kept in memory only; the Gemini API key remains server-side.
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
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  let socket = null, context = null, stream = null, source = null, processor = null;
  let active = false, starting = false, generation = 0, playbackGeneration = 0;
  let ready = false, nextPlaybackTime = 0, sessionHandle = "", reconnectTimer = null, reconnectDueAt = 0;
  let reconnectAttempts = 0, intentionalStop = false;
  let inputTranscript = "", assistantTranscript = "";
  const playbackNodes = new Set();
  const finalTranscript = { user: "", assistant: "" };
  const TARGET_RATE = 16000;
  const OUTPUT_RATE = 24000;
  const MAX_TRANSCRIPT = 4000;
  const MAX_RECONNECT_ATTEMPTS = 5;

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
  function clearReconnectTimer() {
    if (reconnectTimer !== null) clearTimeoutFn(reconnectTimer);
    reconnectTimer = null;
    reconnectDueAt = 0;
  }
  function reconnectDelay(value) {
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value - 1200);
    const text = String(value || "");
    const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i);
    if (!match) return 0;
    const amount = Number(match[1]), unit = (match[2] || "ms").toLowerCase();
    const milliseconds = amount * (unit === "m" ? 60000 : unit === "s" ? 1000 : 1);
    return Math.max(0, Math.min(30000, milliseconds - 1200));
  }
  function handleEvent(raw) {
    let event;
    try { event = JSON.parse(String(raw)); } catch { return; }
    if (!event || typeof event !== "object") return;
    if (event.type === "relay.ready") {
      const resumption = sessionHandle ? {handle:sessionHandle} : {};
      const setup = {setup:{
        model:"models/gemini-3.8-live",
        generationConfig:{responseModalities:["AUDIO"]},
        systemInstruction:{parts:[{text:String(instructions).slice(0,12000)}]},
        inputAudioTranscription:{},outputAudioTranscription:{},
        sessionResumption:resumption,
        contextWindowCompression:{slidingWindow:{}}
      }};
      if (!sendJSON(setup)) onError("Could not configure the Gemini Live session.");
      else status(sessionHandle ? "Resuming Gemini Live…" : "Configuring Gemini Live…");
      return;
    }
    if (event.sessionResumptionUpdate) {
      const update = event.sessionResumptionUpdate;
      if (update.resumable === true && typeof update.newHandle === "string" && update.newHandle.length > 0 && update.newHandle.length <= 8192) {
        sessionHandle = update.newHandle;
      }
      return;
    }
    if (event.goAway) {
      status("Gemini Live connection rotating · preparing seamless reconnect…");
      scheduleReconnect(reconnectDelay(event.goAway.timeLeft));
      return;
    }
    if (event.setupComplete) {
      ready = true;
      status(sessionHandle ? "Reconnected · Gemini Live · speak naturally" : "Connected · Gemini Live · speak naturally");
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
    if (processor || !context || !stream) return;
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
  function openSocket(ticket) {
    return new Promise((resolve,reject)=>{
      ready = false;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timeout);
        if (error) reject(error); else resolve(true);
      };
      const timeout = setTimeoutFn(()=>finish(new Error("Timed out connecting to Gemini Live.")),10000);
      let next;
      try { next = new WebSocketCtor(socketURL); }
      catch (error) { finish(error); return; }
      socket = next;
      next.binaryType = "arraybuffer";
      next.onopen = () => {
        if (ticket !== generation || intentionalStop) { finish(new Error("Voice startup was cancelled.")); return; }
        try { next.send(JSON.stringify({type:"auth",token})); status("Authenticating private voice session…"); }
        catch { finish(new Error("Could not authenticate the private voice session.")); }
      };
      next.onmessage = event => {
        if (ticket !== generation || next !== socket) return;
        let raw = "";
        if (typeof event.data === "string") raw = event.data;
        else if (event.data instanceof ArrayBuffer) raw = new TextDecoder().decode(event.data);
        else if (ArrayBuffer.isView(event.data)) raw = new TextDecoder().decode(event.data);
        if (!raw) return;
        let parsed; try { parsed = JSON.parse(raw); } catch { return; }
        if ((parsed.type === "error" || parsed.error) && !ready) {
          finish(new Error(typeof parsed.error === "string" ? parsed.error : (parsed.error?.message || "Gemini Live relay failed.")));
          return;
        }
        handleEvent(raw);
        if (ready) {
          if (!active) { active = true; connectMicrophone(ticket); }
          reconnectAttempts = 0;
          finish();
        }
      };
      next.onerror = () => { if (!ready) finish(new Error("Could not connect to Gemini Live.")); };
      next.onclose = event => {
        if (ticket !== generation || intentionalStop || next !== socket) return;
        if (!ready) finish(new Error(event.code === 1008 ? "Device pairing was rejected by the voice relay." : "Gemini Live connection closed before setup completed."));
        if (active) scheduleReconnect(0);
      };
    });
  }
  function scheduleReconnect(delay = 0) {
    if (intentionalStop || !active) return;
    const due = Date.now() + Math.max(0, delay);
    if (reconnectTimer !== null && reconnectDueAt <= due) return;
    clearReconnectTimer();
    reconnectDueAt = due;
    reconnectTimer = setTimeoutFn(async () => {
      reconnectTimer = null; reconnectDueAt = 0;
      if (intentionalStop || !active) return;
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        status("Gemini Live could not reconnect");
        onError("Gemini Live disconnected and automatic reconnection failed. Stop voice and start a new session.");
        cleanup();
        return;
      }
      reconnectAttempts++;
      const old = socket; socket = null; ready = false;
      if (old) { old.onopen = old.onmessage = old.onerror = old.onclose = null; try { old.close(1000,"Resuming Gemini Live session"); } catch {} }
      try {
        await openSocket(generation);
        if (active && ready) status("Reconnected · Gemini Live · speak naturally");
      } catch {
        if (!intentionalStop && active) {
          const backoff = [250, 500, 1000, 2000, 4000][Math.min(reconnectAttempts - 1, 4)];
          status("Gemini Live reconnecting…");
          scheduleReconnect(backoff);
        }
      }
    }, Math.max(0, delay));
  }
  function cleanup() {
    active = false; ready = false;
    clearReconnectTimer();
    reconnectAttempts = 0; sessionHandle = "";
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
    starting=true;intentionalStop=false;const ticket=++generation;
    try {
      status("Requesting microphone permission…");
      stream=await getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      if(ticket!==generation){for(const track of stream.getTracks())try{track.stop();}catch{}stream=null;throw new Error("Voice startup was cancelled.");}
      context=new AudioContextCtor({sampleRate:TARGET_RATE});
      if(context.state==="suspended")await context.resume();
      await openSocket(ticket);
      if(ticket!==generation)throw new Error("Voice startup was cancelled.");
      return true;
    } catch(error) { if(ticket===generation)cleanup();throw error; }
    finally { starting=false; }
  }
  function stop() { intentionalStop=true;generation++;cleanup(); }
  return {start,stop,handleEvent,get active(){return active;},get starting(){return starting;},get resumable(){return Boolean(sessionHandle);}};
}
