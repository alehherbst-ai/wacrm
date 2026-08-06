import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  findTargetConnection,
  parseConnectionScope,
} from '@/lib/whatsapp/connection-target';
import { decrypt } from '@/lib/whatsapp/encryption';
import { getInstanceStatus } from '@/lib/whatsapp/uazapi-api';

/**
 * GET /api/whatsapp/uazapi/status
 *
 * Poll target for the QR-connect flow (settings screen calls this
 * every ~2-3s while `connected: false`) and a general health check
 * afterwards. Any account member may read — matches the
 * `whatsapp_config_select` RLS policy (viewer+).
 *
 * `?connection_id=` targets one row; `?scope=mine` targets the
 * caller's own line; neither means the house number. Since an account
 * may hold several numbers (migration 044), asking without either used
 * to error the moment a second one existed.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('viewer');

    const { searchParams } = new URL(request.url);
    const connectionId = searchParams.get('connection_id');
    const scope = parseConnectionScope(searchParams.get('scope'));

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
