"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { useAuthStore } from "@/stores/auth-store";

export default function RegisterPage() {
  const router = useRouter();
  const setAccessToken = useAuthStore((state) => state.setAccessToken);
  const [fullName, setFullName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [organizationName, setOrganizationName] = React.useState("");
  const [isPending, setIsPending] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [submitted, setSubmitted] = React.useState(false);

  const errors = {
    fullName: submitted && !fullName.trim() ? "Enter your name." : null,
    email: submitted && !email.includes("@") ? "Enter a valid email address." : null,
    password: submitted && password.length < 8 ? "Use at least 8 characters." : null,
    organizationName: submitted && !organizationName.trim() ? "Enter an organization name." : null,
  };
  const hasErrors = Boolean(errors.fullName || errors.email || errors.password || errors.organizationName);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    setServerError(null);
    if (!fullName.trim() || !email.includes("@") || password.length < 8 || !organizationName.trim()) return;
    setIsPending(true);
    try {
      const response = await authApi.register({ full_name: fullName.trim(), email, password, organization_name: organizationName.trim() });
      setAccessToken(response.access_token);
      router.replace("/workflows");
    } catch (error) {
      setServerError(getApiErrorMessage(error, "Registration failed"));
    } finally {
      setIsPending(false);
    }
  }

  return (
    <Card className="w-full max-w-[400px] rounded-2xl shadow-md shadow-black/10">
      <CardHeader className="pb-3">
        <CardTitle className="text-xl">Create account</CardTitle>
        <CardDescription>Create your organization and default workspace.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={onSubmit} noValidate>
          {serverError ? <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">{serverError}</div> : null}
          <div className="grid gap-1.5"><Label htmlFor="fullName">Name</Label><Input id="fullName" value={fullName} onChange={(event) => setFullName(event.target.value)} aria-invalid={Boolean(errors.fullName)} />{errors.fullName ? <p className="text-xs text-destructive">{errors.fullName}</p> : null}</div>
          <div className="grid gap-1.5"><Label htmlFor="email">Email</Label><Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} aria-invalid={Boolean(errors.email)} />{errors.email ? <p className="text-xs text-destructive">{errors.email}</p> : null}</div>
          <div className="grid gap-1.5"><Label htmlFor="password">Password</Label><Input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} aria-invalid={Boolean(errors.password)} />{errors.password ? <p className="text-xs text-destructive">{errors.password}</p> : null}</div>
          <div className="grid gap-1.5"><Label htmlFor="org">Organization name</Label><Input id="org" value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} aria-invalid={Boolean(errors.organizationName)} />{errors.organizationName ? <p className="text-xs text-destructive">{errors.organizationName}</p> : null}</div>
          <Button className="w-full" disabled={isPending || (submitted && hasErrors)}>{isPending ? <Loader2 className="size-4 animate-spin" /> : null}Register</Button>
          <p className="text-center text-sm text-muted-foreground">Already registered? <Link className="font-medium text-foreground hover:underline" href="/login">Sign in</Link></p>
        </form>
      </CardContent>
    </Card>
  );
}
