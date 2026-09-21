interface UserMessageSender {
  sendUserMessage(content: string, options: { deliverAs: "steer" }): void;
}

export function queueCheckpointFeedback(sender: UserMessageSender, userText: string): string | undefined {
  const feedback = userText.trim();
  if (!feedback) return undefined;
  sender.sendUserMessage(feedback, { deliverAs: "steer" });
  return feedback;
}
