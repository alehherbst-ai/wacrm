'use client';

import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { UazapiConnect } from './uazapi-connect';

/**
 * The WhatsApp settings section — one line, and it is yours.
 *
 * This screen used to offer two cards: your own line, and a shared
 * "house number" belonging to nobody. The shared one is gone
 * (migration 051). It was the reason an arriving message could land
 * with no one responsible for it: a conversation on a line with no
 * operator has nobody to name, so a team of four saw "unassigned" and
 * no way to tell who the customer had been trying to reach.
 *
 * With one number per person, the number the message arrived on IS the
 * answer to that question, and the inbox can say so without anybody
 * having to claim the conversation first.
 *
 * Someone who cannot send messages has no line to pair — they read the
 * inbox, they do not answer from it — so they get an explanation
 * rather than a control that would fail.
 */
export function WhatsappPanel() {
  const { canSendMessages } = useAuth();
  const t = useTranslations('Settings.whatsapp');

  if (!canSendMessages) {
    return (
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="text-sm text-muted-foreground">{t('viewerOnly')}</p>
      </div>
    );
  }

  return <UazapiConnect />;
}
