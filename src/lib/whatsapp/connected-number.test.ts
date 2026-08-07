import { describe, it, expect } from 'vitest';

import { connectedNumberFrom } from './connected-number';

describe('connectedNumberFrom', () => {
  // The shape a live instance actually returned, captured from
  // /instance/status against the account's own connection.
  it('prefers instance.owner, which is already bare', () => {
    expect(
      connectedNumberFrom({
        owner: '554896274914',
        jid: '554896274914:14@s.whatsapp.net',
      }),
    ).toBe('554896274914');
  });

  it('falls back to the jid, without the device index or the domain', () => {
    expect(
      connectedNumberFrom({ jid: '554896274914:14@s.whatsapp.net' }),
    ).toBe('554896274914');
  });

  // A jid without a device suffix is equally valid.
  it('handles a jid with no device index', () => {
    expect(connectedNumberFrom({ jid: '554896274914@s.whatsapp.net' })).toBe(
      '554896274914',
    );
  });

  // UAZAPI returns "" rather than omitting fields it has no value for.
  it('treats an empty owner as absent and uses the jid', () => {
    expect(
      connectedNumberFrom({ owner: '', jid: '554896274914@s.whatsapp.net' }),
    ).toBe('554896274914');
  });

  it('returns null when neither field says anything', () => {
    expect(connectedNumberFrom({ owner: '', jid: '' })).toBeNull();
    expect(connectedNumberFrom({})).toBeNull();
  });

  // `status.jid` is typed `unknown` upstream; nothing guarantees a
  // string reaches this function.
  it('survives non-string values instead of throwing', () => {
    expect(connectedNumberFrom({ owner: null, jid: undefined })).toBeNull();
    expect(connectedNumberFrom({ owner: 42, jid: {} })).toBeNull();
  });

  it('strips punctuation an operator-entered number might carry', () => {
    expect(connectedNumberFrom({ owner: '+55 (48) 99627-4914' })).toBe(
      '5548996274914',
    );
  });
});
