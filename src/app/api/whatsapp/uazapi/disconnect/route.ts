import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  findTargetConnection,
  parseConnectionScope,
} from '@/lib/whatsapp/connection-target';
import { decrypt } from '@/lib/whatsapp/encryption';
import { disconnectInstance } from '@/lib/whatsapp/uazapi-api';

/**
 * POST /api/whatsapp/uazapi/disconnect
 *
 * Ends the UAZAPI session and removes the local connection row —
 * mirrors the Meta side's "Reset" (DELETE /api/whatsapp/config):
 * reconnecting means starting over with a fresh QR code, not resuming
 * a paused session.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const connectionId = (body as { connection_id?: string })?.connection_id;
    const scope = parseConnectionScope((body as { scope?: unknown })?.scope);

    // An operator may unpair their own phone; anything else — the house
    // number, or a colleague's line — stays admin territory. The RLS
    // policy enforces the same rule, so a forged `scope` buys nothing:
    // the DELETE simply matches no row.
    const { supabase, accountId, userId } = await requireRole(
      scope === 'mine' ? 'agent' : 'admin'
    );

    const config = await findTargetConnection(supabase, accountId, {
      connectionId,
      scope,
      userId,
    });
    if (!config) {
      return NextResponse.json(
        { error: 'UAZAPI connection not found' },
        { status: 404 }
      );
    }

    try {
      const instanceToken = decrypt(config.uazapi_instance_token);
      await disconnectInstance(instanceToken);
    } catch (err) {
      // Best-effort — even if the UAZAPI-side call fails or the server
      // is unreachable, still remove the local row so the user can
      // reconnect from scratch.
      console.error('[uazapi/disconnect] UAZAPI disconnect call failed:', err);
    }

    const { error: deleteError } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('id', config.id);

    if (deleteError) {
      console.error('[uazapi/disconnect] failed to delete connection row:', deleteError);
      return NextResponse.json(
        { error: 'Failed to remove connection' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
