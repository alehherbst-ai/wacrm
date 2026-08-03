/**
 * Meta implementation of `WhatsAppProvider`. Thin wrapper over
 * `meta-api.ts` — behaviour is byte-for-byte identical to the calls
 * every send call site made directly before the provider layer
 * existed; only the call shape changed.
 */

import {
  sendTextMessage,
  sendMediaMessage,
  sendReactionMessage,
  sendTemplateMessage,
  sendInteractiveButtons as metaSendInteractiveButtons,
  sendInteractiveList as metaSendInteractiveList,
} from '@/lib/whatsapp/meta-api';
import type {
  WhatsAppProvider,
  SendTextInput,
  SendMediaInput,
  SendReactionInput,
  SendTemplateInput,
  SendInteractiveButtonsInput,
  SendInteractiveListInput,
  ProviderSendResult,
} from './types';

export interface MetaProviderConfig {
  phoneNumberId: string;
  accessToken: string;
}

export function createMetaProvider(
  config: MetaProviderConfig
): WhatsAppProvider {
  const { phoneNumberId, accessToken } = config;

  return {
    name: 'meta',
    capabilities: { templates: true, interactive: true },

    async sendText({
      to,
      text,
      contextMessageId,
    }: SendTextInput): Promise<ProviderSendResult> {
      const result = await sendTextMessage({
        phoneNumberId,
        accessToken,
        to,
        text,
        contextMessageId,
      });
      return { messageId: result.messageId };
    },

    async sendMedia({
      to,
      kind,
      link,
      caption,
      filename,
      contextMessageId,
    }: SendMediaInput): Promise<ProviderSendResult> {
      const result = await sendMediaMessage({
        phoneNumberId,
        accessToken,
        to,
        kind,
        link,
        caption,
        filename,
        contextMessageId,
      });
      return { messageId: result.messageId };
    },

    async sendReaction({
      to,
      targetMessageId,
      emoji,
    }: SendReactionInput): Promise<ProviderSendResult> {
      const result = await sendReactionMessage({
        phoneNumberId,
        accessToken,
        to,
        targetMessageId,
        emoji,
      });
      return { messageId: result.messageId };
    },

    async sendTemplate({
      to,
      templateName,
      language,
      template,
      messageParams,
      params,
      contextMessageId,
    }: SendTemplateInput): Promise<ProviderSendResult> {
      const result = await sendTemplateMessage({
        phoneNumberId,
        accessToken,
        to,
        templateName,
        language,
        template,
        messageParams,
        params,
        contextMessageId,
      });
      return { messageId: result.messageId };
    },

    async sendInteractiveButtons({
      to,
      bodyText,
      headerText,
      footerText,
      buttons,
      contextMessageId,
    }: SendInteractiveButtonsInput): Promise<ProviderSendResult> {
      const result = await metaSendInteractiveButtons({
        phoneNumberId,
        accessToken,
        to,
        bodyText,
        headerText,
        footerText,
        buttons,
        contextMessageId,
      });
      return { messageId: result.messageId };
    },

    async sendInteractiveList({
      to,
      bodyText,
      buttonLabel,
      headerText,
      footerText,
      sections,
      contextMessageId,
    }: SendInteractiveListInput): Promise<ProviderSendResult> {
      const result = await metaSendInteractiveList({
        phoneNumberId,
        accessToken,
        to,
        bodyText,
        buttonLabel,
        headerText,
        footerText,
        sections,
        contextMessageId,
      });
      return { messageId: result.messageId };
    },
  };
}
