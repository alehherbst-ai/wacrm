"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

/** Persists the desktop rail preference across reloads and tabs. */
const SIDEBAR_COLLAPSED_KEY = "uniko:sidebar-collapsed";

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  // Desktop-only rail state: collapses the sidebar to an icon strip so
  // dense screens (the inbox's three columns above all) get the width
  // back. Ignored below lg, where the sidebar is a drawer instead.
  //
  // Reading localStorage in the initializer is safe here despite SSR:
  // `loading` starts true, so the first render on both server and
  // client is the spinner below — this value reaches no markup until
  // after hydration. That also means the rail never paints expanded
  // first and then snaps closed.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () =>
      typeof window !== "undefined" &&
      window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true",
  );

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
  }, []);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      <Sidebar
        open={sidebarOpen}
        onClose={closeSidebar}
        collapsed={sidebarCollapsed}
      />
      {/* `min-w-0` lets this column actually shrink and grow with the
          sidebar. Without it a flex child floors at its content's
          intrinsic width, so reclaiming the rail's space would push the
          page wider instead of widening the content. */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header
          onOpenSidebar={() => setSidebarOpen(true)}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebarCollapsed={toggleSidebarCollapsed}
        />
        {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
