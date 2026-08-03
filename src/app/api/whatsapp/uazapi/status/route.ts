import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import { getInstanceStatus } from '@/lib/whatsapp/uazapi-api';

/**
 * GET /api/whatsapp/uazapi/status
 *
 * Poll target for the QR-connect flow (settings screen calls this
 * every ~2-3s while `connected: false`) and a general health check
 * afterwards. Any account member may read — matches the
 * `whatsapp_config_select` RLS policy (viewer+).
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('viewer');

    const { searchParams } = new URL(request.url);
    const connectionId = searchParams.get('connection_id');

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

    const instanceToken = decrypt(config.uazapi_instance_token);
    const result = await getInstanceStatus(instanceToken);

    if (result.status.connected && config.status !== 'connected') {
      await supabase
        .from('whatsapp_config')
        .update({ status: 'connected', connected_at: new Date().toISOString() })
        .eq('id', config.id);
    } else if (!result.status.connected && config.status === 'connected') {
      await supabase
        .from('whatsapp_config')
        .update({ status: 'disconnected' })
        .eq('id', config.id);
    }

    return NextResponse.json({
      connection_id: config.id,
      connected: result.status.connected,
      logged_in: result.status.loggedIn,
      qrcode: result.instance.qrcode ?? null,
      paircode: result.instance.paircode ?? null,
      profile_name: result.instance.profileName ?? null,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
