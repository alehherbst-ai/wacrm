'use client';

import { useAuth } from '@/hooks/use-auth';
import { UazapiConnect } from './uazapi-connect';

/**
 * The WhatsApp settings section.
 *
 * An account used to have exactly one number. Since migration 044 it
 * can hold one per operator, so this screen shows up to two cards:
 *
 *   - **Your line.** Whoever is signed in pairs their own phone here.
 *     Messages arriving on it land in their inbox and nobody else's.
 *     Shown to anyone who can send messages, because pairing needs the
 *     phone in hand — waiting on an admin to scan somebody else's QR
 *     code was never going to work.
 *   - **The house number.** The shared connection the account already
 *     had, kept for automations and for threads that belong to nobody
 *     in particular. Admin-only, and listed second: the personal line
 *     is what an operator came here for.
 *
 * Somebody with no send permission sees only the house card (read-only
 * by RLS), which is also what a solo account sees — one card, exactly
 * as before.
 */
export function WhatsappPanel() {
  const { canSendMessages, canEditSettings } = useAuth();

  return (
    <div className="space-y-6">
      {canSendMessages && <UazapiConnect scope="mine" />}
      {canEditSettings && <UazapiConnect scope="account" />}
      {/* Neither permission: still show the shared connection's state,
          so a viewer can tell whether the CRM is receiving at all. */}
      {!canSendMessages && !canEditSettings && <UazapiConnect scope="account" />}
    </div>
  );
}
