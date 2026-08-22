import { AuthGate } from "@/components/auth/auth-gate";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";

/**
 * `app-root` is the Atomie scope: it rebinds `--font-sans` to Plus Jakarta Sans
 * for the product surface only, leaving `app/(marketing)/` on the system stack
 * it was designed against. See globals.css.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <div className="app-root">
        <DashboardShell>{children}</DashboardShell>
      </div>
    </AuthGate>
  );
}
