"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

/**
 * Boundary for the authenticated app.
 *
 * Sits inside the dashboard layout, so a page that blows up leaves the
 * sidebar and header standing and the agent can navigate somewhere
 * else instead of losing the whole app. That is the difference between
 * "the Dashboard is broken" and "the CRM is broken".
 *
 * Nearest-boundary-wins means this catches before the root `error.tsx`
 * for anything under (dashboard).
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[dashboard-error]", error);
  }, [error]);

  return (
    <div className="flex h-full min-h-[24rem] items-center justify-center p-6">
      <div className="max-w-md text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-destructive/10">
          <AlertTriangle className="h-6 w-6 text-destructive" />
        </div>

        <h1 className="mt-4 text-lg font-semibold text-foreground">
          Não foi possível carregar esta tela
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          O resto do sistema continua funcionando — use o menu ao lado para ir
          a outra área, ou tente carregar esta de novo.
        </p>

        {/* In a production build the real message is stripped; the
            digest is the only way to tie this screen to a server log. */}
        {error.digest && (
          <p className="mt-3 font-mono text-xs text-muted-foreground/70">
            Código: {error.digest}
          </p>
        )}

        <div className="mt-6 flex items-center justify-center gap-2">
          <button
            onClick={() => reset()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Tentar novamente
          </button>
          <Link
            href="/inbox"
            className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Ir para a caixa de entrada
          </Link>
        </div>
      </div>
    </div>
  );
}
