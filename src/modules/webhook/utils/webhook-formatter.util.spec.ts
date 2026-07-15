import {
  generateWebhookGenericText,
  enrichWebhookPayload,
} from './webhook-formatter.util';
import { WebhookPayload } from '../webhook.service';

describe('Webhook Formatter Utility', () => {
  const testPayload: WebhookPayload = {
    event: 'test',
    timestamp: '2026-07-15T00:00:00.000Z',
    sessionId: 'sess-123',
    idempotencyKey: 'idem-123',
    deliveryId: 'del-123',
    data: {
      message: 'Hello World',
    },
  };

  const messagePayload: WebhookPayload = {
    event: 'message.received',
    timestamp: '2026-07-15T00:00:00.000Z',
    sessionId: 'sess-123',
    idempotencyKey: 'idem-456',
    deliveryId: 'del-456',
    data: {
      from: '628123456789@c.us',
      pushname: 'John Doe',
      body: 'Hello, this is a test message!',
    },
  };

  describe('generateWebhookGenericText', () => {
    it('should format test event correctly', () => {
      const result = generateWebhookGenericText(testPayload.event, testPayload.sessionId, testPayload.data);
      expect(result).toContain('🔔 *OpenWA Webhook Test*');
      expect(result).toContain('sess-123');
      expect(result).toContain('Hello World');
    });

    it('should format message.received event correctly', () => {
      const result = generateWebhookGenericText(messagePayload.event, messagePayload.sessionId, messagePayload.data);
      expect(result).toContain('📩 *WhatsApp Message Received*');
      expect(result).toContain('628123456789@c.us');
      expect(result).toContain('John Doe');
      expect(result).toContain('Hello, this is a test message!');
    });

    it('should format other events as generic json blocks', () => {
      const result = generateWebhookGenericText('custom.event', 'sess-123', { foo: 'bar' });
      expect(result).toContain('*OpenWA Event:* `custom.event`');
      expect(result).toContain('foo');
      expect(result).toContain('bar');
    });
  });

  describe('enrichWebhookPayload', () => {
    it('should enrich payload with content and text fields', () => {
      const result = enrichWebhookPayload(testPayload);
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('text');
      expect(result.content).toBe(result.text);
      expect(result.content).toContain('🔔 *OpenWA Webhook Test*');
    });
  });
});
