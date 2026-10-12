import test from "node:test";
import assert from "node:assert/strict";
import { browserVoiceSupport, getSpeechRecognitionConstructor, voiceTextFromMarkdown, takeVoiceChunks } from "../src/core/voice-mode.js";

test("voice capability detection supports standard and Chromium-prefixed recognition APIs",()=>{
  function StandardRecognition() {}
  function Utterance() {}
  const standard={SpeechRecognition:StandardRecognition,speechSynthesis:{speak(){}},SpeechSynthesisUtterance:Utterance};
  assert.equal(getSpeechRecognitionConstructor(standard),StandardRecognition);
  assert.deepEqual(browserVoiceSupport(standard),{recognition:true,synthesis:true});
  const prefixed={webkitSpeechRecognition:StandardRecognition,speechSynthesis:{cancel(){}},SpeechSynthesisUtterance:Utterance};
  assert.equal(getSpeechRecognitionConstructor(prefixed),StandardRecognition);
  assert.deepEqual(browserVoiceSupport(prefixed),{recognition:true,synthesis:true});
});

test("voice capability detection reports unsupported browser APIs without throwing",()=>{
  assert.deepEqual(browserVoiceSupport({}),{recognition:false,synthesis:false});
  assert.deepEqual(browserVoiceSupport({SpeechRecognition:function(){}}),{recognition:true,synthesis:false});
});

test("spoken text strips markdown, URLs, and code blocks and stays bounded",()=>{
  const spoken=voiceTextFromMarkdown("## Hello **there**\n- Read [the docs](https://example.com)\n```python\nprint('secret code')\n```\nUse `x = 1`.");
  assert.match(spoken,/Hello there/);
  assert.match(spoken,/the docs/);
  assert.match(spoken,/Code omitted from spoken response/);
  assert.doesNotMatch(spoken,/https:\/\//);
  assert.doesNotMatch(spoken,/secret code/);
  assert.ok(voiceTextFromMarkdown("a".repeat(6000)).length<=5000);
});


test("voice streaming emits complete sentences early and preserves unfinished text",()=>{
  const first=takeVoiceChunks("Hello there. Next sentence is still arriving",false);
  assert.deepEqual(first.chunks,["Hello there."]);
  assert.equal(first.remainder," Next sentence is still arriving");
  const last=takeVoiceChunks(first.remainder,true);
  assert.deepEqual(last.chunks,["Next sentence is still arriving"]);
  assert.equal(last.remainder,"");
});

test("voice streaming does not speak code fences and bounds long sentence chunks",()=>{
  const partial=takeVoiceChunks("Read this. ```python\nprint(1.2)",false);
  assert.deepEqual(partial.chunks,[]);
  const complete=takeVoiceChunks("Read this. ```python\nprint(1.2)\n``` Then finish.",true);
  assert.equal(complete.chunks.some(chunk=>chunk.includes("print")),false);
  assert.ok(complete.chunks.join(" ").includes("Code omitted from spoken response"));
  const long=takeVoiceChunks("word ".repeat(250),false);
  assert.ok(long.chunks.length>0);
  assert.ok(long.chunks.every(chunk=>chunk.length<=900));
});
