"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { authApi } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const accessToken = useAuthStore((state) => state.accessToken);
  const bootstrapped = useAuthStore((state) => state.bootstrapped);
  const setAccessToken = useAuthStore((state) => state.setAccessToken);
  const clearAuth = useAuthStore((state) => state.clearAuth);

  React.useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      if (accessToken) return;
      try {
        const response = await authApi.refresh();
        if (!cancelled) setAccessToken(response.access_token);
      } catch {
        if (!cancelled) {
          clearAuth();
          router.replace("/login");
        }
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, [accessToken, clearAuth, router, setAccessToken]);

  if (!bootstrapped || !accessToken) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-9 w-64 rounded-xl bg-muted/80" />
      </div>
    );
  }

  return <>{children}</>;
}
