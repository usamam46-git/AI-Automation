"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ConfigNote, Field, FieldGroup } from "@/components/workflow-builder/config-field";
import { FieldMapEditor } from "@/components/workflow-builder/field-map-editor";
import { JsonObjectEditor } from "@/components/workflow-builder/json-object-editor";
import { KeyValueEditor } from "@/components/workflow-builder/key-value-editor";

/**
 * Inline tool config, matching `_tool_config` in
 * apps/api/src/graphs/node_handlers.py.
 *
 * Only the two implemented tool types appear. Vol. 2 §7.2's `python_function`
 * and `mcp` are rejected by name at the backend and must not be offered.
 */
const TOOL_TYPES = [
  { value: "http_request", label: "HTTP request" },
  { value: "erp_connector", label: "ERP connector" },
] as const;

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

// Both spellings are accepted by the backend — the blueprint uses each in a
// different volume, and both reference workflows must be buildable verbatim.
const ERP_ACTIONS = ["create_journal_entry", "post_journal_entry"] as const;

const ERP_REQUIRED_PAYLOAD = ["vendor", "amount", "account_code"] as const;

export function ToolConfigForm({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const toolType = typeof config.tool_type === "string" ? config.tool_type : "http_request";
  const isMutating = config.is_mutating === true;

  function patch(next: Record<string, unknown>) {
    onChange({ ...config, ...next });
  }

  return (
    <div className="flex flex-col gap-5">
      <FieldGroup title="Tool">
        <Field label="Type" required>
          <Select value={toolType} onValueChange={(next) => patch({ tool_type: next })}>
            <SelectTrigger className="h-8 text-xs" aria-label="Tool type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TOOL_TYPES.map((type) => (
                <SelectItem key={type.value} value={type.value} className="text-xs">
                  {type.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <div className="flex items-start justify-between gap-3 rounded-xl border border-border p-3">
          <div className="min-w-0">
            <p className="text-xs font-medium">Writes to an external system</p>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              ERP writes, payments, anything with a side effect. Publishing is blocked unless a Human Approval node sits
              somewhere upstream.
            </p>
          </div>
          {/* Must be a real JSON boolean. A string "true" is rejected at invoke
              time and would read as non-mutating in the publish-time gate. */}
          <Switch aria-label="Writes to an external system" checked={isMutating} onCheckedChange={(checked) => patch({ is_mutating: checked })} />
        </div>
      </FieldGroup>

      {toolType === "http_request" ? <HttpRequestFields config={config} patch={patch} /> : <ErpConnectorFields config={config} patch={patch} />}
    </div>
  );
}

function HttpRequestFields({ config, patch }: { config: Record<string, unknown>; patch: (next: Record<string, unknown>) => void }) {
  const url = typeof config.url === "string" ? config.url : "";
  const method = typeof config.method === "string" ? config.method : "GET";
  const headers = (config.headers ?? {}) as Record<string, string>;
  const body = (config.body ?? {}) as Record<string, unknown>;
  const bodyFields = (config.body_fields ?? {}) as Record<string, string>;

  return (
    <>
      <FieldGroup title="Request">
        <div className="grid grid-cols-[6.5rem_1fr] gap-3">
          <Field label="Method">
            <Select value={method} onValueChange={(next) => patch({ method: next })}>
              <SelectTrigger className="h-8 text-xs" aria-label="HTTP method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HTTP_METHODS.map((item) => (
                  <SelectItem key={item} value={item} className="text-xs">
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            label="URL"
            htmlFor="tool-url"
            required
            error={url.trim() ? null : "Required."}
            hint="Static — state values reach the request through body fields, not URL interpolation."
          >
            <Input
              id="tool-url"
              value={url}
              placeholder="https://erp.internal/api/vendors"
              onChange={(event) => patch({ url: event.target.value })}
              className="h-8 font-mono text-xs"
            />
          </Field>
        </div>

        <Field label="Headers" hint="Values are sent as strings. Avoid pasting long-lived secrets here.">
          <KeyValueEditor value={headers} onChange={(next) => patch({ headers: next })} keyPlaceholder="Authorization" valuePlaceholder="Bearer …" addLabel="Add header" />
        </Field>

        <Field label="Timeout (seconds)" htmlFor="tool-timeout">
          <Input
            id="tool-timeout"
            type="number"
            step="1"
            min={1}
            value={typeof config.timeout_seconds === "number" ? config.timeout_seconds : 30}
            onChange={(event) => patch({ timeout_seconds: Number(event.target.value) || 30 })}
            className="h-8 w-28 text-xs"
          />
        </Field>
      </FieldGroup>

      <FieldGroup title="Body">
        <Field label="Static body" hint="Merged with the mapped fields below; mapped values win on a key collision.">
          <JsonObjectEditor value={body} onChange={(next) => patch({ body: next })} />
        </Field>
        <Field label="From state" hint="Destination key → dotted state path.">
          <FieldMapEditor value={bodyFields} onChange={(next) => patch({ body_fields: next })} />
        </Field>
      </FieldGroup>
    </>
  );
}

function ErpConnectorFields({ config, patch }: { config: Record<string, unknown>; patch: (next: Record<string, unknown>) => void }) {
  const action = typeof config.action === "string" ? config.action : "";
  const payload = (config.payload ?? {}) as Record<string, unknown>;
  const payloadFields = (config.payload_fields ?? {}) as Record<string, string>;

  const provided = new Set([...Object.keys(payload), ...Object.keys(payloadFields)]);
  const missing = ERP_REQUIRED_PAYLOAD.filter((key) => !provided.has(key));

  return (
    <FieldGroup title="ERP action">
      <ConfigNote>
        The ERP connector is a mock — it makes no network call and returns a <code className="font-mono">MOCK-…</code>{" "}
        confirmation. It exists so the mutating-tool approval path can be proven before a real adapter lands.
      </ConfigNote>

      <Field label="Action" required error={action ? null : "Required."}>
        <Select value={action} onValueChange={(next) => patch({ action: next })}>
          <SelectTrigger className="h-8 text-xs" aria-label="ERP action">
            <SelectValue placeholder="Choose an action" />
          </SelectTrigger>
          <SelectContent>
            {ERP_ACTIONS.map((item) => (
              <SelectItem key={item} value={item} className="font-mono text-xs">
                {item}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Static payload">
        <JsonObjectEditor value={payload} onChange={(next) => patch({ payload: next })} />
      </Field>

      <Field
        label="Payload from state"
        hint="Destination key → dotted state path."
        // Not a save-time error: the backend only fails on these at execution.
        error={missing.length > 0 ? `Missing at run time: ${missing.join(", ")}. Supply each in the payload or map it from state.` : null}
      >
        <FieldMapEditor value={payloadFields} onChange={(next) => patch({ payload_fields: next })} />
      </Field>
    </FieldGroup>
  );
}
