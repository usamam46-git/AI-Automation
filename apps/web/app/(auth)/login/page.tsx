"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { useAuthStore } from "@/stores/auth-store";

export default function LoginPage() {
  const router = useRouter();
  const setAccessToken = useAuthStore((state) => state.setAccessToken);
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [isPending, setIsPending] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [submitted, setSubmitted] = React.useState(false);

  const errors = {
    email: submitted && !email.includes("@") ? "Enter a valid email address." : null,
    password: submitted && !password ? "Enter your password." : null,
  };
  const hasErrors = Boolean(errors.email || errors.password);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    setServerError(null);
    if (!email.includes("@") || !password) return;
    setIsPending(true);
    try {
      const response = await authApi.login({ email, password });
      setAccessToken(response.access_token);
      // The home dashboard (Vol. 3 §5), not the workflows list — this landed
      // on /workflows only because no home page existed before 2026-08-10.
      router.replace("/dashboard");
    } catch (error) {
      setServerError(getApiErrorMessage(error, "Invalid email or password"));
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Sign in</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">Continue to your workspace.</p>
      </div>
      <form className="grid gap-4" onSubmit={onSubmit} noValidate>
        {serverError ? <div className="rounded-xl bg-status-bad-soft px-3.5 py-2.5 text-sm text-status-bad">{serverError}</div> : null}
        <div className="grid gap-1.5"><Label htmlFor="email">Email</Label><Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} aria-invalid={Boolean(errors.email)} />{errors.email ? <p className="text-xs text-destructive">{errors.email}</p> : null}</div>
        <div className="grid gap-1.5"><Label htmlFor="password">Password</Label><Input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} aria-invalid={Boolean(errors.password)} />{errors.password ? <p className="text-xs text-destructive">{errors.password}</p> : null}</div>
        <Button className="w-full" disabled={isPending || (submitted && hasErrors)}>{isPending ? <Loader2 className="size-4 animate-spin" /> : null}Login</Button>
        <p className="text-center text-sm text-muted-foreground">No account? <Link className="font-medium text-foreground hover:underline" href="/register">Create one</Link></p>
      </form>
    </div>
  );
}
