const MAX_BYTES = 48 * 1024;
const MAX_CHARS = 9000;
const SUPPORTED_EXTENSIONS = new Set([
  "txt", "md", "csv", "json", "py", "js", "ts", "tsx", "jsx", "html", "css",
  "yaml", "yml", "toml", "log", "xml", "sql", "sh", "c", "h", "cpp", "hpp",
  "java", "rs", "go"
]);

export function validateChatAttachment(file, content) {
  const name = typeof file?.name === "string" ? file.name : "";
  const extension = name.includes(".") ? name.split(".").at(-1).toLowerCase() : "";
  if (!SUPPORTED_EXTENSIONS.has(extension)) return { ok: false, error: "Choose a supported text or source-code file." };
  if (!Number.isFinite(file?.size) || file.size < 0 || file.size > MAX_BYTES) {
    return { ok: false, error: "Chat attachments are limited to 48 KB." };
  }
  if (typeof content !== "string" || !content.trim()) return { ok: false, error: "The selected file is empty or unreadable." };
  if (content.includes("\0")) return { ok: false, error: "Binary files are not supported in chat yet." };
  if (content.length > MAX_CHARS) return { ok: false, error: "This file has more than 9,000 characters. Trim it or split it before attaching." };
  return { ok: true, attachment: { name: name.slice(0, 160), content } };
}

export function messageContentWithAttachment(message, htmlText) {
  const text = htmlText(message?.html || "");
  if (typeof message?.attachmentContent !== "string" || !message.attachmentContent) return text;
  const name = String(message.attachmentName || "attachment").slice(0, 160);
  return text + "\n\n[Attached text file: " + name + "]\n" + message.attachmentContent.slice(0, MAX_CHARS);
}
