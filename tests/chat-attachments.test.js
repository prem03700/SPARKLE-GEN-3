import test from "node:test";
import assert from "node:assert/strict";
import { validateChatAttachment, messageContentWithAttachment } from "../src/core/chat-attachments.js";

const file = (name, size = 12) => ({ name, size });

test("chat attachment accepts small supported text and source files", () => {
  const result = validateChatAttachment(file("robot.py"), "print('hello')\n");
  assert.equal(result.ok, true);
  assert.deepEqual(result.attachment, { name: "robot.py", content: "print('hello')\n" });
});

test("chat attachment rejects unsupported, oversized, empty, binary, and long files", () => {
  assert.equal(validateChatAttachment(file("photo.png"), "text").ok, false);
  assert.equal(validateChatAttachment(file("max.txt", 1024 * 1024), "text").ok, true);
  assert.match(validateChatAttachment(file("large.txt", 1024 * 1024 + 1), "text").error, /1 MB/);
  assert.match(validateChatAttachment(file("empty.txt"), "  ").error, /empty/);
  assert.match(validateChatAttachment(file("binary.txt"), "a\0b").error, /Binary/);
  assert.equal(validateChatAttachment(file("max-chars.txt"), "x".repeat(100000)).ok, true);
  assert.match(validateChatAttachment(file("long.txt"), "x".repeat(100001)).error, /100,000/);
});

test("chat prompt includes attachment content while ordinary messages remain unchanged", () => {
  const htmlText = value => String(value).replace(/<[^>]+>/g, "");
  assert.equal(messageContentWithAttachment({ html: "<p>Hello</p>" }, htmlText), "Hello");
  assert.equal(
    messageContentWithAttachment({ html: "<p>Review this</p>", attachmentName: "robot.py", attachmentContent: "print(1)" }, htmlText),
    "Review this\n\n[Attached text file: robot.py]\nprint(1)"
  );
});
