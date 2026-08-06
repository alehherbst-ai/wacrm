// ============================================================
// POST /api/whatsapp/conversations/transfer
//
// Body: { conversation_id, to_user_id, opening_message? }
//
// Hands a conversation to another operator. The heavy lifting is the
// `transfer_conversation` RPC from migration 045 (SECURITY DEFINER,
// one transaction) — this route forwards the call, maps SQLSTATEs to
// HTTP, and then sends the opening message if one was asked for.
//
// Why the opening message matters more than it looks
//   The customer is not told anything by the transfer itself. They
//   keep the old operator's number in their phone, with all the
//   history in it, and that is where they will reply. Until the new
//   operator writes first, the customer has no chat with them at all
//   — so from the outside, nothing happened.
//
//   It is offered rather than required: a transfer can legitimately be
//   "you take it from here, I'll let them come to you". But it is
//   pre-filled and pre-checked, because the case where you want it is
//   the common one.
//
//   It is sent AFTER the RPC commits and its failure does not roll the
//   transfer back. A transfer that half-happened because WhatsApp was
//   briefly unreachable would be worse than one the customer has not
//   been greeted in yet: the greeting can be retyped, a torn transfer
//   cannot be seen.
// ============================================================

import { NextResponse } from 'next/server';
import type { PostgrestError } from '@supabase/supabase-js';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  sendMessageToConversation,
  SendMessageError,
} from '@/lib/whatsapp/send-message';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

function rpcErrorToResponse(err: PostgrestError): NextResponse {
  // 42501 — caller doesn't handle this conversation.
  if (err.code === '42501') {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  // 22023 — a refusal the caller can act on: group chat, no number on
  // the other side, same number, not in this account.
  if (err.code === '22023') {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error('[transfer] unexpected RPC error:', err);
  return NextResponse.json(
    { error: 'Failed to transfer the conversation' },
    { status: 500 },
  );
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(
      `transfer-conversation:${userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      conversation_id?: unknown;
      to_user_id?: unknown;
      opening_message?: unknown;
    } | null;

    const conversationId = body?.conversation_id;
    const toUserId = body?.to_user_id;

    if (typeof conversationId !== 'string' || !conversationId) {
      return NextResponse.json(
        { error: 'conversation_id is required' },
        { status: 400 },
      );
    }
    if (typeof toUserId !== 'string' || !toUserId) {
      return NextResponse.json(
        { error: 'to_user_id is required' },
        { status: 400 },
      );
    }

    const openingMessage =
      typeof body?.opening_message === 'string'
        ? body.opening_message.trim()
        : '';

    const { data: destinationId, error } = await supabase.rpc(
      'transfer_conversation',
      { p_conversation_id: conversationId, p_to_user_id: toUserId },
    );

    if (error) return rpcErrorToResponse(error);
    if (!destinationId) {
      return NextResponse.json(
        { error: 'Failed to transfer the conversation' },
        { status: 500 },
      );
    }

    // The transfer is done and committed by this point. Anything below
    // is a best-effort courtesy, reported but never fatal.
    let openingMessageError: string | null = null;
    if (openingMessage) {
      try {
        // Service-role client, not the caller's.
        //
        // The destination conversation lives on the OTHER operator's
        // number, and writing to a number that is not yours is exactly
        // what the RLS policies refuse — deliberately, since that is
        // the whole "one active operator, everyone else observes"
        // rule. So the caller's own client cannot post here, and it
        // should not be able to.
        //
        // The authorisation for this particular write was already
        // established one statement ago: `transfer_conversation`
        // checked that the caller handles the source conversation and
        // committed the handover. This message is the tail of that
        // approved operation, not a separate act.
        await sendMessageToConversation(supabaseAdmin(), accountId, {
          conversationId: destinationId as string,
          messageType: 'text',
          contentText: openingMessage,
        });
      } catch (err) {
        openingMessageError =
          err instanceof SendMessageError
            ? err.message
            : 'The opening message could not be sent.';
        console.error('[transfer] opening message failed:', err);
      }
    }

    return NextResponse.json({
      conversation_id: destinationId,
      opening_message_error: openingMessageError,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
