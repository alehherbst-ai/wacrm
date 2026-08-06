import Link from "next/link";

/**
 * 404. Without this file Next serves its own unstyled default, which
 * on a mistyped URL looks indistinguishable from the app being broken.
 *
 * A server component on purpose: nothing here needs interactivity, and
 * a not-found page should render even when the client bundle doesn't.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-md text-center">
        <p className="font-mono text-sm text-muted-foreground">404</p>
        <h1 className="mt-2 text-xl font-semibold text-foreground">
          Página não encontrada
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          O endereço não existe ou foi movido.
        </p>
        <Link
          href="/dashboard"
          className="mt-6 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Ir para o início
        </Link>
      </div>
    </div>
  );
}
