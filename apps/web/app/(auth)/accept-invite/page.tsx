"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, ShieldCheck, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authApi, membersApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { roleBlurb } from "@/lib/members";
import { useAuthStore } from "@/stores/auth-store";

/**
 * `/accept-invite?token=…` — the other end of an invitation link.
 *
 * Three states, decided by what the visitor already has:
 *
 * - **Not signed in, no account** → register here. The invite token rides along
 *   on `POST /auth/register`, which then joins THIS organization instead of
 *   creating a throwaway one. Without that branch, "just register first" would
 *   drop an invitee into their own empty org — the exact outcome invitations
 *   exist to prevent.
 * - **Not signed in, has an account** → sign in, then come back to this link.
 * - **Signed in** → one button, `POST /invitations/{token}/accept`.
 *
 * The preview call is unauthenticated by necessity: the page has to be able to
 * say who is inviting them before asking for a password. It returns only the
 * org name, the addressed email and the role, and every failure mode — bad
 * signature, expired, revoked, already accepted — returns one identical 400, so
 * the page cannot be used to probe for valid membership ids.
 */
function AcceptInviteInner() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const accessToken = useAuthStore((state) => state.accessToken);
  const setAccessToken = useAuthStore((state) => state.setAccessToken);
  const [refreshAttempted, setRefreshAttempted] = React.useState(false);
  // Derived, not stored: setting it synchronously in the effect below when a
  // token is already present is a cascading render, and React's lint rule is
  // right to refuse it.
  const sessionChecked = Boolean(accessToken) || refreshAttempted;

  /**
   * Silent session bootstrap.
   *
   * Access tokens live in memory only (never localStorage — see the security
   * rules), so an already-signed-in person who opens this link from their email
   * arrives with an empty store and would be shown the *register* form. For
   * anyone who already has an account that form can only fail, with "Email
   * already registered".
   *
   * `AuthGate` does this same refresh for the dashboard, but it cannot be
   * reused here: it redirects to /login when there is no session, and this page
   * must work for someone who has no account at all. So the refresh is
   * attempted once, and a failure is a normal outcome that simply reveals the
   * register form rather than a redirect.
   */
  React.useEffect(() => {
    let cancelled = false;
    if (accessToken) return;
    authApi
      .refresh()
      .then((response) => {
        if (!cancelled) setAccessToken(response.access_token);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setRefreshAttempted(true);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, setAccessToken]);

  const preview = useQuery({
    queryKey: ["invite-preview", token],
    queryFn: () => membersApi.previewInvite(token),
    enabled: Boolean(token),
    retry: false,
  });

  const [fullName, setFullName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const accept = useMutation({
    mutationFn: () => membersApi.acceptInvite(token),
    onSuccess: () => router.replace("/dashboard"),
    onError: (err) => setError(getApiErrorMessage(err, "Could not accept this invitation")),
  });

  const registerAndJoin = useMutation({
    mutationFn: () =>
      authApi.register({
        full_name: fullName.trim(),
        email: preview.data!.email,
        password,
        invite_token: token,
      }),
    onSuccess: (response) => {
      setAccessToken(response.access_token);
      router.replace("/dashboard");
    },
    onError: (err) => setError(getApiErrorMessage(err, "Could not create your account")),
  });

  if (!token) {
    return <Shell title="No invitation link" body="This page needs an invitation link. Ask whoever invited you to send it again." />;
  }

  if (preview.isLoading || !sessionChecked) {
    return (
      <Shell title="Checking your invitation…">
        <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
      </Shell>
    );
  }

  if (preview.isError) {
    return (
      <Shell
        title="This invitation link is not valid"
        body={getApiErrorMessage(preview.error, "The link is invalid or has expired.")}
        tone="error"
      >
        <p className="text-center text-xs text-muted-foreground">
          Links expire, and they stop working once used or revoked. Ask for a new one.
        </p>
      </Shell>
    );
  }

  const invite = preview.data!;

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <div className="mb-1 flex items-center gap-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
          <ShieldCheck className="size-3.5" aria-hidden />
          Invitation
        </div>
        <CardTitle>Join {invite.organization_name}</CardTitle>
        <CardDescription>
          You have been invited as <strong>{invite.role_name}</strong> — {roleBlurb(invite.role_name)}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          This invitation was sent to <span className="font-medium text-foreground">{invite.email}</span>. It only works for that
          address.
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        {accessToken ? (
          <Button onClick={() => accept.mutate()} disabled={accept.isPending}>
            {accept.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Accept and join
          </Button>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              if (!fullName.trim() || password.length < 8) {
                setError("Enter your name and a password of at least 8 characters.");
                return;
              }
              registerAndJoin.mutate();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="accept-name">Your name</Label>
              <Input id="accept-name" value={fullName} onChange={(e) => setFullName(e.target.value)} autoFocus />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="accept-password">Choose a password</Label>
              <Input id="accept-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <p className="text-xs text-muted-foreground">At least 8 characters.</p>
            </div>
            <Button type="submit" disabled={registerAndJoin.isPending}>
              {registerAndJoin.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Create account and join
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Already have an account?{" "}
              <Link href={`/login?next=${encodeURIComponent(`/accept-invite?token=${token}`)}`} className="font-medium text-foreground underline">
                Sign in
              </Link>{" "}
              and open this link again.
            </p>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function Shell({
  title,
  body,
  tone,
  children,
}: {
  title: string;
  body?: string;
  tone?: "error";
  children?: React.ReactNode;
}) {
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        {tone === "error" ? <TriangleAlert className="mb-1 size-5 text-destructive" aria-hidden /> : null}
        <CardTitle>{title}</CardTitle>
        {body ? <CardDescription>{body}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {children}
        <Button variant="outline" asChild>
          <Link href="/login">Go to sign in</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export default function AcceptInvitePage() {
  // useSearchParams needs a Suspense boundary in the App Router, or the whole
  // route opts out of static rendering with a build-time error.
  return (
    <React.Suspense fallback={<Loader2 className="size-5 animate-spin text-muted-foreground" />}>
      <AcceptInviteInner />
    </React.Suspense>
  );
}
