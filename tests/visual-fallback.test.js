import test from "node:test";
import assert from "node:assert/strict";
import { visualFallback } from "../src/core/visual-fallback.js";

test("ordinary questions stay ordinary when the model returns prose", () => {
  const answer = "A graph is a structure made of vertices and edges.";
  assert.equal(visualFallback(answer, "What is a graph in computer science?"), answer);
  assert.equal(visualFallback("A derivative measures instantaneous rate of change.", "What is a derivative?"), "A derivative measures instantaneous rate of change.");
});

test("explicit visual requests produce the appropriate bounded block", () => {
  const graph = visualFallback("The curve is shown below.", "Show me the derivative and moving tangent for y=x^2");
  assert.match(graph, /sparkle-graph/);
  assert.match(graph, /"tangent":\{"kind":"quadratic","x":0\}/);
  const steps = visualFallback("Let's walk through it.", "Show a binary search walkthrough for [2, 4, 6, 8, 10], find 8");
  assert.match(steps, /sparkle-steps/);
  assert.match(steps, /Target found at index/);
  const arm = visualFallback("Here is the mechanism.", "Draw a robot arm and show forward kinematics");
  assert.match(arm, /sparkle-robot_arm/);
  const diagram = visualFallback("Architecture:", "Draw a system diagram for a robot perception feedback loop");
  assert.match(diagram, /sparkle-diagram/);
});

test("existing structured output is not duplicated and unrelated prose is preserved", () => {
  const structured = "Already visual\n\n" + "`".repeat(3) + "sparkle-card\n" + JSON.stringify({title:"Plan",body:"A plan"}) + "\n" + "`".repeat(3);
  assert.equal(visualFallback(structured, "Draw a diagram"), structured);
  assert.equal(visualFallback("Plain answer", "Explain the difference between sorting algorithms"), "Plain answer");
});
