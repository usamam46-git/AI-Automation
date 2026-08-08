"use client";

import { OpenAiKeyCard } from "@/components/settings/openai-key-card";

/**
 * Settings — Vol. 3 §10 specifies six admin pages (Organization, Members, API
 * Keys, Integrations, Audit Log, Roles & Permissions). Only the Integrations
 * half has a backend: `/api/v1/integrations/openai_api_key`. The rest are
 * deliberately absent rather than stubbed, since a "Members" panel with no
 * endpoint behind it is worse than no panel.
 */
export default function SettingsPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div>
        <h2 className="text-xl font-semibold">Settings</h2>
        <p className="text-sm text-muted-foreground">Credentials and integrations for this organization.</p>
      </div>
      <OpenAiKeyCard />
    </div>
  );
}
