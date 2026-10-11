import test from "node:test";
import assert from "node:assert/strict";
import { recoverInterruptedMessages } from "../src/core/chat-recovery.js";

test("recovery replaces persisted in-flight assistant placeholders", () => {
  const input = [
    { role: "user", html: "<p>Question</p>" },
    { role: "assistant", html: "<p>Thinking…</p>", pending: true },
    { role: "assistant", html: "<p>Earlier answer</p>" },
  ];
  const result = recoverInterruptedMessages(input);
  assert.equal(result.recovered, 1);
  assert.equal(result.messages[1].pending, undefined);
  assert.match(result.messages[1].html, /Response interrupted/);
  assert.match(result.messages[1].html, /Retry/);
  assert.equal(result.messages[0], input[0]);
  assert.equal(result.messages[2], input[2]);
  assert.equal(input[1].pending, true, "input remains immutable");
});

test("recovery safely handles missing or non-pending messages", () => {
  assert.deepEqual(recoverInterruptedMessages(null), { messages: [], recovered: 0 });
  const messages = [{ role: "assistant", html: "<p>Done</p>" }, { role: "user", html: "<p>Hi</p>", pending: true }];
  const result = recoverInterruptedMessages(messages);
  assert.equal(result.recovered, 0);
  assert.deepEqual(result.messages, messages);
});
