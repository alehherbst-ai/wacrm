// ============================================================
// Which phone number is actually connected to a UAZAPI instance.
//
// Nothing in our own database knows this. `whatsapp_config` holds the
// instance id and token, not the line behind them — the number is
// chosen on the phone, when someone scans the QR code, so only UAZAPI
// can say what it turned out to be.
//
// `/instance/status` reports it twice, in two shapes:
//
//   instance.owner  "554896274914"
//   status.jid      "554896274914:14@s.whatsapp.net"
//
// `owner` is already the bare number, so it wins. The jid is the
// fallback, and it needs unpicking: `:14` is the device/session index
// (a second phone linked to the same account gets `:15`), and
// `@s.whatsapp.net` is the routing domain. Neither belongs in a number
// shown to a person.
// ============================================================

/**
 * The connected line, as bare digits, or null when the instance has
 * not told us one — which is the normal state before a QR code is
 * scanned, not an error.
 */
export function connectedNumberFrom(args: {
  owner?: unknown;
  jid?: unknown;
}): string | null {
  const fromOwner = digitsOf(args.owner);
  if (fromOwner) return fromOwner;

  // "554896274914:14@s.whatsapp.net" → "554896274914"
  if (typeof args.jid === 'string') {
    const beforeDomain = args.jid.split('@')[0];
    const beforeDevice = beforeDomain.split(':')[0];
    return digitsOf(beforeDevice);
  }

  return null;
}

/**
 * Keep only digits, and treat an empty result as absent.
 *
 * UAZAPI returns `""` for fields it has no value for (the account's
 * `uazapi_instance_name` is stored that way too), and an empty string
 * is not a number — rendering one would put a stray label on screen
 * with nothing after it.
 */
function digitsOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}
