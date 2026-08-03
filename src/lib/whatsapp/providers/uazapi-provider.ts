/**
 * UAZAPI implementation of `WhatsAppProvider`. Only text/media/
 * reaction are real — UAZAPI has no equivalent of Meta's approved
 * templates or interactive button/list messages, so those three
 * throw `ProviderNotSupportedError` (`capabilities` lets a caller
 * check first and fail with a clearer, feature-specific message).
 */

import {
  sendText as uazapiSendText,
  sendMedia as uazapiSendMedia,
  sendReaction as uazapiSendReaction,
} from '@/lib/whatsapp/uazapi-api';
import {
  ProviderNotSupportedError,
  type WhatsAppProvider,
  type SendTextInput,
  type SendMediaInput,
  type SendReactionInput,
  type ProviderSendResult,
} from './types';

export interface UazapiProviderConfig {
  instanceToken: string;
}

export function createUazapiProvider(
  config: UazapiProviderConfig
): WhatsAppProvider {
  const { instanceToken } = config;

  return {
    name: 'uazapi',
    capabilities: { templates: false, interactive: false },

    async sendText({
      to,
      text,
      contextMessageId,
    }: SendTextInput): Promise<ProviderSendResult> {
      const result = await uazapiSendText({
        instanceToken,
        to,
        text,
        replyId: contextMessageId,
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
      const result = await uazapiSendMedia({
        instanceToken,
        to,
        kind,
        file: link,
        caption,
        filename,
        replyId: contextMessageId,
      });
      return { messageId: result.messageId };
    },

    async sendReaction({
      to,
      targetMessageId,
      emoji,
    }: SendReactionInput): Promise<ProviderSendResult> {
      const result = await uazapiSendReaction({
        instanceToken,
        to,
        targetMessageId,
        emoji,
      });
      return { messageId: result.messageId };
    },

    async sendTemplate(): Promise<ProviderSendResult> {
      throw new ProviderNotSupportedError('Message templates', 'uazapi');
    },

    async sendInteractiveButtons(): Promise<ProviderSendResult> {
      throw new ProviderNotSupportedError('Interactive button messages', 'uazapi');
    },

    async sendInteractiveList(): Promise<ProviderSendResult> {
      throw new ProviderNotSupportedError('Interactive list messages', 'uazapi');
    },
  };
}
