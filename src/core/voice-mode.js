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
