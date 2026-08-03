import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
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
    const { supabase, accountId } = await requireRole('admin');

    const body = await request.json().catch(() => ({}));
    const connectionId = (body as { connection_id?: string })?.connection_id;

    let query = supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .eq('provider', 'uazapi');
    if (connectionId) query = query.eq('id', connectionId);

    const { data: config, error } = await query.maybeSingle();
    if (error || !config) {
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
