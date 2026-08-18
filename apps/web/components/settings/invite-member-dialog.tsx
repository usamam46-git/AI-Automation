"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Link2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RolePermissions } from "@/components/settings/role-permissions";
import { ASSIGNABLE_ROLES, membersApi, type AssignableRole, type InviteResult, type RoleOption } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { roleBlurb } from "@/lib/members";
import { findRole } from "@/lib/permissions";

/**
 * Invite someone to the organization.
 *
 * The dialog has two states, and the second one is the important one: after a
 * successful invite it stops being a form and becomes the **link handover**.
 * This platform sends no email — `worker_notifications` boots with an empty
 * task registry — so if the inviter closes this without copying the link, the
 * invitation is unreachable until they revoke it and issue a new one. Hence the
 * explicit copy step and a close button that says what it is doing.
 */
export function InviteMemberDialog({
  open,
  onOpenChange,
  roles,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: RoleOption[] | undefined;
}) {
  const queryClient = useQueryClient();
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<AssignableRole>("Editor");
  const [result, setResult] = React.useState<InviteResult | null>(null);
  const [copied, setCopied] = React.useState(false);
  const selectedRole = findRole(roles, role);

  const reset = React.useCallback(() => {
    setEmail("");
    setRole("Editor");
    setResult(null);
    setCopied(false);
  }, []);

  const mutation = useMutation({
    mutationFn: () => membersApi.invite({ email: email.trim(), role_name: role }),
    onSuccess: (data) => {
      setResult(data);
      queryClient.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (error) => toast.error(getApiErrorMessage(error, "Could not create the invitation")),
  });

  async function copyLink() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.accept_url);
      setCopied(true);
      toast.success("Invite link copied");
    } catch {
      // Clipboard access can be refused; the link is on screen and selectable,
      // so this is a downgrade rather than a failure.
      toast.error("Could not copy — select the link and copy it manually");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>Invitation ready — send this link</DialogTitle>
              <DialogDescription>
                {result.member.email} has been invited as {result.member.role_name}. They are not a member yet, and nothing is
                granted until they accept.
              </DialogDescription>
            </DialogHeader>

            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200">
              <p className="font-medium">Copy this now.</p>
              <p className="mt-0.5">
                No email is sent — this platform has no mail delivery yet. If you close this without copying, you will have to
                revoke the invitation and issue a new one.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Input readOnly value={result.accept_url} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button variant="outline" size="icon" onClick={copyLink} aria-label="Copy invite link">
                {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              The link expires in {result.expires_in_days} days and works only for {result.member.email}.
            </p>

            <DialogFooter>
              <Button variant="outline" onClick={reset}>
                Invite someone else
              </Button>
              <Button onClick={() => onOpenChange(false)}>{copied ? "Done" : "Close without copying"}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Invite a member</DialogTitle>
              <DialogDescription>They receive a link, and join only once they accept it themselves.</DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="invite-email">Email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  placeholder="colleague@company.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoFocus
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="invite-role">Role</Label>
                <Select value={role} onValueChange={(value) => setRole(value as AssignableRole)}>
                  <SelectTrigger id="invite-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* `assignable` from the API keeps Owner out; the constant
                        is only the pre-load fallback. */}
                    {(roles?.filter((r) => r.assignable).map((r) => r.name) ?? [...ASSIGNABLE_ROLES]).map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{roleBlurb(role)}</p>
                {/* Owner is absent from ASSIGNABLE_ROLES on both sides. Said out
                    loud so its absence reads as a decision, not an omission. */}
                <p className="text-xs text-muted-foreground/70">
                  <Link2 className="mr-1 inline size-3" aria-hidden />
                  Transferring ownership is not supported yet.
                </p>
              </div>

              {/* The whole point of the dialog being this size: whoever is
                  assigning sees the grant before they send it, not after
                  someone asks why the new hire can publish. */}
              <div className="max-h-64 overflow-y-auto rounded-xl border border-border p-3">
                {selectedRole ? (
                  <RolePermissions effective={selectedRole.effective_permissions} />
                ) : (
                  <p className="text-xs text-muted-foreground">Loading what this role can do…</p>
                )}
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => mutation.mutate()} disabled={!email.trim() || mutation.isPending}>
                {mutation.isPending ? "Creating…" : "Create invitation"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
