"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * Boundary for everything below the root layout — the auth pages, the
 * invite flow, and anything not covered by a nearer `error.tsx`.
 *
 * The root layout still rendered here, so the theme and fonts are
 * intact. It deliberately does NOT use `useTranslations`: the i18n
 * provider is one of the things that can fail, and a boundary that
 * depends on it would throw while trying to report a throw.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app-error]", error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold text-foreground">
          Algo deu errado
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Não foi possível carregar esta página. Tente novamente — se
          continuar, volte ao início.
        </p>

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
            href="/dashboard"
            className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Ir para o início
          </Link>
        </div>
      </div>
    </div>
  );
}
