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
  /**
   * The connected line, bare digits. Only UAZAPI knows this — the
   * number is decided on the phone at QR-scan time, so nothing in our
   * own schema can hold it until the instance reports it back.
   */
  owner?: string;
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

// ============================================================
// Groups
// ============================================================

export interface GetGroupInfoArgs {
  instanceToken: string;
  /** Group JID, e.g. "120363123456789012@g.us". */
  groupJid: string;
}

export interface GroupInfo {
  jid: string;
  /** The group's subject/name as set in WhatsApp. */
  name: string;
}

/**
 * Fetch a group's display name. Used once, when a group is seen for
 * the first time, to give it a real name instead of a bare id — best-
 * effort by design, callers should fall back gracefully on failure.
 */
export async function getGroupInfo(args: GetGroupInfoArgs): Promise<GroupInfo> {
  const { instanceToken, groupJid } = args;
  const response = await fetch(`${requireBaseUrl()}/group/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: instanceToken },
    body: JSON.stringify({ groupjid: groupJid }),
  });
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`);
  }
  const data = (await response.json()) as { JID?: string; Name?: string };
  if (!data.Name) throw new Error('UAZAPI returned no group name.');
  return { jid: data.JID ?? groupJid, name: data.Name };
}

// ============================================================
// Number lookup
// ============================================================

export interface CheckNumberArgs {
  instanceToken: string;
  /** Digits only, international format (no `+`). */
  number: string;
}

export interface CheckedNumber {
  /** Whether WhatsApp knows this number at all. */
  isInWhatsapp: boolean;
  /**
   * WhatsApp's own JID for the number. Worth trusting over the digits
   * that were typed: WhatsApp canonicalises numbers (Brazilian mobiles
   * gained a 9th digit, and both forms are still typed by humans), and
   * messages route to the canonical form. Absent when the number isn't
   * registered.
   */
  jid: string | null;
  /** Business/verified display name, when the account publishes one. */
  verifiedName: string | null;
}

/**
 * Ask WhatsApp whether a number is reachable, before opening a thread
 * for it.
 *
 * Without this, "start a conversation" would happily create a contact
 * and a conversation for a typo, and the failure would only surface
 * later as a send error against a thread that should never have
 * existed.
 *
 * The endpoint takes a batch; this wraps the single-number case because
 * that's the only shape the app needs, and it lets the caller treat a
 * missing entry as "not found" rather than juggling an array.
 */
export async function checkNumber(
  args: CheckNumberArgs
): Promise<CheckedNumber> {
  const { instanceToken, number } = args;
  const response = await fetch(`${requireBaseUrl()}/chat/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: instanceToken },
    body: JSON.stringify({ numbers: [number] }),
    // Bounded: a person is staring at a spinner waiting for this.
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`);
  }

  const data = (await response.json()) as
    | {
        query?: string;
        jid?: string;
        isInWhatsapp?: boolean;
        verifiedName?: string;
        error?: string;
      }[]
    | null;

  const entry = Array.isArray(data) ? data[0] : null;
  // No entry at all means the provider had nothing to say about the
  // number — treated as "not on WhatsApp" rather than as an error, so
  // the caller shows one clear message instead of two.
  if (!entry || !entry.isInWhatsapp || !entry.jid) {
    return { isInWhatsapp: false, jid: null, verifiedName: null };
  }

  return {
    isInWhatsapp: true,
    jid: entry.jid,
    verifiedName: entry.verifiedName || null,
  };
}

// ============================================================
// Profile pictures
// ============================================================

export interface GetProfilePictureArgs {
  instanceToken: string;
  /** Phone digits for a person, or the full `…@g.us` JID for a group. */
  number: string;
}

/**
 * Fetch a contact's or group's WhatsApp profile picture URL.
 *
 * `/chat/details` serves both — pass a bare phone for a person and the
 * group JID for a group — and returns the picture in two sizes:
 * `image` (original) with `preview: false`, `imagePreview` (96×96) with
 * `preview: true`. We ask for the original: it is still only tens of
 * kilobytes, and the conversation sidebar renders larger than a preview
 * would survive.
 *
 * Returns null when the contact has no picture or hides it under
 * WhatsApp's privacy settings — a normal outcome, not an error. Only a
 * genuine transport/API failure throws.
 *
 * The URL it returns is short-lived: it points at `pps.whatsapp.net`
 * with a signed `oe=` expiry about ten days out. Callers must copy the
 * bytes somewhere durable rather than persisting the link (see
 * `contact-avatar.ts`).
 */
export async function getProfilePictureUrl(
  args: GetProfilePictureArgs
): Promise<string | null> {
  const { instanceToken, number } = args;
  const response = await fetch(`${requireBaseUrl()}/chat/details`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: instanceToken },
    body: JSON.stringify({ number, preview: false }),
    // This runs inline with inbound message processing, so it is
    // bounded rather than left to the platform default: a hung lookup
    // must never hold up the message that triggered it.
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`);
  }
  const data = (await response.json()) as {
    image?: string;
    imagePreview?: string;
  };
  return data.image || data.imagePreview || null;
}

// ============================================================
// Inbound media
// ============================================================

export interface DownloadMessageMediaArgs {
  instanceToken: string;
  /** UAZAPI's `messageid` (not the prefixed `id`). */
  messageId: string;
}

export interface DownloadedMedia {
  /** Public URL UAZAPI serves the decrypted file from. */
  fileURL: string;
  mimetype: string;
}

/**
 * Resolve an inbound media message to a downloadable file.
 *
 * Inbound webhook payloads do NOT carry a usable `fileURL` — the media
 * sits encrypted on WhatsApp's CDN and only this endpoint decrypts it
 * and republishes it. Without this call an inbound image or voice note
 * has no retrievable bytes at all.
 *
 * `generate_mp3: false` keeps voice notes as OGG/Opus, which is what
 * WhatsApp sent and what the chat-media bucket accepts; letting UAZAPI
 * transcode to MP3 would only add a lossy re-encode.
 */
export async function downloadMessageMedia(
  args: DownloadMessageMediaArgs
): Promise<DownloadedMedia> {
  const { instanceToken, messageId } = args;
  const response = await fetch(`${requireBaseUrl()}/message/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: instanceToken },
    body: JSON.stringify({
      id: messageId,
      return_link: true,
      return_base64: false,
      generate_mp3: false,
    }),
  });
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`);
  }
  const data = (await response.json()) as Partial<DownloadedMedia>;
  if (!data.fileURL) throw new Error('UAZAPI returned no fileURL for the media.');
  return {
    fileURL: data.fileURL,
    mimetype: data.mimetype || 'application/octet-stream',
  };
}

// ============================================================
// Interactive menus (reply buttons / selectable lists)
// ============================================================

export interface SendMenuButtonsArgs {
  instanceToken: string;
  to: string;
  kind: 'buttons';
  /** Body text shown above the buttons. */
  text: string;
  footerText?: string;
  buttons: { id: string; title: string }[];
  replyId?: string;
}

export interface SendMenuListArgs {
  instanceToken: string;
  to: string;
  kind: 'list';
  text: string;
  footerText?: string;
  /** Label of the tap-to-expand button on the message bubble. */
  listButton: string;
  sections: {
    title?: string;
    rows: { id: string; title: string; description?: string }[];
  }[];
  replyId?: string;
}

export type SendMenuArgs = SendMenuButtonsArgs | SendMenuListArgs;

/**
 * Escape the `|` separator UAZAPI uses to split a choice into its
 * parts. A button labelled "Sim | Não" would otherwise be parsed as
 * label "Sim " with id " Não", silently changing the id the webhook
 * echoes back — which is what Flows route on. No documented escape
 * exists, so the separator is replaced with a lookalike instead of
 * corrupting the routing id.
 */
function sanitizeChoicePart(value: string): string {
  return value.replace(/\|/g, '∣');
}

/**
 * Send an interactive menu — reply buttons or a selectable list.
 *
 * UAZAPI expresses both through one endpoint and a single flat
 * `choices` array of pipe-delimited strings, rather than the nested
 * object payloads other WhatsApp APIs use:
 *   - buttons: `"label|id"`
 *   - list:    `"[Section title]"` opens a section, then
 *              `"label|id|description"` per row
 *
 * The customer's tap comes back on the webhook as `buttonOrListid`,
 * which the inbound normalizer maps to `interactiveReplyId` — that's
 * what advances a Flow run, so the ids sent here must round-trip
 * unchanged (see sanitizeChoicePart).
 */
export async function sendMenu(args: SendMenuArgs): Promise<UazapiSendResult> {
  const { instanceToken, to, text, footerText, replyId } = args;

  const body: Record<string, unknown> = { number: to, text };
  if (footerText) body.footerText = footerText;
  if (replyId) body.replyid = replyId;

  if (args.kind === 'buttons') {
    body.type = 'button';
    body.choices = args.buttons.map(
      (b) => `${sanitizeChoicePart(b.title)}|${sanitizeChoicePart(b.id)}`
    );
  } else {
    body.type = 'list';
    body.listButton = args.listButton;
    const choices: string[] = [];
    for (const section of args.sections) {
      if (section.title) choices.push(`[${section.title}]`);
      for (const row of section.rows) {
        const parts = [sanitizeChoicePart(row.title), sanitizeChoicePart(row.id)];
        if (row.description) parts.push(sanitizeChoicePart(row.description));
        choices.push(parts.join('|'));
      }
    }
    body.choices = choices;
  }

  const response = await fetch(`${requireBaseUrl()}/send/menu`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: instanceToken },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI error: ${response.status}`);
  }
  const data = (await response.json()) as { messageid?: string };
  if (!data.messageid) throw new Error('UAZAPI sent the menu but returned no id.');
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
