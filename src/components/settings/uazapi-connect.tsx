'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, XCircle, Loader2, RotateCcw, QrCode, Phone } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

// UAZAPI's own QR expiry is ~2 minutes (see /instance/connect docs) —
// stop polling and offer a fresh code past that point instead of
// hammering the status endpoint forever against an expired code.
const QR_TIMEOUT_MS = 2 * 60 * 1000;
const POLL_INTERVAL_MS = 2500;

interface UazapiConnectionRow {
  id: string;
  status: 'connected' | 'disconnected';
  uazapi_instance_name: string | null;
}

type ViewState = 'idle' | 'connecting' | 'awaiting_scan' | 'expired' | 'connected';

interface UazapiConnectProps {
  /**
   * Which line this card manages.
   *
   * `account` is the house number — the connection an account had
   * before operators existed, and the one automations fall back to.
   * `mine` is the signed-in operator's own line: messages arriving on
   * it land in their inbox and nobody else's (migration 044).
   *
   * The card is otherwise identical, which is the point — pairing a
   * phone works the same either way.
   */
  scope?: 'account' | 'mine';
}

export function UazapiConnect({ scope = 'account' }: UazapiConnectProps) {
  // `Settings.whatsapp`, not `Settings.whatsapp.uazapi` — the latter is
  // where this asked for four months and no such namespace exists, so
  // every label on this card resolved to a missing message.
  const t = useTranslations('Settings.whatsapp');
  const isMine = scope === 'mine';
  const supabase = createClient();
  const { user, accountId, loading: authLoading, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [viewState, setViewState] = useState<ViewState>('idle');
  const [connection, setConnection] = useState<UazapiConnectionRow | null>(null);
  const [qrcode, setQrcode] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  /**
   * The line on the other end, once UAZAPI has told us.
   *
   * `null` while we haven't asked or the answer had nothing in it;
   * `'unreachable'` when the instance refused the question, which is
   * different and worth saying out loud — the card would otherwise
   * keep claiming "Conectado" off a stale database row while the
   * instance token behind it is dead.
   */
  const [connectedPhone, setConnectedPhone] = useState<string | null>(null);
  const [phoneUnreachable, setPhoneUnreachable] = useState(false);
  const loadedAccountIdRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrDeadlineRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const fetchConnection = useCallback(
    async (acctId: string) => {
      setLoading(true);
      try {
        let query = supabase
          .from('whatsapp_config')
          .select('id, status, uazapi_instance_name')
          .eq('account_id', acctId)
          .eq('provider', 'uazapi');

        query = isMine
          ? query.eq('operator_user_id', user?.id ?? '')
          : query.is('operator_user_id', null);

        // Ordered + limited rather than `.maybeSingle()`, which ERRORS
        // on more than one row — and an account may now hold one line
        // per operator (migration 044).
        const { data, error } = await query
          .order('created_at', { ascending: true })
          .limit(1);

        if (error) {
          console.error('[uazapi] failed to load connection:', error);
        }

        const row = data?.[0] ?? null;
        setConnection(row);
        setViewState(row?.status === 'connected' ? 'connected' : 'idle');
      } finally {
        setLoading(false);
      }
    },
    [supabase, isMine, user?.id]
  );

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      loadedAccountIdRef.current = null;
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    fetchConnection(accountId);
  }, [authLoading, profileLoading, user?.id, accountId, fetchConnection]);

  /**
   * Ask the instance which number it is, for a line the database
   * already considers connected. Runs once when the card opens; the
   * connect flow's poll below covers the freshly-scanned case.
   */
  const fetchConnectedPhone = useCallback(async () => {
    try {
      const res = await fetch(`/api/whatsapp/uazapi/status?scope=${scope}`);
      if (!res.ok) {
        setPhoneUnreachable(true);
        return;
      }
      const data = await res.json();
      setConnectedPhone(typeof data.phone === 'string' ? data.phone : null);
      setPhoneUnreachable(false);
    } catch {
      // Offline or the instance is unreachable. The card still shows
      // what the database knows; it just cannot name the number.
      setPhoneUnreachable(true);
    }
  }, [scope]);

  useEffect(() => {
    if (viewState !== 'connected') return;
    fetchConnectedPhone();
  }, [viewState, fetchConnectedPhone]);

  const pollStatus = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      if (qrDeadlineRef.current && Date.now() > qrDeadlineRef.current) {
        stopPolling();
        setViewState('expired');
        return;
      }
      try {
        const res = await fetch(
          `/api/whatsapp/uazapi/status?scope=${scope}`,
        );
        if (!res.ok) return;
        const data = await res.json();
        if (data.connected) {
          stopPolling();
          setViewState('connected');
          setQrcode(null);
          setConnectedPhone(typeof data.phone === 'string' ? data.phone : null);
          setPhoneUnreachable(false);
          if (accountId) await fetchConnection(accountId);
          toast.success(
            data.profile_name
              ? t('connectedAs', { name: data.profile_name })
              : t('connected')
          );
        } else if (data.qrcode) {
          // UAZAPI rotates the QR image periodically while awaiting scan.
          setQrcode(data.qrcode);
        }
      } catch (err) {
        console.error('[uazapi] status poll failed:', err);
      }
    }, POLL_INTERVAL_MS);
  }, [accountId, fetchConnection, stopPolling, t, scope]);

  async function handleConnect() {
    setViewState('connecting');
    try {
      const res = await fetch('/api/whatsapp/uazapi/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || t('connectError'));
        setViewState('idle');
        return;
      }

      // A misconfigured webhook doesn't fail the request — the QR/session
      // flow works fine even though inbound messages will never arrive.
      // Surface it loudly instead of leaving that silent.
      if (data.webhook_warning) {
        toast.warning(data.webhook_warning, { duration: 15000 });
      }

      if (data.connected) {
        setViewState('connected');
        setQrcode(null);
        if (accountId) await fetchConnection(accountId);
        return;
      }

      setQrcode(data.qrcode ?? null);
      setViewState('awaiting_scan');
      qrDeadlineRef.current = Date.now() + QR_TIMEOUT_MS;
      pollStatus();
    } catch (err) {
      console.error('[uazapi] connect failed:', err);
      toast.error(t('connectError'));
      setViewState('idle');
    }
  }

  async function handleDisconnect() {
    if (!confirm(t('disconnect') + '?')) return;
    setDisconnecting(true);
    stopPolling();
    try {
      const res = await fetch('/api/whatsapp/uazapi/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t('connectError'));
        return;
      }
      setConnection(null);
      setQrcode(null);
      setViewState('idle');
    } catch (err) {
      console.error('[uazapi] disconnect failed:', err);
      toast.error(t('connectError'));
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  const isConnected = viewState === 'connected';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">
          {isMine ? t('mineTitle') : t('title')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {isMine ? t('mineDescription') : t('description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert className="bg-card border-border">
          <div className="flex items-center gap-2">
            {isConnected ? (
              <CheckCircle2 className="size-4 text-primary" />
            ) : (
              <XCircle className="size-4 text-muted-foreground" />
            )}
            <AlertTitle className="text-foreground mb-0">
              {isConnected ? t('connected') : t('notConnected')}
            </AlertTitle>
          </div>
          {/* Which number is on the other end. It is the one thing
              this card could not answer before: the status line said
              "Conectado" and left you to guess WHICH phone that was —
              a real question once an account holds several. */}
          {isConnected && connectedPhone && (
            <AlertDescription className="mt-1 flex items-center gap-1.5 text-foreground">
              <Phone className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="font-medium tabular-nums">{connectedPhone}</span>
            </AlertDescription>
          )}
          {isConnected && !connectedPhone && phoneUnreachable && (
            <AlertDescription className="mt-1 text-amber-600 dark:text-amber-400">
              {t('numberUnreachable')}
            </AlertDescription>
          )}
          {isConnected && connection?.uazapi_instance_name && (
            <AlertDescription className="text-muted-foreground">
              {t('connectedAs', { name: connection.uazapi_instance_name })}
            </AlertDescription>
          )}
        </Alert>

        {viewState === 'awaiting_scan' && qrcode && (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-muted/40 p-6">
            {/* UAZAPI returns a ready-to-render base64 PNG. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={qrcode}
              alt="WhatsApp QR code"
              className="size-56 rounded bg-white p-2"
            />
            <p className="text-center text-sm text-muted-foreground">{t('waitingForScan')}</p>
          </div>
        )}

        {viewState === 'expired' && (
          <Alert className="bg-amber-950/30 border-amber-700/50">
            <AlertTitle className="text-amber-200">{t('expired')}</AlertTitle>
          </Alert>
        )}

        {!isConnected && (
          <Alert className="bg-card border-border">
            <AlertTitle className="text-foreground mb-1">{t('limitationsTitle')}</AlertTitle>
            <AlertDescription className="text-muted-foreground text-xs leading-relaxed">
              {t('limitationsDesc')}
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap gap-3">
          {!isConnected && (
            <Button
              onClick={handleConnect}
              disabled={viewState === 'connecting'}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {viewState === 'connecting' ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('connecting')}
                </>
              ) : viewState === 'expired' ? (
                <>
                  <RotateCcw className="size-4" />
                  {t('refreshQr')}
                </>
              ) : (
                <>
                  <QrCode className="size-4" />
                  {t('connect')}
                </>
              )}
            </Button>
          )}
          {isConnected && (
            <Button
              variant="outline"
              onClick={handleConnect}
              disabled={viewState !== 'connected'}
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              <RotateCcw className="size-4" />
              {t('verifyConnection')}
            </Button>
          )}
          {(isConnected || connection) && (
            <Button
              variant="outline"
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
            >
              {disconnecting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('disconnecting')}
                </>
              ) : (
                t('disconnect')
              )}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
