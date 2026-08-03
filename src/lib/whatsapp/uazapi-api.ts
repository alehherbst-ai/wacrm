/**
 * UAZAPI (unofficial WhatsApp API, QR-code based) HTTP client.
 *
 * Mirrors meta-api.ts's shape — named-params functions, throws Error
 * on a non-2xx response — but the auth model is different:
 *   - `admintoken` header: instance creation only. Server-side admin
 *     credential (env `UAZAPI_ADMIN_TOKEN`), never sent to the client.
 *   - `token` header: every other call, using the instance's own
 *     token (returned by createInstance, stored encrypted per-row in
 *     whatsapp_config.uazapi_instance_token).
 *
 * See https://{subdomain}.uazapi.com — this client targets
 * `UAZAPI_BASE_URL` (the account's UAZAPI server, SaaS-hosted).
 */

function requireBaseUrl(): string {
  const base = process.env.UAZAPI_BASE_URL;
  if (!base) {
    throw new Error(
      'UAZAPI_BASE_URL is not configured. Set it in your environment to use the UAZAPI connection.'
    );
  }
  return base.replace(/\/+$/, '');
}

interface UazapiErrorResponse {
  error?: string;
  message?: string;
}

async function throwUazapiError(
  response: Response,
  fallback: string
): Promise<never> {
  let message = fallback;
  try {
    const data = (await response.json()) as UazapiErrorResponse;
    message = data.error || data.message || fallback;
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message);
}

// ============================================================
// Instance lifecycle
// ============================================================

export type UazapiInstanceStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'hibernated';

export interface UazapiInstance {
  id: string;
  token: string;
  status: UazapiInstanceStatus;
  /** Base64 QR code image — ready for `<img src>`. Present while `status === 'connecting'` and no `phone` was given. */
  qrcode?: string;
  /** Pairing code — present instead of `qrcode` when `phone` was given to connectInstance. */
  paircode?: string;
  name?: string;
  profileName?: string;
}

export interface CreateInstanceArgs {
  adminToken: string;
  /** Instance name — shown in the UAZAPI dashboard, not user-facing in this app. */
  name: string;
}

/**
 * Create a new UAZAPI instance. Requires the server-side admin token
 * (never exposed to the client). Returns the instance's own token,
 * which every subsequent call for this connection authenticates with.
 */
export async function createInstance(
  args: CreateInstanceArgs
): Promise<UazapiInstance> {
  const { adminToken, name } = args;
  const response = await fetch(`${requireBaseUrl()}/instance/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', admintoken: adminToken },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`);
  }
  const data = (await response.json()) as { instance?: UazapiInstance };
  if (!data.instance) {
    throw new Error('UAZAPI accepted the request but returned no instance.');
  }
  return data.instance;
}

export interface ConnectInstanceArgs {
  instanceToken: string;
  /**
   * Phone in international format (digits only). Omit to receive a
   * QR code instead of a pairing code — this app always omits it, QR
   * is the UX the settings screen offers.
   */
  phone?: string;
}

export interface ConnectInstanceResult {
  connected: boolean;
  loggedIn: boolean;
  instance: UazapiInstance;
}

/**
 * Start (or resume) the connection handshake. Returns a QR code in
 * `instance.qrcode`; the caller must poll `getInstanceStatus` until
 * `status.connected` — UAZAPI gives ~2 minutes before the QR expires.
 */
export async function connectInstance(
  args: ConnectInstanceArgs
): Promise<ConnectInstanceResult> {
  const { instanceToken, phone } = args;
  const response = await fetch(`${requireBaseUrl()}/instance/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: instanceToken },
    body: JSON.stringify(phone ? { phone } : {}),
  });
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`);
  }
  return response.json();
}

export interface InstanceStatusResult {
  instance: UazapiInstance;
  status: {
    connected: boolean;
    loggedIn: boolean;
    jid: unknown;
  };
}

/** Poll target for the connect flow, and a general health check afterwards. */
export async function getInstanceStatus(
  instanceToken: string
): Promise<InstanceStatusResult> {
  const response = await fetch(`${requireBaseUrl()}/instance/status`, {
    headers: { token: instanceToken },
  });
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`);
  }
  return response.json();
}

/** Ends the WhatsApp session; a fresh QR code is required to reconnect. */
export async function disconnectInstance(instanceToken: string): Promise<void> {
  const response = await fetch(`${requireBaseUrl()}/instance/disconnect`, {
    method: 'POST',
    headers: { token: instanceToken },
  });
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`);
  }
}

export interface ConfigureWebhookArgs {
  instanceToken: string;
  url: string;
  events?: string[];
}

/**
 * "Simple mode" webhook config — one webhook per instance, created or
 * updated automatically (no `action`/`id` bookkeeping). Always
 * excludes `wasSentByApi` so our own outbound sends don't loop back
 * in as inbound events — UAZAPI's own docs recommend this.
 */
export async function configureWebhook(args: ConfigureWebhookArgs): Promise<void> {
  const { instanceToken, url, events } = args;
  const response = await fetch(`${requireBaseUrl()}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: instanceToken },
    body: JSON.stringify({
      url,
      // UAZAPI's Webhook schema defaults `enabled` to false — omitting
      // this field silently registers a *disabled* webhook (the request
      // succeeds with a 200, so there's no error to catch). Confirmed
      // against a live instance: URL + secret were both correct, but no
      // events ever arrived because `enabled` was never sent as `true`.
      enabled: true,
      events: events ?? ['messages'],
      excludeMessages: ['wasSentByApi'],
    }),
  });
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`);
  }
}

// ============================================================
// Sending
// ============================================================

export interface UazapiSendResult {
  messageId: string;
}

export interface SendTextArgs {
  instanceToken: string;
  to: string;
  text: string;
  /** UAZAPI's `id` of the message being replied to. */
  replyId?: string;
}

export async function sendText(args: SendTextArgs): Promise<UazapiSendResult> {
  const { instanceToken, to, text, replyId } = args;
  const body: Record<string, unknown> = { number: to, text };
  if (replyId) body.replyid = replyId;
  const response = await fetch(`${requireBaseUrl()}/send/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: instanceToken },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`);
  }
  const data = (await response.json()) as { messageid?: string };
  if (!data.messageid) throw new Error('UAZAPI sent the message but returned no id.');
  return { messageId: data.messageid };
}

export type UazapiMediaKind = 'image' | 'video' | 'document' | 'audio';

export interface SendMediaArgs {
  instanceToken: string;
  to: string;
  kind: UazapiMediaKind;
  /** Public URL or base64 data UAZAPI fetches/decodes at send time. */
  file: string;
  caption?: string;
  /** Document-only — shown as the file name in the recipient's chat. */
  filename?: string;
  replyId?: string;
}

export async function sendMedia(args: SendMediaArgs): Promise<UazapiSendResult> {
  const { instanceToken, to, kind, file, caption, filename, replyId } = args;
  const body: Record<string, unknown> = { number: to, type: kind, file };
  if (caption) body.text = caption;
  if (kind === 'document' && filename) body.docName = filename;
  if (replyId) body.replyid = replyId;
  const response = await fetch(`${requireBaseUrl()}/send/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: instanceToken },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`);
  }
  const data = (await response.json()) as { messageid?: string };
  if (!data.messageid) throw new Error('UAZAPI sent the media but returned no id.');
  return { messageId: data.messageid };
}

export interface SendReactionArgs {
  instanceToken: string;
  to: string;
  /** UAZAPI id of the message being reacted to. */
  targetMessageId: string;
  /** Single emoji, or empty string to remove an existing reaction. */
  emoji: string;
}

export async function sendReaction(
  args: SendReactionArgs
): Promise<UazapiSendResult> {
  const { instanceToken, to, targetMessageId, emoji } = args;
  const response = await fetch(`${requireBaseUrl()}/message/react`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: instanceToken },
    body: JSON.stringify({ number: to, text: emoji, id: targetMessageId }),
  });
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`);
  }
  const data = (await response.json()) as { reaction?: { id?: string } };
  return { messageId: data.reaction?.id ?? targetMessageId };
}
