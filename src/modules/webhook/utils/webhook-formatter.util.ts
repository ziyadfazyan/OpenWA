import { WebhookPayload } from '../webhook.service';

/**
 * Generate a generic markdown-formatted text representation of the webhook event.
 * Compatible with Discord (expects "content") and Slack (expects "text").
 */
export function generateWebhookGenericText(event: string, sessionId: string, data: Record<string, unknown>): string {
  if (event === 'test') {
    return `🔔 *OpenWA Webhook Test*\n- *Session ID:* \`${sessionId}\`\n- *Message:* ${data.message || 'Connected successfully!'}`;
  }
  if (event === 'message.received') {
    const from = String(data.from || 'Unknown');
    const senderName = String(data.pushname || (data.sender && (data.sender as any).pushname) || 'Unknown Sender');
    const body = String(data.body || (data.type !== 'chat' ? `[Media: ${data.type}]` : 'Empty Message'));
    return `📩 *WhatsApp Message Received*\n- *From:* \`${from}\` (${senderName})\n- *Message:* ${body}`;
  }
  return `*OpenWA Event:* \`${event}\` (Session: \`${sessionId}\`)\n\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 1500)}\n\`\`\``;
}

export function enrichWebhookPayload(payload: WebhookPayload): WebhookPayload {
  const text = generateWebhookGenericText(payload.event, payload.sessionId, payload.data);
  return {
    ...payload,
    content: text,
    text,
  };
}
