/**
 * Provider-agnostic outbound send contract. `meta-provider.ts` and
 * `uazapi-provider.ts` both implement this so call sites (send-
 * message.ts, the automations/flows engines, broadcast) stop calling
 * `meta-api.ts` directly and instead go through whichever provider
 * `resolve.ts` picked for the account/conversation.
 *
 * UAZAPI has no equivalent of Meta's approved-template system or
 * interactive button/list messages — `capabilities` lets a caller
 * check before attempting one of those, and the uazapi implementation
 * throws `ProviderNotSupportedError` if called anyway.
 */

import type { MessageTemplate } from '@/types';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import type {
  InteractiveButton,
  InteractiveListSection,
} from '@/lib/whatsapp/meta-api';

export interface ProviderSendResult {
  /** The provider's own id for the sent message (Meta's wamid, or UAZAPI's messageid). */
  messageId: string;
}

export interface SendTextInput {
  to: string;
  text: string;
  /** Id of the message being replied to, for a quoted reply. */
  contextMessageId?: string;
}

export interface SendMediaInput {
  to: string;
  kind: 'image' | 'video' | 'document' | 'audio';
  /** Public URL fetched by the provider at send time. */
  link: string;
  caption?: string;
  /** Document-only. */
  filename?: string;
  contextMessageId?: string;
}

export interface SendReactionInput {
  to: string;
  targetMessageId: string;
  /** Empty string removes an existing reaction. */
  emoji: string;
}

export interface SendTemplateInput {
  to: string;
  templateName: string;
  language?: string;
  template?: MessageTemplate;
  messageParams?: SendTimeParams;
  params?: string[];
  contextMessageId?: string;
}

export interface SendInteractiveButtonsInput {
  to: string;
  bodyText: string;
  headerText?: string;
  footerText?: string;
  buttons: InteractiveButton[];
  contextMessageId?: string;
}

export interface SendInteractiveListInput {
  to: string;
  bodyText: string;
  buttonLabel: string;
  headerText?: string;
  footerText?: string;
  sections: InteractiveListSection[];
  contextMessageId?: string;
}

export class ProviderNotSupportedError extends Error {
  constructor(feature: string, provider: string) {
    super(
      `${feature} is not supported on the ${provider} connection. This account needs a Meta connection for this feature.`
    );
    this.name = 'ProviderNotSupportedError';
  }
}

export interface WhatsAppProviderCapabilities {
  /** Approved-template sends (Meta Cloud API concept; UAZAPI has none). */
  templates: boolean;
  /** Interactive reply-button / list messages (Meta-only shape). */
  interactive: boolean;
}

export interface WhatsAppProvider {
  readonly name: 'meta' | 'uazapi';
  readonly capabilities: WhatsAppProviderCapabilities;
  sendText(input: SendTextInput): Promise<ProviderSendResult>;
  sendMedia(input: SendMediaInput): Promise<ProviderSendResult>;
  sendReaction(input: SendReactionInput): Promise<ProviderSendResult>;
  sendTemplate(input: SendTemplateInput): Promise<ProviderSendResult>;
  sendInteractiveButtons(
    input: SendInteractiveButtonsInput
  ): Promise<ProviderSendResult>;
  sendInteractiveList(
    input: SendInteractiveListInput
  ): Promise<ProviderSendResult>;
}
