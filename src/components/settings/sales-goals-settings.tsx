'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Target } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { Profile, SalesGoal } from '@/types';

/** `<input type="month">` value for the current month, e.g. "2026-08". */
function currentMonthValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Monthly targets (migration 048).
 *
 * One account-wide target drives the dashboard's gauge; the optional
 * per-seller targets let the ranking say who is on pace rather than
 * only who sold most. A blank field means "no target", which is not
 * the same as a target of zero — the former hides the gauge, the
 * latter would read as 100% achieved on the first sale. Blank rows are
 * therefore deleted rather than saved as 0.
 */
export function SalesGoalsSettings() {
  const t = useTranslations('Settings.goals');
  const supabase = createClient();
  const { accountId, defaultCurrency, canEditSettings, loading: authLoading } =
    useAuth();

  const [month, setMonth] = useState(currentMonthValue());
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [goals, setGoals] = useState<SalesGoal[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  /** Keyed by profile id, plus the reserved "account" key. */
  const [draft, setDraft] = useState<Record<string, string>>({});

  const periodMonth = `${month}-01`;

  const load = useCallback(async () => {
    const [p, g] = await Promise.all([
      supabase.from('profiles').select('*').order('full_name'),
      supabase
        .from('sales_goals')
        .select('*')
        .eq('period_month', periodMonth),
    ]);
    const goalRows = (g.data ?? []) as SalesGoal[];
    setProfiles((p.data ?? []) as Profile[]);
    setGoals(goalRows);
    setDraft(
      Object.fromEntries(
        goalRows.map((row) => [
          row.profile_id ?? 'account',
          String(row.target_amount),
        ]),
      ),
    );
  }, [supabase, periodMonth]);

  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      await load();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, load]);

  function existing(key: string): SalesGoal | undefined {
    return goals.find((g) => (g.profile_id ?? 'account') === key);
  }

  async function persistOne(key: string): Promise<boolean> {
    const raw = (draft[key] ?? '').trim();
    const row = existing(key);
    const profileId = key === 'account' ? null : key;

    // Blank means "no target for this month" — remove the row instead
    // of storing a zero the gauge would read as a real goal.
    if (raw === '') {
      if (!row) return true;
      const { error } = await supabase
        .from('sales_goals')
        .delete()
        .eq('id', row.id);
      return !error;
    }

    const amount = parseFloat(raw);
    if (!Number.isFinite(amount) || amount < 0) return false;

    if (row) {
      const { error } = await supabase
        .from('sales_goals')
        .update({ target_amount: amount })
        .eq('id', row.id);
      return !error;
    }

    const { error } = await supabase.from('sales_goals').insert({
      account_id: accountId,
      profile_id: profileId,
      period_month: periodMonth,
      target_amount: amount,
    });
    return !error;
  }

  async function handleSave() {
    if (!accountId) {
      toast.error(t('notLinked'));
      return;
    }
    setSaving(true);
    const keys = ['account', ...profiles.map((p) => p.id)];
    const results = await Promise.all(keys.map(persistOne));
    await load();
    setSaving(false);

    if (results.some((ok) => !ok)) {
      toast.error(t('saveFailed'));
      return;
    }
    toast.success(t('saved'));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Target className="size-4 text-primary" />
          {t('title')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('description')}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-1.5 sm:max-w-[200px]">
          <Label className="text-xs text-muted-foreground">{t('month')}</Label>
          <Input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value || currentMonthValue())}
            className="border-border bg-muted text-foreground"
          />
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <GoalRow
                label={t('accountGoal')}
                hint={t('accountGoalHint')}
                currency={defaultCurrency}
                value={draft.account ?? ''}
                disabled={!canEditSettings}
                onChange={(v) => setDraft((d) => ({ ...d, account: v }))}
              />

              {profiles.length > 0 && (
                <p className="pt-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {t('perSeller')}
                </p>
              )}
              {profiles.map((p) => (
                <GoalRow
                  key={p.id}
                  label={p.full_name || p.email}
                  currency={defaultCurrency}
                  value={draft[p.id] ?? ''}
                  disabled={!canEditSettings}
                  onChange={(v) => setDraft((d) => ({ ...d, [p.id]: v }))}
                />
              ))}
            </div>

            {canEditSettings ? (
              <Button
                onClick={handleSave}
                disabled={saving}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {saving ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('saving')}
                  </>
                ) : (
                  t('save')
                )}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">{t('adminOnly')}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function GoalRow({
  label,
  hint,
  currency,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  currency: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <span className="text-xs text-muted-foreground">{currency}</span>
      <Input
        type="number"
        min="0"
        step="0.01"
        inputMode="decimal"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder="—"
        className="h-8 w-32 border-border bg-muted text-right text-sm text-foreground"
      />
    </div>
  );
}
