import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  resolveConnection,
  WhatsAppNotConfiguredError,
} from '@/lib/whatsapp/uazapi-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { checkNumber } from '@/lib/whatsapp/uazapi-api';
import { normalizePhone, isValidE164 } from '@/lib/whatsapp/phone-utils';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/**
 * POST /api/whatsapp/conversations/start
 *
 * Body: { phone: string }
 *
 * Opens a thread with someone who has never written in. Validates the
 * number against WhatsApp first, then finds-or-creates the contact and
 * the conversation, and returns the conversation id for the inbox to
 * select.
 *
 * Validating BEFORE writing anything is the point: without the check a
 * typo would leave a permanent contact and an empty thread behind, and
 * the mistake would only surface later as a send failure.
 *
 * Runs under the caller's session (not the service role), so RLS is
 * what scopes every write to their account.
 */
export async function POST(request: Request) {
  try {
    // Starting a thread writes a contact + a conversation and performs
    // a live WhatsApp lookup — the same 'agent' bar as sending.
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(
      `start-conversation:${userId}`,
      RATE_LIMITS.startConversation
    );
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const body = await request.json().catch(() => null);
    const phoneInput = (body as { phone?: string } | null)?.phone;

    if (typeof phoneInput !== 'string' || !phoneInput.trim()) {
      return NextResponse.json({ error: 'phone is required' }, { status: 400 });
    }

    const digits = normalizePhone(phoneInput);
    // Cheap shape check first, so an obviously-malformed entry never
    // costs a provider round-trip.
    if (!isValidE164(digits)) {
      return NextResponse.json(
        { error: 'invalid_number', message: 'That is not a valid phone number.' },
        { status: 422 }
      );
    }

    const { config } = await resolveConnection(supabase, accountId);
    const instanceToken = decrypt(config.uazapi_instance_token);

    const checked = await checkNumber({ instanceToken, number: digits });
    if (!checked.isInWhatsapp || !checked.jid) {
      return NextResponse.json(
        {
          error: 'not_on_whatsapp',
          message: 'That number does not have WhatsApp.',
        },
        { status: 422 }
      );
    }

    // Prefer WhatsApp's own JID over the typed digits. It canonicalises
    // the number (Brazilian mobiles gained a 9th digit and humans still
    // type both forms), and messages route to the canonical form — so
    // storing what was typed would create a contact we cannot reliably
    // deliver to, and a duplicate of one we may already have.
    const canonicalPhone = normalizePhone(checked.jid.split('@')[0]) || digits;

    const existing = await findExistingContact(supabase, accountId, canonicalPhone);

    let contactId: string;
    if (existing) {
      contactId = existing.id;
    } else {
      const { data: created, error: createError } = await supabase
        .from('contacts')
        .insert({
          account_id: accountId,
          user_id: userId,
          phone: canonicalPhone,
          name: checked.verifiedName || canonicalPhone,
        })
        .select('id')
        .single();

      if (createError || !created) {
        // A racing insert (same number, two tabs) lands here; the row
        // the other request created is the right answer.
        if (isUniqueViolation(createError)) {
          const raced = await findExistingContact(
            supabase,
            accountId,
            canonicalPhone
          );
          if (raced) {
            contactId = raced.id;
          } else {
            return NextResponse.json(
              { error: 'Could not create the contact' },
              { status: 500 }
            );
          }
        } else {
          console.error('[start-conversation] contact insert failed:', createError);
          return NextResponse.json(
            { error: 'Could not create the contact' },
            { status: 500 }
          );
        }
      } else {
        contactId = created.id;
      }
    }

    // Reuse an existing thread rather than opening a second one — the
    // contact may have written in the past and been archived away, in
    // which case this must surface THAT thread with its history.
    const { data: existingConvs, error: convFindError } = await supabase
      .from('conversations')
      .select('id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: true })
      .limit(1);

    if (convFindError) {
      console.error('[start-conversation] conversation lookup failed:', convFindError);
      return NextResponse.json(
        { error: 'Could not open the conversation' },
        { status: 500 }
      );
    }

    if (existingConvs && existingConvs.length > 0) {
      const conversationId = existingConvs[0].id;
      // Un-archive so it comes back into the list; the agent asked for
      // this thread by name.
      await supabase
        .from('conversations')
        .update({ archived_at: null, updated_at: new Date().toISOString() })
        .eq('id', conversationId);

      return NextResponse.json({
        conversation_id: conversationId,
        contact_id: contactId,
        created: false,
      });
    }

    const { data: newConv, error: convCreateError } = await supabase
      .from('conversations')
      .insert({
        account_id: accountId,
        user_id: userId,
        contact_id: contactId,
        whatsapp_config_id: config.id,
      })
      .select('id')
      .single();

    if (convCreateError || !newConv) {
      console.error('[start-conversation] conversation insert failed:', convCreateError);
      return NextResponse.json(
        { error: 'Could not open the conversation' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      conversation_id: newConv.id,
      contact_id: contactId,
      created: true,
    });
  } catch (error) {
    if (error instanceof WhatsAppNotConfiguredError) {
      return NextResponse.json(
        { error: 'not_connected', message: error.message },
        { status: 400 }
      );
    }
    // requireRole throws Unauthorized/Forbidden; toErrorResponse maps
    // those to 401/403 and collapses anything else to a generic 500.
    console.error('[start-conversation] error:', error);
    return toErrorResponse(error);
  }
}
