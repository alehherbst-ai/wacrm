/**
 * Which way a webhook delivery is going — and whether it's ours to
 * ignore. Pure, so the rule can be tested without a provider payload.
 *
 * The provider reports two independent booleans and conflating them is
 * what broke the thread history: every `fromMe` message was discarded
 * as "one of ours, already saved", when only `wasSentByApi` means that.
 * A message typed in the WhatsApp app on the phone is also `fromMe`,
 * has never been near this CRM, and is half of the conversation.
 *
 *   wasSentByApi | fromMe | verdict
 *   -------------|--------|--------------------------------------------
 *   true         | true   | skip — send-message.ts already stored it
 *   false        | true   | own-device — WE typed it elsewhere; store it
 *   false        | false  | inbound — the customer wrote; store it
 */
export type DeliveryDirection = 'skip' | 'own-device' | 'inbound';

export interface DeliveryDirectionInput {
  fromMe?: boolean;
  wasSentByApi?: boolean;
}

export function classifyDelivery(msg: DeliveryDirectionInput): DeliveryDirection {
  // `wasSentByApi` wins outright: it can only be true for a message this
  // application sent, which is already a row in `messages`.
  if (msg.wasSentByApi === true) return 'skip';
  return msg.fromMe === true ? 'own-device' : 'inbound';
}
