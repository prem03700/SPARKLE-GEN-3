import test from "node:test";
import assert from "node:assert/strict";
import { validateStreamEvent } from "../src/core/contracts.js";

test("stream contracts accept current SSE events and bounded optional UI events", () => {
  assert.equal(validateStreamEvent("meta", {model:"test"}).ok, true);
  assert.equal(validateStreamEvent("delta", {text:"hello"}).ok, true);
  assert.equal(validateStreamEvent("done", {answer:"complete",elapsed_ms:20}).ok, true);
  assert.equal(validateStreamEvent("status", {stage:"thinking",message:"Preparing"}).ok, true);
  assert.equal(validateStreamEvent("answer_block", {block:{type:"card",title:"A",body:"Card content"}}).ok, true);
  assert.equal(validateStreamEvent("answer_block", {block:{type:"graph",points:[{x:0,y:0},{x:1,y:1}]}}).ok, true);
  assert.equal(validateStreamEvent("answer_block", {block:{type:"steps",steps:[{title:"One",body:"Start"},{title:"Two",body:"Finish"}]}}).ok, true);
  assert.equal(validateStreamEvent("answer_block", {block:{type:"robot_arm",link1:1,link2:1}}).ok, true);
  assert.equal(validateStreamEvent("answer_block", {block:{type:"graph",points:[{x:-1,y:1},{x:0,y:0},{x:1,y:1}],tangent:{kind:"quadratic",x:0}}}).ok, true);
  assert.equal(validateStreamEvent("answer_block", {block:{type:"graph",points:[{x:-1,y:1},{x:1,y:1}],tangent:{kind:"arbitrary",x:0}}}).ok, false);
  assert.equal(validateStreamEvent("image_result", {artifact_id:"a".repeat(32)}).ok, true);
  assert.equal(validateStreamEvent("voice_event", {type:"transcript"}).ok, true);
});

test("stream contracts reject unknown events, oversized deltas and malformed artifact IDs", () => {
  assert.equal(validateStreamEvent("execute_code", {}).ok, false);
  assert.equal(validateStreamEvent("delta", {text:"x".repeat(12001)}).ok, false);
  assert.equal(validateStreamEvent("image_result", {artifact_id:"../private"}).ok, false);
  assert.equal(validateStreamEvent("done", {answer:"ok",elapsed_ms:-1}).ok, false);
  assert.equal(validateStreamEvent("answer_block", {block:{type:"script"}}).ok, false);
  assert.equal(validateStreamEvent("answer_block", {block:{type:"graph",points:"invalid"}}).ok, false);
});
