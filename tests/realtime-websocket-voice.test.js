import test from "node:test";
import assert from "node:assert/strict";
import { createRealtimeWebSocketVoiceSession } from "../src/core/realtime-websocket-voice.js";

function fixture() {
  const calls = { sent: [], statuses: [], final: [], partial: [], errors: [], playback: [], stops: 0, tracks: [], sockets: [] };
  class FakeWebSocket {
    constructor(url) { this.url=url;this.readyState=0;this.binaryType="";calls.socket=this;calls.sockets.push(this);queueMicrotask(()=>{this.readyState=1;this.onopen?.();}); }
    send(data) {
      calls.sent.push(data);
      if(typeof data==="string"){
        const event=JSON.parse(data);
        if(event.type==="auth"){calls.auth=event;queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({type:"relay.ready"})}));}
        else if(event.setup){calls.session=event;queueMicrotask(()=>this.onmessage?.({data:new TextEncoder().encode(JSON.stringify({setupComplete:{}})).buffer}));}
      }
    }
    emit(event){this.onmessage?.({data:JSON.stringify(event)});}
    emitBinary(event){this.onmessage?.({data:new TextEncoder().encode(JSON.stringify(event)).buffer});}
    close(code=1000,reason=""){this.readyState=3;calls.closed={code,reason};this.onclose?.({code,reason});}
  }
  class FakeAudioContext {
    constructor(options){this.sampleRate=options.sampleRate;this.state="running";this.currentTime=1;this.destination={};calls.context=this;}
    async resume(){}
    createMediaStreamSource(){return {connect(node){calls.connected=node;},disconnect(){}};}
    createScriptProcessor(){return calls.processor={onaudioprocess:null,connect(){},disconnect(){}};}
    createBuffer(_channels,length,rate){const samples=new Float32Array(length);return {duration:length/rate,getChannelData(){return samples;}};}
    createBufferSource(){const node={connect(){},start(when){calls.playback.push(when);},stop(){calls.stops++;},disconnect(){}};return node;}
    close(){calls.contextClosed=true;this.state="closed";}
  }
  const track={stopped:false,stop(){this.stopped=true;}};
  const stream={active:true,getTracks:()=>[track]};
  const session=createRealtimeWebSocketVoiceSession({
    WebSocketCtor:FakeWebSocket,AudioContextCtor:FakeAudioContext,
    getUserMedia:async constraints=>{calls.constraints=constraints;calls.tracks.push(track);return stream;},
    socketURL:"wss://sparkle.test/api/voice/ws",token:"t".repeat(48),
    instructions:"SPARKLE shared conversation context",
    onStatus:value=>calls.statuses.push(value),
    onTranscript:(role,text)=>calls.final.push({role,text}),
    onTranscriptPartial:(role,text)=>calls.partial.push({role,text}),
    onError:value=>calls.errors.push(value),
    setTimeoutFn:(fn,delay=0)=>setTimeout(fn,Math.min(delay,10))
  });
  return {calls,session,track,stream};
}

test("Gemini Live voice authenticates, configures audio, streams mic input and cleans up", async () => {
  const {calls,session,track}=fixture();
  assert.equal(await session.start(),true);
  assert.equal(session.active,true);
  assert.equal(calls.socket.url,"wss://sparkle.test/api/voice/ws");
  assert.equal(calls.auth.token,"t".repeat(48));
  assert.equal(calls.session.setup.model,"models/gemini-3.8-live");
  assert.deepEqual(calls.session.setup.generationConfig.responseModalities,["AUDIO"]);
  assert.equal(calls.socket.binaryType,"arraybuffer","Gemini server frames are delivered as binary WebSocket frames");
  assert.ok(calls.session.setup.inputAudioTranscription);
  assert.ok(calls.session.setup.outputAudioTranscription);
  assert.deepEqual(calls.session.setup.contextWindowCompression,{slidingWindow:{}},"long-running sessions enable context compression");
  assert.match(calls.session.setup.systemInstruction.parts[0].text,/SPARKLE shared conversation context/);
  assert.equal(calls.constraints.audio.echoCancellation,true);
  const samples=new Float32Array(1024);samples.fill(.2);
  calls.processor.onaudioprocess({inputBuffer:{sampleRate:48000,getChannelData:()=>samples},outputBuffer:{getChannelData:()=>new Float32Array(1024)}});
  const audioFrame=calls.sent.map(value=>typeof value==="string"?JSON.parse(value):null).find(value=>value?.realtimeInput?.audio);
  assert.ok(audioFrame,"microphone PCM16 should be sent as Gemini JSON audio frames");
  assert.equal(audioFrame.realtimeInput.audio.mimeType,"audio/pcm;rate=16000");
  assert.ok(Buffer.from(audioFrame.realtimeInput.audio.data,"base64").length>0);
  calls.socket.emit({serverContent:{inputTranscription:{text:"hello "}}});
  calls.socket.emit({serverContent:{inputTranscription:{text:"SPARKLE"}}});
  calls.socket.emitBinary({serverContent:{outputTranscription:{text:"Hello there"},modelTurn:{parts:[{inlineData:{mimeType:"audio/pcm;rate=24000",data:Buffer.from(new Int16Array([1000,-1000,500]).buffer).toString("base64")}}]}}});
  assert.equal(calls.playback.length,1,"Gemini PCM audio in binary WebSocket frames should be scheduled for playback");
  calls.socket.emitBinary({serverContent:{turnComplete:true}});
  assert.deepEqual(calls.final,[{role:"user",text:"hello SPARKLE"},{role:"assistant",text:"Hello there"}]);
  calls.socket.emit({serverContent:{interrupted:true}});
  assert.ok(calls.stops>=1,"Gemini interruption should stop queued playback");
  session.stop();
  assert.equal(session.active,false);
  assert.equal(track.stopped,true);
  assert.equal(calls.contextClosed,true);
  assert.equal(calls.closed.code,1000);
  assert.ok(calls.sent.every(value=>!(typeof value==="string"&&JSON.parse(value).type==="session.close")),"Gemini session is closed by closing the WebSocket, not a provider-specific command");
});

test("Gemini Live stores resumable handles and reconnects before GoAway with the same microphone session", async () => {
  const {calls,session,track}=fixture();
  await session.start();
  calls.socket.emitBinary({sessionResumptionUpdate:{newHandle:"opaque-resumption-handle",resumable:true}});
  assert.equal(session.resumable,true);
  calls.socket.emitBinary({goAway:{timeLeft:"30s"}});
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(calls.sockets.length,2,"GoAway should proactively open a replacement socket");
  assert.equal(calls.session.setup.sessionResumption.handle,"opaque-resumption-handle","the latest valid handle must resume the Gemini session");
  assert.equal(session.active,true,"reconnection must keep Voice Mode active");
  assert.equal(track.stopped,false,"reconnection must retain the microphone stream");
  assert.equal(calls.contextClosed,undefined,"reconnection must retain the audio context");
  assert.ok(calls.statuses.some(value=>value.includes("Reconnected")));
  calls.socket.emitBinary({sessionResumptionUpdate:{newHandle:"second-resumption-handle",resumable:true}});
  calls.socket.close(1006,"simulated network drop");
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(calls.sockets.length,3,"unexpected network close should retry automatically");
  assert.equal(calls.session.setup.sessionResumption.handle,"second-resumption-handle","unexpected-close recovery should use the newest resumable handle");
  assert.equal(session.active,true);
  session.stop();
  assert.equal(track.stopped,true);
});

test("WebSocket voice stops a microphone stream that resolves after cancellation", async () => {
  let resolveMic, stopped=false;
  class FakeSocket { constructor(){this.readyState=0;queueMicrotask(()=>{this.readyState=1;this.onopen?.();});} send(){} close(){this.readyState=3;} }
  class FakeContext { constructor(){this.state="running";} async close(){} }
  const session=createRealtimeWebSocketVoiceSession({
    WebSocketCtor:FakeSocket,AudioContextCtor:FakeContext,
    getUserMedia:()=>new Promise(resolve=>{resolveMic=resolve;}),
    socketURL:"ws://sparkle.test/api/voice/ws",token:"x".repeat(48)
  });
  const pending=session.start();
  session.stop();
  resolveMic({getTracks:()=>[{stop(){stopped=true;}}]});
  await assert.rejects(pending,/startup was cancelled/);
  assert.equal(stopped,true);
});

test("WebSocket voice rejects missing paired-device credentials before microphone access", async () => {
  let microphoneRequested=false;
  const session=createRealtimeWebSocketVoiceSession({socketURL:"ws://sparkle.test/api/voice/ws",token:"",getUserMedia:async()=>{microphoneRequested=true;}});
  await assert.rejects(session.start(),/needs WebSocket, Web Audio, microphone permission, and a paired device/);
  assert.equal(microphoneRequested,false);
});
