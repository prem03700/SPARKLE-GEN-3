/** Convert persisted in-flight assistant placeholders into honest, retryable interruptions. */
export function recoverInterruptedMessages(messages) {
  if (!Array.isArray(messages)) return { messages: [], recovered: 0 };
  let recovered = 0;
  const result = messages.map(message => {
    if (!message || typeof message !== "object" || message.role !== "assistant" || message.pending !== true) return message;
    recovered += 1;
    const next = { ...message, html: "<p><strong>Response interrupted.</strong> The previous request did not finish in this browser session. Use Retry to try again.</p>" };
    delete next.pending;
    return next;
  });
  return { messages: result, recovered };
}
