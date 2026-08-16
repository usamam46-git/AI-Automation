"use client";

import * as React from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ConfigNote, Field, FieldGroup } from "@/components/workflow-builder/config-field";
import { FieldMapEditor } from "@/components/workflow-builder/field-map-editor";
import { JsonObjectEditor } from "@/components/workflow-builder/json-object-editor";
import { KeyValueEditor } from "@/components/workflow-builder/key-value-editor";
import type { KnowledgeBase, Tool } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Tool node config. A tool node has TWO config paths and they are mutually
 * exclusive here, because they are not symmetric on the server:
 *
 * - **Registry** (`tool_id` only) — resolved once per run against the `tools`
 *   table. This is the only path that produces a `tool_executions` audit row,
 *   since `tool_executions.tool_id` is NOT NULL, and the only one where
 *   `is_mutating` fails closed (a bool column cannot be misspelled the way a
 *   JSONB key can).
 * - **Inline** (`tool_type` + its settings) — the original path, supported
 *   forever.
 *
 * **Inline always wins.** `_tool_config` reads `tool_type` first, so a node
 * carrying both is an inline node with a dead `tool_id`. Offering both at once
 * would let someone edit a picker that has no effect, which is why switching
 * source clears the other path's keys rather than layering them.
 *
 * In registry mode only `body`/`body_fields`/`payload`/`payload_fields` are
 * editable — exactly `ToolService.NODE_OVERRIDABLE_KEYS`. `url`/`method`/
 * `headers`/`action`/`timeout_seconds`/`is_mutating` come from the registry row
 * and are shown read-only, because a node that could re-point a reviewed tool
 * would leave the publish-time approval gate reading `is_mutating` off a row
 * that no longer describes the call.
 */
const TOOL_TYPES = [
  { value: "http_request", label: "HTTP request" },
  { value: "erp_connector", label: "ERP connector" },
  { value: "knowledge_search", label: "Knowledge search" },
] as const;

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

// Both spellings are accepted by the backend — the blueprint uses each in a
// different volume, and both reference workflows must be buildable verbatim.
const ERP_ACTIONS = ["create_journal_entry", "post_journal_entry"] as const;

const ERP_REQUIRED_PAYLOAD = ["vendor", "amount", "account_code"] as const;

/**
 * Keys the registry owns. Cleared when a node moves onto a registry tool.
 *
 * `knowledge_base_id`/`top_k`/`score_floor` are here rather than in the
 * overridable set on purpose, mirroring `ToolService.NODE_OVERRIDABLE_KEYS`: the
 * knowledge base is the retrieval TARGET, the direct analogue of `url`, and a
 * node that could swap the corpus under a reviewed tool is the same hole as one
 * that could re-point its endpoint. Only the question asked is per-usage.
 */
const REGISTRY_OWNED_KEYS = [
  "tool_type",
  "url",
  "method",
  "headers",
  "timeout_seconds",
  "action",
  "is_mutating",
  "knowledge_base_id",
  "top_k",
  "score_floor",
] as const;

type ToolSource = "registry" | "inline";

/**
 * Inline is the default for a node with neither key set, matching
 * `node-catalog.ts`'s blank config — which apps/api/CLAUDE.md pins as a shape
 * the backend must keep accepting, so it is not changed here.
 */
function sourceOf(config: Record<string, unknown>): ToolSource {
  if (config.tool_type) return "inline";
  // Presence, not truthiness: switching to registry writes `tool_id: ""` before
  // a tool is picked, and reading that as "no tool_id" would bounce the panel
  // straight back to the inline fields with the toggle showing registry.
  return "tool_id" in config ? "registry" : "inline";
}

export function ToolConfigForm({
  config,
  onChange,
  tools,
  knowledgeBases,
}: {
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** The workspace's registry tools. `undefined` while they are still loading. */
  tools?: Tool[];
  /** The workspace's knowledge bases, for the retrieval picker. `undefined` while loading. */
  knowledgeBases?: KnowledgeBase[];
}) {
  const source = sourceOf(config);

  function patch(next: Record<string, unknown>) {
    onChange({ ...config, ...next });
  }

  function switchSource(next: ToolSource) {
    if (next === source) return;

    if (next === "registry") {
      // Drop everything the registry owns. Leaving `tool_type` behind would
      // silently win over the picker; leaving `is_mutating: true` behind would
      // upgrade the node past whatever the chosen tool declares.
      const kept = { ...config };
      for (const key of REGISTRY_OWNED_KEYS) delete kept[key];
      onChange({ ...kept, tool_id: "" });
      return;
    }

    const kept = { ...config };
    delete kept.tool_id;
    onChange({ ...kept, tool_type: "http_request", method: "GET", url: "", is_mutating: false });
  }

  return (
    <div className="flex flex-col gap-5">
      <FieldGroup title="Tool">
        <Field label="Source">
          <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-0.5">
            {(["registry", "inline"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => switchSource(option)}
                aria-pressed={source === option}
                className={cn(
                  "flex-1 rounded-md px-2 py-1 text-xs transition-colors",
                  source === option ? "bg-background shadow-sm shadow-black/5" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option === "registry" ? "Registry tool" : "Inline config"}
              </button>
            ))}
          </div>
        </Field>
      </FieldGroup>

      {source === "registry" ? (
        <RegistryFields config={config} patch={patch} tools={tools} knowledgeBases={knowledgeBases} />
      ) : (
        <InlineFields config={config} patch={patch} knowledgeBases={knowledgeBases} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Registry mode
// ---------------------------------------------------------------------------

/**
 * The one-line "what does this tool actually do" summary under the picker.
 *
 * A retrieval tool has no endpoint to print, so it shows the corpus it searches
 * and the two knobs a node cannot touch. The knowledge base falls back to its
 * raw id rather than rendering blank: an id at least identifies the row when the
 * list has not loaded, or when the KB was deleted out from under the tool.
 */
function registrySummary(toolType: string, toolConfig: Record<string, unknown>, knowledgeBases?: KnowledgeBase[]): string {
  if (toolType === "http_request") {
    const method = typeof toolConfig.method === "string" ? toolConfig.method : "GET";
    return `${method} ${typeof toolConfig.url === "string" ? toolConfig.url : ""}`;
  }
  if (toolType === "erp_connector") return typeof toolConfig.action === "string" ? toolConfig.action : "";

  const kbId = typeof toolConfig.knowledge_base_id === "string" ? toolConfig.knowledge_base_id : "";
  const kbName = knowledgeBases?.find((kb) => kb.id === kbId)?.name ?? kbId;
  const topK = typeof toolConfig.top_k === "number" ? toolConfig.top_k : 5;
  const floor = typeof toolConfig.score_floor === "number" ? toolConfig.score_floor : 0.3;
  return `${kbName} · top ${topK} · score ≥ ${floor}`;
}

function RegistryFields({
  config,
  patch,
  tools,
  knowledgeBases,
}: {
  config: Record<string, unknown>;
  patch: (next: Record<string, unknown>) => void;
  tools?: Tool[];
  knowledgeBases?: KnowledgeBase[];
}) {
  const toolId = typeof config.tool_id === "string" ? config.tool_id : "";
  const selected = tools?.find((tool) => tool.id === toolId) ?? null;
  const toolConfig = (selected?.config ?? {}) as Record<string, unknown>;

  // A stored id with no matching row: the tool was deleted, or belongs to
  // another workspace. `validateGraph` reports it as `unknown_tool` — this is
  // just the local explanation next to the picker.
  const unresolved = toolId !== "" && tools !== undefined && selected === null;

  return (
    <>
      <FieldGroup title="Registry">
        <Field
          label="Tool"
          required
          error={toolId ? (unresolved ? "This tool is no longer in the registry." : null) : "Required."}
        >
          <Select value={toolId} onValueChange={(next) => patch({ tool_id: next })} disabled={tools === undefined || tools.length === 0}>
            <SelectTrigger className="h-8 text-xs" aria-label="Registry tool">
              <SelectValue placeholder={tools === undefined ? "Loading…" : "Choose a tool"} />
            </SelectTrigger>
            <SelectContent>
              {(tools ?? []).map((tool) => (
                <SelectItem key={tool.id} value={tool.id} className="text-xs">
                  <span className="font-mono">{tool.name}</span>
                  {tool.is_mutating ? <span className="ml-1.5 text-amber-600 dark:text-amber-400">writes</span> : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {tools !== undefined && tools.length === 0 ? (
          <ConfigNote>
            No tools are registered in this workspace yet.{" "}
            <Link href="/tools" className="underline underline-offset-2">
              Register one
            </Link>{" "}
            to reference it here, or switch to inline configuration.
          </ConfigNote>
        ) : null}

        {selected ? (
          <div className="flex flex-col gap-1.5 rounded-xl border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-xs font-medium">{TOOL_TYPES.find((type) => type.value === selected.tool_type)?.label ?? selected.tool_type}</p>
              {selected.is_mutating ? <Badge variant="mutating">Writes</Badge> : null}
            </div>
            <p className="break-all font-mono text-[11px] leading-snug text-muted-foreground">
              {registrySummary(selected.tool_type, toolConfig, knowledgeBases)}
            </p>
            <p className="text-[11px] leading-snug text-muted-foreground">
              {selected.tool_type === "knowledge_search"
                ? "The knowledge base, passage count and score floor are set once in the registry and cannot be changed per node — only the question below is per-node."
                : "The endpoint, headers and write flag are set once in the registry and cannot be changed per node — only the values below are per-node."}
            </p>
            <Link href="/tools" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground">
              Manage in Tools
              <ExternalLink className="size-3" />
            </Link>
          </div>
        ) : null}
      </FieldGroup>

      {/* Which payload editors apply depends on the registry row's type, so they
          only appear once a tool actually resolves. */}
      {selected?.tool_type === "http_request" ? <BodyFields config={config} patch={patch} /> : null}
      {selected?.tool_type === "erp_connector" ? <PayloadFields config={config} patch={patch} /> : null}
      {selected?.tool_type === "knowledge_search" ? <QueryFields config={config} patch={patch} /> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Inline mode — unchanged shapes, matching `_tool_config` in node_handlers.py
// ---------------------------------------------------------------------------

function InlineFields({
  config,
  patch,
  knowledgeBases,
}: {
  config: Record<string, unknown>;
  patch: (next: Record<string, unknown>) => void;
  knowledgeBases?: KnowledgeBase[];
}) {
  const toolType = typeof config.tool_type === "string" ? config.tool_type : "http_request";
  const isMutating = config.is_mutating === true;
  // Retrieval is read-only, and the backend rejects `is_mutating: true` on it
  // outright — a read that forces an approval gate upstream devalues the gate.
  const canMutate = toolType !== "knowledge_search";

  return (
    <>
      <FieldGroup title="Inline tool">
        <ConfigNote>
          An inline tool leaves no row in the tool execution log — that trail needs a registry tool to point at.
        </ConfigNote>

        <Field label="Type" required>
          {/* Only the two implemented types. Vol. 2 §7.2's `python_function` and
              `mcp` are rejected by name at the backend and must not be offered. */}
          <Select
            value={toolType}
            onValueChange={(next) =>
              // Switching to retrieval must drop a leftover `is_mutating: true`,
              // or the node saves fine and then 422s at publish on a read node.
              patch(next === "knowledge_search" ? { tool_type: next, is_mutating: false } : { tool_type: next })
            }
          >
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

        {canMutate ? (
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
        ) : (
          <ConfigNote>Retrieval only reads. It never needs an approval gate upstream.</ConfigNote>
        )}
      </FieldGroup>

      {toolType === "http_request" ? <HttpRequestFields config={config} patch={patch} /> : null}
      {toolType === "erp_connector" ? <ErpConnectorFields config={config} patch={patch} /> : null}
      {toolType === "knowledge_search" ? <KnowledgeSearchFields config={config} patch={patch} knowledgeBases={knowledgeBases} /> : null}
    </>
  );
}

function HttpRequestFields({ config, patch }: { config: Record<string, unknown>; patch: (next: Record<string, unknown>) => void }) {
  const url = typeof config.url === "string" ? config.url : "";
  const method = typeof config.method === "string" ? config.method : "GET";
  const headers = (config.headers ?? {}) as Record<string, string>;

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

      <BodyFields config={config} patch={patch} />
    </>
  );
}

function ErpConnectorFields({ config, patch }: { config: Record<string, unknown>; patch: (next: Record<string, unknown>) => void }) {
  const action = typeof config.action === "string" ? config.action : "";

  return (
    <>
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
      </FieldGroup>

      <PayloadFields config={config} patch={patch} />
    </>
  );
}

// ---------------------------------------------------------------------------
// The per-node overridable halves — shared by both sources, because these are
// exactly the keys a node may supply on a registry tool.
// ---------------------------------------------------------------------------

function BodyFields({ config, patch }: { config: Record<string, unknown>; patch: (next: Record<string, unknown>) => void }) {
  const body = (config.body ?? {}) as Record<string, unknown>;
  const bodyFields = (config.body_fields ?? {}) as Record<string, string>;

  return (
    <FieldGroup title="Body">
      <Field label="Static body" hint="Merged with the mapped fields below; mapped values win on a key collision.">
        <JsonObjectEditor value={body} onChange={(next) => patch({ body: next })} />
      </Field>
      <Field label="From state" hint="Destination key → dotted state path.">
        <FieldMapEditor value={bodyFields} onChange={(next) => patch({ body_fields: next })} />
      </Field>
    </FieldGroup>
  );
}

function PayloadFields({ config, patch }: { config: Record<string, unknown>; patch: (next: Record<string, unknown>) => void }) {
  const payload = (config.payload ?? {}) as Record<string, unknown>;
  const payloadFields = (config.payload_fields ?? {}) as Record<string, string>;

  const provided = new Set([...Object.keys(payload), ...Object.keys(payloadFields)]);
  const missing = ERP_REQUIRED_PAYLOAD.filter((key) => !provided.has(key));

  return (
    <FieldGroup title="Payload">
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

/**
 * Inline `knowledge_search` config.
 *
 * The knowledge base is picked from the workspace's own list rather than typed
 * as a UUID: the backend resolves it against `organization_id` taken from the
 * run row, so a hand-typed id from another tenant fails at execution with a
 * config error rather than leaking anything — but failing at run time is a poor
 * substitute for not offering the mistake.
 */
function KnowledgeSearchFields({
  config,
  patch,
  knowledgeBases,
}: {
  config: Record<string, unknown>;
  patch: (next: Record<string, unknown>) => void;
  knowledgeBases?: KnowledgeBase[];
}) {
  const kbId = typeof config.knowledge_base_id === "string" ? config.knowledge_base_id : "";
  const topK = typeof config.top_k === "number" ? config.top_k : undefined;

  // `undefined` means still loading; an empty array means none exist. Treating
  // the two the same would flash "create one first" on every panel open.
  const loading = knowledgeBases === undefined;
  const unresolved = Boolean(kbId) && !loading && !knowledgeBases?.some((kb) => kb.id === kbId);

  return (
    <>
      <FieldGroup title="Knowledge base">
        <Field
          label="Search in"
          required
          error={kbId ? (unresolved ? "This knowledge base no longer exists in this workspace." : null) : "Required."}
        >
          {loading ? (
            <div className="h-8 animate-pulse rounded-lg bg-muted" />
          ) : knowledgeBases?.length ? (
            <Select value={kbId || undefined} onValueChange={(next) => patch({ knowledge_base_id: next })}>
              <SelectTrigger className="h-8 text-xs" aria-label="Knowledge base">
                <SelectValue placeholder="Choose a knowledge base" />
              </SelectTrigger>
              <SelectContent>
                {knowledgeBases.map((kb) => (
                  <SelectItem key={kb.id} value={kb.id} className="text-xs">
                    {kb.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <ConfigNote>
              No knowledge bases in this workspace yet.{" "}
              <Link href="/knowledge" className="underline underline-offset-2 hover:text-foreground">
                Create one
              </Link>
              , then add a document.
            </ConfigNote>
          )}
        </Field>

        <Field label="Passages to retrieve" hint="Defaults to 5. Higher means more context and a larger prompt.">
          <Input
            className="h-8 text-xs"
            type="number"
            min={1}
            max={20}
            value={topK ?? ""}
            placeholder="5"
            onChange={(event) => {
              const raw = event.target.value;
              // Omit the key entirely when blank so the backend default applies,
              // rather than sending 0 and clamping to a single passage.
              if (raw === "") {
                const next = { ...config };
                delete next.top_k;
                patch(next);
                return;
              }
              patch({ top_k: Math.max(1, Math.min(20, Number(raw))) });
            }}
          />
        </Field>
      </FieldGroup>

      <QueryFields config={config} patch={patch} />
    </>
  );
}

/**
 * The question asked. Split out because it is the ONE part of a retrieval tool
 * a node may override on a registry row (`query`/`query_fields`), so registry
 * mode renders exactly this and nothing else.
 */
function QueryFields({ config, patch }: { config: Record<string, unknown>; patch: (next: Record<string, unknown>) => void }) {
  const query = typeof config.query === "string" ? config.query : "";
  const queryFields = (config.query_fields ?? {}) as Record<string, string>;
  const hasSource = query.trim().length > 0 || Object.keys(queryFields).length > 0;

  return (
    <FieldGroup title="Query">
      <Field
        label="Static question"
        hint="Used when nothing is mapped from state."
        error={hasSource ? null : "Set a static question or map one from state."}
      >
        <Input
          className="h-8 text-xs"
          value={query}
          placeholder="What approval is required for this invoice?"
          onChange={(event) => patch({ query: event.target.value })}
        />
      </Field>

      <Field label="Question from state" hint="A resolved value wins over the static question above.">
        <FieldMapEditor value={queryFields} onChange={(next) => patch({ query_fields: next })} />
      </Field>
    </FieldGroup>
  );
}
