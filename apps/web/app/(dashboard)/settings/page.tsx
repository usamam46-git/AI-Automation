"use client";

import { PageHeader } from "@/components/shared/page-header";
import { MembersCard } from "@/components/settings/members-card";
import { OpenAiKeyCard } from "@/components/settings/openai-key-card";
import { RolesMatrixCard } from "@/components/settings/roles-matrix-card";

/**
 * Settings — Vol. 3 §10 specifies six admin pages (Organization, Members, API
 * Keys, Integrations, Audit Log, Roles & Permissions).
 *
 * Three now exist: Integrations (`/api/v1/integrations/openai_api_key`),
 * Members (`/api/v1/organizations/members`, landed 2026-08-18) and Audit Log,
 * which has its own top-level page. Organization, API Keys and the custom-role
 * builder are still deliberately absent rather than stubbed — a panel with no
 * endpoint behind it is worse than no panel.
 */
export default function SettingsPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 pt-1">
      <PageHeader eyebrow="Govern" title="Settings" description="People, credentials and integrations for this organization." />
      <MembersCard />
      <RolesMatrixCard />
      <OpenAiKeyCard />
    </div>
  );
}
