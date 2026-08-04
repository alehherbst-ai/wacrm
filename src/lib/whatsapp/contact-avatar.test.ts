import { describe, it, expect } from 'vitest';
import { shouldSyncAvatar } from './contact-avatar';

const NOW = Date.parse('2026-08-04T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

describe('shouldSyncAvatar', () => {
  it('syncs a contact that has never been attempted', () => {
    expect(shouldSyncAvatar({}, NOW)).toBe(true);
    expect(shouldSyncAvatar({ avatar_synced_at: null }, NOW)).toBe(true);
  });

  it('skips a contact synced recently', () => {
    expect(shouldSyncAvatar({ avatar_synced_at: daysAgo(1) }, NOW)).toBe(false);
    expect(shouldSyncAvatar({ avatar_synced_at: daysAgo(6) }, NOW)).toBe(false);
  });

  it('re-syncs once the stored picture is over a week old', () => {
    expect(shouldSyncAvatar({ avatar_synced_at: daysAgo(8) }, NOW)).toBe(true);
  });

  /**
   * The gate is on the ATTEMPT, not the result. A contact who hides
   * their picture under WhatsApp's privacy settings never gets a URL,
   * and keying off `avatar_url` would re-ask the provider on every
   * message they ever send.
   */
  it('skips a recently-attempted contact that has no picture at all', () => {
    expect(shouldSyncAvatar({ avatar_synced_at: daysAgo(2) }, NOW)).toBe(false);
  });

  /**
   * A garbage timestamp compares as NaN, and `NaN > threshold` is
   * false — so a naive check would wedge the contact into never
   * refreshing again. Treat it as never-synced instead.
   */
  it('treats an unparseable timestamp as never synced', () => {
    expect(shouldSyncAvatar({ avatar_synced_at: 'not-a-date' }, NOW)).toBe(true);
  });
});
