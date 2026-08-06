import { describe, expect, it } from 'vitest';

import { classifyDelivery } from './delivery-direction';

describe('classifyDelivery', () => {
  it('skips our own API sends — send-message.ts already stored them', () => {
    expect(classifyDelivery({ wasSentByApi: true, fromMe: true })).toBe('skip');
    // Defensive: `fromMe` absent shouldn't change the verdict.
    expect(classifyDelivery({ wasSentByApi: true })).toBe('skip');
  });

  it('keeps messages typed on the phone / WhatsApp Web', () => {
    // The regression this rule exists for: these were skipped alongside
    // API sends, so a thread answered from the phone showed only the
    // customer's half in the CRM.
    expect(classifyDelivery({ fromMe: true, wasSentByApi: false })).toBe(
      'own-device'
    );
    expect(classifyDelivery({ fromMe: true })).toBe('own-device');
  });

  it('treats everything else as inbound', () => {
    expect(classifyDelivery({ fromMe: false, wasSentByApi: false })).toBe(
      'inbound'
    );
    expect(classifyDelivery({})).toBe('inbound');
  });
});
