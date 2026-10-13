import test from "node:test";
import assert from "node:assert/strict";
import { prepareStructuredAnswer, renderAnswerBlock, renderPreparedAnswer, validateAnswerBlock } from "../src/core/answer-renderer.js";

test("structured cards render escaped text and an inert follow-up control", () => {
  const result = validateAnswerBlock({title:"<unsafe>",body:"A card",prompt:"Explain more"}, "card");
  assert.equal(result.ok, true);
  const html = renderAnswerBlock(result.value);
  assert.match(html, /&lt;unsafe&gt;/);
  assert.match(html, /data-answer-prompt="Explain more"/);
  assert.doesNotMatch(html, /<unsafe>/);
  assert.doesNotMatch(html, /<script/i);
});

test("tables, charts and diagrams validate bounds and render accessible markup", () => {
  assert.match(renderAnswerBlock({title:"Results",columns:["Run","Value"],rows:[["A","3"]]}, "table"), /<table class="answer-table"/);
  assert.match(renderAnswerBlock({title:"Scores",items:[{label:"A",value:2},{label:"B",value:4}]}, "chart"), /role="img"/);
  assert.match(renderAnswerBlock({nodes:["Input","Process","Output"]}, "diagram"), /answer-diagram-arrow/);
  assert.equal(validateAnswerBlock({columns:["A"],rows:Array.from({length:31},()=>["x"])}, "table").ok, false);
  assert.equal(validateAnswerBlock({items:[{label:"bad",value:NaN}]}, "chart").ok, false);
  assert.equal(validateAnswerBlock({nodes:["only one"]}, "diagram").ok, false);
});

test("interactive line graphs validate finite bounded points and render animated SVG", () => {
  const valid = {title:"Slope",xLabel:"x",yLabel:"y",points:[{x:0,y:0},{x:1,y:2},{x:2,y:4}]};
  assert.equal(validateAnswerBlock(valid,"graph").ok,true);
  const html = renderAnswerBlock(valid,"graph");
  assert.match(html,/answer-graph-line/);
  assert.match(html,/<svg/);
  assert.equal(validateAnswerBlock({points:[{x:0,y:0},{x:Infinity,y:1}]},"graph").ok,false);
  assert.equal(validateAnswerBlock({points:[{x:0,y:0}]},"graph").ok,false);
  const tangent = {title:"y = x²",points:[{x:-2,y:4},{x:0,y:0},{x:2,y:4}],tangent:{kind:"quadratic",x:0}};
  assert.equal(validateAnswerBlock(tangent,"graph").ok,true);
  const tangentHTML = renderAnswerBlock(tangent,"graph");
  assert.match(tangentHTML,/data-tangent-slider/);
  assert.match(tangentHTML,/data-tangent-line/);
  assert.equal(validateAnswerBlock({...tangent,tangent:{kind:"unknown",x:0}},"graph").ok,false);
  assert.equal(validateAnswerBlock({...tangent,tangent:{kind:"quadratic",x:3}},"graph").ok,false);
});

test("robot arm payloads render accessible forward-kinematics controls and reject invalid links", () => {
  const block = {title:"Two link arm",link1:1.2,link2:0.8};
  assert.equal(validateAnswerBlock(block,"robot_arm").ok,true);
  const html = renderAnswerBlock(block,"robot_arm");
  assert.match(html,/data-angle="1"/);
  assert.match(html,/data-angle="2"/);
  assert.match(html,/data-arm-coordinates/);
  assert.match(html,/data-arm-reset/);
  assert.equal(validateAnswerBlock({...block,link1:0},"robot_arm").ok,false);
});

test("step explanations render navigable, escaped panels without executable markup", () => {
  const value = {title:"How it works",steps:[{title:"Input",body:"Receive data"},{title:"Output",body:"Return result <script>"}]};
  const html = renderAnswerBlock(value,"steps");
  assert.match(html,/data-step-next/);
  assert.match(html,/data-step-panel="1" hidden/);
  assert.match(html,/&lt;script&gt;/);
  assert.doesNotMatch(html,/<script/i);
  assert.equal(validateAnswerBlock({steps:[{title:"Only one",body:"Not enough"}]},"steps").ok,false);
});

test("only explicit valid SPARKLE JSON fences are upgraded; invalid content remains code", () => {
  const input = 'Before\n\n```sparkle-card\n{"title":"Plan","body":"Safe"}\n```\n\nAfter\n\n```sparkle-table\n{"columns":["x"],"rows":"invalid"}\n```';
  const prepared = prepareStructuredAnswer(input);
  assert.equal(prepared.blocks.length, 1);
  assert.match(prepared.text, /SPARKLEANSWERBLOCKTOKEN0END/);
  assert.match(prepared.text, /sparkle-table/);
  const html = renderPreparedAnswer(prepared.text, prepared.blocks);
  assert.match(html, /answer-card/);
  assert.match(html, /sparkle-table/);
});

test("recognized visual JSON in a generic fence renders as a diagram instead of raw JSON", () => {
  const input = '```json\n' + JSON.stringify({type:"diagram",title:"PID Control Loop",edges:[["Target Position","Error Calculation"],["Error Calculation","PID Controller"],["PID Controller","Motor Driver"],["Motor Driver","Robot Joint"],["Robot Joint","Sensor Feedback"],["Sensor Feedback","Error Calculation"]]}) + '\n```';
  const prepared = prepareStructuredAnswer(input);
  assert.equal(prepared.blocks.length,1);
  const html = renderPreparedAnswer("<p>"+prepared.text+"</p>",prepared.blocks);
  assert.match(html,/answer-diagram/);
  assert.match(html,/Sensor Feedback/);
  assert.doesNotMatch(html,/<pre class="response-code"><code>json/);
});
