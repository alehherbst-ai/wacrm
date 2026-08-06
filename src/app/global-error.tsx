"use client";

import { useEffect } from "react";

/**
 * Last-resort boundary. Catches errors thrown by the ROOT layout —
 * the one place a normal `error.tsx` cannot reach, because it lives
 * inside the layout that failed.
 *
 * That gap is why a crash here used to paint the raw React Server
 * Components stream onto the screen: with the document render aborted
 * and nothing to catch it, the browser showed the leftover flight
 * payload as plain text. Unreadable, and with no way out but the URL
 * bar.
 *
 * This file renders its own <html>/<body> because it REPLACES the root
 * layout rather than nesting inside it.
 *
 * Deliberately dependency-free: no i18n, no design system, no data
 * fetching. The root layout is where the locale provider and the theme
 * script live, so anything imported from there could be the very thing
 * that just failed. Styles are inline for the same reason — a
 * stylesheet that never loaded must not leave this page invisible.
 * The copy is Portuguese to match the app's default locale; a boundary
 * that can't render is worth more than one that's translated.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[global-error]", error);
  }, [error]);

  return (
    <html lang="pt-BR">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#020617",
          color: "#e2e8f0",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          padding: "24px",
        }}
      >
        <div style={{ maxWidth: "28rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600, margin: "0 0 8px" }}>
            Algo deu errado
          </h1>
          <p
            style={{
              fontSize: "0.875rem",
              lineHeight: 1.6,
              color: "#94a3b8",
              margin: "0 0 20px",
            }}
          >
            Não foi possível carregar a aplicação. Tente novamente — se
            continuar, recarregue a página ou entre em contato com o suporte.
          </p>

          {/* The digest is the only handle on the server-side stack for
              a production build, where the real message is stripped.
              Showing it turns "deu erro" into something diagnosable. */}
          {error.digest && (
            <p
              style={{
                fontSize: "0.75rem",
                color: "#64748b",
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
                margin: "0 0 20px",
              }}
            >
              Código: {error.digest}
            </p>
          )}

          <button
            onClick={() => reset()}
            style={{
              cursor: "pointer",
              border: "none",
              borderRadius: "8px",
              padding: "10px 20px",
              fontSize: "0.875rem",
              fontWeight: 500,
              background: "#10b981",
              color: "#022c22",
            }}
          >
            Tentar novamente
          </button>
        </div>
      </body>
    </html>
  );
}
