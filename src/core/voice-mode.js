/** Browser-native speech helpers for the opt-in voice conversation mode. */
export function getSpeechRecognitionConstructor(scope = globalThis) {
  return scope.SpeechRecognition || scope.webkitSpeechRecognition || null;
}

export function browserVoiceSupport(scope = globalThis) {
  return {
    recognition: typeof getSpeechRecognitionConstructor(scope) === "function",
    synthesis: Boolean(scope.speechSynthesis && typeof scope.SpeechSynthesisUtterance === "function")
  };
}

export function takeVoiceChunks(buffer, final = false) {
  let remaining = String(buffer || "");
  const chunks = [];
  let start = 0, inCode = false, lastBoundary = -1;
  for (let i = 0; i < remaining.length; i++) {
    if (remaining.slice(i, i + 3) === "```") { inCode = !inCode; i += 2; continue; }
    if (!inCode && ((/[.!?]/.test(remaining[i]) && /\s/.test(remaining[i + 1] || "")) || remaining.slice(i, i + 2) === "\n\n")) {
      const end = i + (remaining.slice(i, i + 2) === "\n\n" ? 2 : 1);
      const raw = remaining.slice(start, end).trim();
      const spoken = voiceTextFromMarkdown(raw);
      if (spoken) chunks.push(spoken);
      start = end;
      if (remaining[i] === "\n") i++;
      lastBoundary = start;
    }
  }
  if (start > 0) remaining = remaining.slice(start);
  if (!final && inCode) return { chunks: [], remainder: String(buffer || "") };
  if (!final && remaining.length > 900) {
    const splitAt = remaining.lastIndexOf(" ", 900);
    if (splitAt > 200) {
      const spoken = voiceTextFromMarkdown(remaining.slice(0, splitAt));
      if (spoken) chunks.push(spoken);
      remaining = remaining.slice(splitAt + 1);
    }
  }
  if (final && remaining.trim()) {
    const tail = inCode ? remaining.replace(/```[\s\S]*$/, " Code omitted from spoken response. ") : remaining;
    const spoken = voiceTextFromMarkdown(tail);
    if (spoken) chunks.push(spoken);
    remaining = "";
  }
  return { chunks, remainder: remaining };
}

export function voiceTextFromMarkdown(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, " Code omitted from spoken response. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/_(.*?)_/g, "$1")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/[{}*_#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5000);
}
