import test from "node:test";
import assert from "node:assert/strict";
import { createRealtimeWebSocketVoiceSession } from "../src/core/realtime-websocket-voice.js";

function fixture() {
  const calls = { sent: [], statuses: [], final: [], partial: [], errors: [], playback: [], stops: 0, tracks: [] };
  class FakeWebSocket {
    constructor(url) { this.url=url;this.readyState=0;this.binaryType="";calls.socket=this;queueMicrotask(()=>{this.readyState=1;this.onopen?.();}); }
    send(data) {
      calls.sent.push(data);
      if(typeof data==="string"){
        const event=JSON.parse(data);
        if(event.type==="auth"){calls.auth=event;queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({type:"session.created",session:{id:"fixture"}})}));}
        else if(event.type==="session.update"){calls.session=event;queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({type:"session.updated"})}));}
      }
    }
    emit(event){this.onmessage?.({data:JSON.stringify(event)});}
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
    setTimeoutFn:(fn)=>{const timer=setTimeout(fn,1000);return timer;}
  });
  return {calls,session,track,stream};
}

test("full-duplex WebSocket voice authenticates, configures PCM16, streams mic audio and cleans up", async () => {
  const {calls,session,track}=fixture();
  assert.equal(await session.start(),true);
  assert.equal(session.active,true);
  assert.equal(calls.socket.url,"wss://sparkle.test/api/voice/ws");
  assert.equal(calls.auth.token,"t".repeat(48));
  assert.equal(calls.session.type,"session.update");
  assert.equal(calls.session.session.audio.input.format.rate,24000);
  assert.equal(calls.session.session.audio.output.format.rate,24000);
  assert.deepEqual(calls.session.session.tools,[]);
  assert.match(calls.session.session.instructions,/SPARKLE shared conversation context/);
  assert.equal(calls.constraints.audio.echoCancellation,true);
  const samples=new Float32Array(4096);samples.fill(.2);
  calls.processor.onaudioprocess({inputBuffer:{sampleRate:48000,getChannelData:()=>samples},outputBuffer:{getChannelData:()=>new Float32Array(4096)}});
  assert.ok(calls.sent.some(value=>value instanceof ArrayBuffer),"microphone PCM16 should be sent as binary frames");
  calls.socket.emit({type:"conversation.item.input_audio_transcription.delta",delta:"hello "});
  calls.socket.emit({type:"conversation.item.input_audio_transcription.delta",delta:"SPARKLE"});
  calls.socket.emit({type:"conversation.item.input_audio_transcription.completed"});
  calls.socket.emit({type:"response.output_audio_transcript.delta",delta:"Hello "});
  calls.socket.emit({type:"response.output_audio_transcript.done",transcript:"Hello there"});
  assert.deepEqual(calls.partial.slice(0,2),[{role:"user",text:"hello "},{role:"user",text:"hello SPARKLE"}]);
  assert.deepEqual(calls.final,[{role:"user",text:"hello SPARKLE"},{role:"assistant",text:"Hello there"}]);
  calls.socket.emit({type:"response.output_audio.delta",delta:Buffer.from(new Int16Array([1000,-1000,500]).buffer).toString("base64")});
  assert.equal(calls.playback.length,1,"PCM audio should be scheduled for playback");
  calls.socket.emit({type:"input_audio_buffer.speech_started"});
  calls.socket.emit({type:"conversation.item.input_audio_transcription.completed",transcript:"hello SPARKLE"});
  assert.deepEqual(calls.final[2],{role:"user",text:"hello SPARKLE"},"the same words in a new turn must not be deduplicated");
  assert.ok(calls.sent.some(value=>typeof value==="string"&&JSON.parse(value).type==="response.cancel"));
  assert.ok(calls.stops>=1,"barge-in should stop queued playback");
  session.stop();
  assert.equal(session.active,false);
  assert.equal(track.stopped,true);
  assert.equal(calls.contextClosed,true);
  assert.equal(calls.closed.code,1000);
  assert.ok(calls.sent.some(value=>typeof value==="string"&&JSON.parse(value).type==="session.close"));
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
