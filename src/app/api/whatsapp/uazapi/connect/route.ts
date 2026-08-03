import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { encrypt, decrypt } from '@/lib/whatsapp/encryption';
import {
  createInstance,
  connectInstance,
  configureWebhook,
} from '@/lib/whatsapp/uazapi-api';

/**
 * Resolve the public origin UAZAPI should POST inbound events to.
 *
 * Prefers `NEXT_PUBLIC_SITE_URL` (same convention documented in
 * .env.local.example for "routes that need a self-referential URL
 * when the request-derived origin would be wrong") over the
 * request's own origin — because unlike a user-facing link (which is
 * opened from wherever the admin's browser already is, so the
 * request origin is correct by construction), a *webhook* URL is
 * dialled by UAZAPI's servers, not the admin's browser. If this route
 * is called from `http://localhost:3000` (`npm run dev`), the request
 * origin is exactly that — unreachable from UAZAPI's cloud — and every
 * inbound message silently vanishes with no error anywhere, because
 * registering an unreachable webhook URL is not itself a failure.
 *
 * Flags the result as `suspicious` when it's localhost/private or
 * still the literal placeholder from .env.local.example, so the
 * caller can surface a loud warning instead of silently mis-wiring
 * the connection the way the original implementation did.
 */
function resolveWebhookOrigin(request: Request): { origin: string; suspicious: boolean } {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const origin = configured || new URL(request.url).origin;

  const suspicious =
    !configured ||
    /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(origin) ||
    origin.includes('crm.example.com');

  return { origin: origin.replace(/\/+$/, ''), suspicious };
}

/**
 * POST /api/whatsapp/uazapi/connect
 *
 * Creates the account's UAZAPI instance on first call (server-side
 * admin token only, never exposed to the client), then starts (or
 * resumes) the QR-code handshake. The client polls
 * GET /api/whatsapp/uazapi/status until `connected: true`.
 *
 * Re-registers the webhook on EVERY call (not just instance creation)
 * — cheap and idempotent on UAZAPI's side ("simple mode" upserts the
 * one webhook per instance), and it's what lets fixing a bad
 * NEXT_PUBLIC_SITE_URL and clicking "Connect" again actually repair a
 * previously-mis-wired connection without a full disconnect/recreate.
 *
 * Admin-only — matches the `whatsapp_config_insert`/`update` RLS
 * policies, and instance creation has a real side effect against the
 * UAZAPI account's instance quota.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId, account } = await requireRole('admin');

    const adminToken = process.env.UAZAPI_ADMIN_TOKEN;
    if (!adminToken) {
      return NextResponse.json(
        {
          error:
            'UAZAPI is not configured on this server (missing UAZAPI_ADMIN_TOKEN).',
        },
        { status: 500 }
      );
    }

    const { data: existing, error: existingError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .eq('provider', 'uazapi')
      .maybeSingle();

    if (existingError) {
      console.error('[uazapi/connect] failed to load existing config:', existingError);
      return NextResponse.json(
        { error: 'Failed to load UAZAPI connection' },
        { status: 500 }
      );
    }

    let configRow = existing;
    let instanceToken: string;
    let webhookSecret: string;

    if (!configRow) {
      let instance;
      try {
        instance = await createInstance({
          adminToken,
          name: `${account.name}-${accountId.slice(0, 8)}`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown UAZAPI error';
        return NextResponse.json(
          { error: `Failed to create UAZAPI instance: ${message}` },
          { status: 502 }
        );
      }

      webhookSecret = crypto.randomBytes(24).toString('hex');

      const { data: inserted, error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({
          account_id: accountId,
          user_id: userId,
          provider: 'uazapi',
          status: 'disconnected',
          uazapi_instance_id: instance.id,
          uazapi_instance_token: encrypt(instance.token),
          uazapi_instance_name: instance.name ?? null,
          uazapi_webhook_secret: encrypt(webhookSecret),
        })
        .select()
        .single();

      if (insertError || !inserted) {
        console.error('[uazapi/connect] failed to save new connection:', insertError);
        return NextResponse.json(
          { error: 'Failed to save UAZAPI connection' },
          { status: 500 }
        );
      }
      configRow = inserted;
      instanceToken = instance.token;
    } else {
      instanceToken = decrypt(configRow.uazapi_instance_token);
      webhookSecret = decrypt(configRow.uazapi_webhook_secret);
    }

    // Re-register on every call (see the function doc above) — this is
    // what makes fixing NEXT_PUBLIC_SITE_URL + reconnecting actually work.
    const { origin, suspicious } = resolveWebhookOrigin(request);
    let webhookWarning: string | null = null;
    if (suspicious) {
      webhookWarning = `The webhook is being registered at ${origin}, which UAZAPI's servers likely cannot reach (looks like localhost or an unconfigured NEXT_PUBLIC_SITE_URL). Inbound messages will not arrive until this points at a public URL. Set NEXT_PUBLIC_SITE_URL to your real domain (or a tunnel URL for local dev) and click Connect again.`;
      console.warn(`[uazapi/connect] ${webhookWarning}`);
    }
    try {
      await configureWebhook({
        instanceToken,
        url: `${origin}/api/whatsapp/uazapi/webhook/${configRow.id}/${webhookSecret}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown UAZAPI error';
      webhookWarning = `Failed to register the webhook with UAZAPI: ${message}. Inbound messages will not arrive until this is fixed — try Connect again.`;
      console.error(`[uazapi/connect] ${webhookWarning}`);
    }

    let connectResult;
    try {
      connectResult = await connectInstance({ instanceToken });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown UAZAPI error';
      return NextResponse.json(
        { error: `Failed to start connection: ${message}` },
        { status: 502 }
      );
    }

    await supabase
      .from('whatsapp_config')
      .update({
        status: connectResult.connected ? 'connected' : 'disconnected',
        connected_at: connectResult.connected
          ? new Date().toISOString()
          : configRow.connected_at,
        uazapi_instance_name:
          connectResult.instance.profileName ?? configRow.uazapi_instance_name,
      })
      .eq('id', configRow.id);

    return NextResponse.json({
      connection_id: configRow.id,
      connected: connectResult.connected,
      qrcode: connectResult.instance.qrcode ?? null,
      paircode: connectResult.instance.paircode ?? null,
      webhook_warning: webhookWarning,
    });
  } catch (error) {
    console.error('[uazapi/connect] error:', error);
    return toErrorResponse(error);
  }
}
