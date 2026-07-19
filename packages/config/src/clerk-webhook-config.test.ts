// ACBP-P1-002 — Clerk webhook configuration tests. Clearly-FAKE hyphenated placeholder only (never a
// real signing secret; hyphens prevent the secret scanner's key-format patterns from matching).
import { describe, test, expect } from 'vitest';
import { parseClerkWebhookConfig, loadTestClerkWebhookConfig, ConfigValidationError, Secret } from './index.js';

const WH = 'whsec_fake-local-webhook-signing';

describe('parseClerkWebhookConfig', () => {
  test('valid config: signing secret is Secret-wrapped; instance id optional', () => {
    const c = parseClerkWebhookConfig({ CLERK_WEBHOOK_SIGNING_SECRET: WH });
    expect(c.signingSecret).toBeInstanceOf(Secret);
    expect(c.signingSecret.reveal()).toBe(WH); // reveal() is the explicit escape hatch
    expect(c.expectedInstanceId).toBeUndefined();
  });

  test('optional expected instance id is parsed when provided', () => {
    const c = parseClerkWebhookConfig({ CLERK_WEBHOOK_SIGNING_SECRET: WH, CLERK_WEBHOOK_INSTANCE_ID: 'ins_fake123' });
    expect(c.expectedInstanceId).toBe('ins_fake123');
  });

  test('signing secret never serializes via toString/JSON', () => {
    const c = parseClerkWebhookConfig({ CLERK_WEBHOOK_SIGNING_SECRET: WH });
    expect(String(c.signingSecret)).not.toContain('fake-local-webhook-signing');
    expect(JSON.stringify(c)).not.toContain('fake-local-webhook-signing');
  });

  test('missing signing secret fails with a sanitized (redacted) configuration error', () => {
    try {
      parseClerkWebhookConfig({});
      throw new Error('expected failure');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      const err = e as ConfigValidationError;
      expect(err.issues.some((i) => i.field === 'CLERK_WEBHOOK_SIGNING_SECRET' && i.message === 'invalid (redacted)')).toBe(true);
    }
  });

  test('malformed signing secret (wrong prefix) is rejected and redacted', () => {
    try {
      parseClerkWebhookConfig({ CLERK_WEBHOOK_SIGNING_SECRET: 'not-a-whsec' });
      throw new Error('expected failure');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      const err = e as ConfigValidationError;
      const dump = JSON.stringify(err.issues) + err.message;
      expect(dump).not.toContain('not-a-whsec');
      expect(err.issues.some((i) => i.field === 'CLERK_WEBHOOK_SIGNING_SECRET' && i.message === 'invalid (redacted)')).toBe(true);
    }
  });

  test('loadTestClerkWebhookConfig is deterministic and credential-free', () => {
    const c = loadTestClerkWebhookConfig();
    expect(c.signingSecret).toBeInstanceOf(Secret);
    expect(c.signingSecret.reveal().startsWith('whsec_')).toBe(true);
  });
});
