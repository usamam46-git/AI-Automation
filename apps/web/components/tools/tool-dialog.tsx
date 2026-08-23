"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
// Generic flat-map editor. It lives under workflow-builder/ because that is
// where it was first needed, not because it is builder-specific.
import { KeyValueEditor } from "@/components/workflow-builder/key-value-editor";
import { TOOL_NAME_PATTERN, type Tool, type ToolType, knowledgeApi, toolsApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";

/**
 * Create/edit form for a registry tool.
 *
 * **The fields here are exactly the ones a node CANNOT override.** The backend's
 * merge is asymmetric on purpose (`ToolService.NODE_OVERRIDABLE_KEYS`): a node
 * may supply per-usage state wiring (`body`/`body_fields`/`payload`/
 * `payload_fields`) but never `url`/`method`/`headers`/`action`/
 * `timeout_seconds`/`is_mutating`, or it could re-point a reviewed tool at an
 * arbitrary endpoint while the publish gate went on reading `is_mutating` off a
 * row that no longer describes it. So the registry owns the shape of the call
 * and the node owns the payload — and this dialog deliberately offers no body
 * editor, because anything it collected there would be silently replaced by the
 * first node that wired one up.
 *
 * `input_schema` is likewise absent: agent function-calling is deferred, so
 * nothing reads it yet. PATCH omits the field entirely (the API uses
 * `exclude_unset`), so an existing value survives an edit here untouched.
 */
const TOOL_TYPES: Array<{ value: ToolType; label: string; help: string }> = [
  { value: "http_request", label: "HTTP request", help: "Calls an external HTTP API. Retried 3× on 429/5xx; 401/403 fail the node immediately." },
  { value: "erp_connector", label: "ERP connector", help: "Mock — makes no network call and returns a MOCK-… confirmation. It exists so the approval path can be proven before a real adapter lands." },
  {
    value: "knowledge_search",
    label: "Knowledge search",
    help: "Embeds a question and returns the closest passages from one knowledge base. Read-only, and billed per query.",
  },
  {
    value: "notify",
    label: "Notification",
    help: "Tells someone the outcome. Queued, not sent inline — a channel outage cannot fail a run whose work is already done.",
  },
];

const NOTIFY_CHANNELS: Array<{ value: string; label: string; help: string }> = [
  { value: "in_app", label: "In-app", help: "Writes a notification row. No external transport, so it always works." },
  { value: "webhook", label: "Webhook", help: "POSTs to a Slack, Teams or Zapier incoming webhook. Put the URL's token in Secrets." },
];

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

// Mirrors `DEFAULT_IDEMPOTENCY_HEADER` in apps/api/src/graphs/node_handlers.py.
// The name is configurable because there is no standard one — Stripe and the
// IETF draft say Idempotency-Key, ERPs commonly use X-Request-Id.
const DEFAULT_IDEMPOTENCY_HEADER = "Idempotency-Key";

// Both spellings are accepted by the backend — the blueprint uses one in Vol. 2
// §7.2 and the other in Vol. 5 §5, and both reference workflows must be
// buildable verbatim.
const ERP_ACTIONS = ["create_journal_entry", "post_journal_entry"] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function ToolDialogForm({ tool, onOpenChange }: { tool: Tool | null; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const orgId = useAuthStore((state) => state.orgId);
  const workspaceId = useAppStore((state) => state.currentWorkspaceId);
  const editing = tool !== null;
  const existingConfig = asRecord(tool?.config);

  const [name, setName] = React.useState(tool?.name ?? "");
  const [description, setDescription] = React.useState(tool?.description ?? "");
  const [toolType, setToolType] = React.useState<ToolType>(tool?.tool_type ?? "http_request");
  const [isMutating, setIsMutating] = React.useState(tool?.is_mutating ?? false);
  const [url, setUrl] = React.useState(typeof existingConfig.url === "string" ? existingConfig.url : "");
  const [method, setMethod] = React.useState(typeof existingConfig.method === "string" ? existingConfig.method : "GET");
  const [headers, setHeaders] = React.useState<Record<string, string>>((existingConfig.headers ?? {}) as Record<string, string>);
  const [timeoutSeconds, setTimeoutSeconds] = React.useState(typeof existingConfig.timeout_seconds === "number" ? existingConfig.timeout_seconds : 30);
  const [urlFields, setUrlFields] = React.useState<Record<string, string>>((existingConfig.url_fields ?? {}) as Record<string, string>);
  const [params, setParams] = React.useState<Record<string, string>>(
    Object.fromEntries(Object.entries((existingConfig.params ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)])),
  );
  const [paramsFields, setParamsFields] = React.useState<Record<string, string>>((existingConfig.params_fields ?? {}) as Record<string, string>);
  const [idempotencyHeader, setIdempotencyHeader] = React.useState(
    typeof asRecord(existingConfig.idempotency).header === "string" ? (asRecord(existingConfig.idempotency).header as string) : "",
  );
  const [dedupes, setDedupes] = React.useState(existingConfig.idempotency != null);
  // Write-only: the API returns `secret_keys` and never a value, so an existing
  // tool's secrets cannot be pre-filled. An empty map therefore means "leave the
  // stored ones alone", which is why `secrets` is omitted from the PATCH unless
  // the author actually touched it — see the mutation below.
  const [secrets, setSecrets] = React.useState<Record<string, string>>({});
  const [secretsTouched, setSecretsTouched] = React.useState(false);
  const [notifyChannel, setNotifyChannel] = React.useState(typeof existingConfig.channel === "string" ? existingConfig.channel : "in_app");
  const [notifyTitle, setNotifyTitle] = React.useState(typeof existingConfig.title === "string" ? existingConfig.title : "");
  const [notifyBody, setNotifyBody] = React.useState(typeof existingConfig.body === "string" ? existingConfig.body : "");
  const [action, setAction] = React.useState(typeof existingConfig.action === "string" ? existingConfig.action : "");
  const [knowledgeBaseId, setKnowledgeBaseId] = React.useState(
    typeof existingConfig.knowledge_base_id === "string" ? existingConfig.knowledge_base_id : "",
  );
  const [query, setQuery] = React.useState(typeof existingConfig.query === "string" ? existingConfig.query : "");
  const [topK, setTopK] = React.useState(typeof existingConfig.top_k === "number" ? existingConfig.top_k : 5);
  const [scoreFloor, setScoreFloor] = React.useState(typeof existingConfig.score_floor === "number" ? existingConfig.score_floor : 0.3);

  // Same key shape as the Knowledge page and the builder, so all three share one
  // cache entry. A tool can only search a KB in its own workspace.
  const knowledgeQuery = useQuery({
    queryKey: ["knowledge-bases", orgId, workspaceId ?? null],
    queryFn: () => knowledgeApi.list({ workspaceId }),
    enabled: toolType === "knowledge_search" && Boolean(orgId),
  });

  const trimmedName = name.trim();
  const trimmedQuery = query.trim();
  const nameValid = TOOL_NAME_PATTERN.test(trimmedName);
  const configComplete =
    toolType === "http_request"
      ? url.trim().length > 0
      : toolType === "erp_connector"
        ? action.length > 0
        : toolType === "notify"
          ? // `_notify_config` refuses a config with no title, no body and no
            // body_fields — a notification nobody can read looks delivered. The
            // registry row owns a default; a node may override the title.
            (notifyTitle.trim().length > 0 || notifyBody.trim().length > 0) && (notifyChannel !== "webhook" || url.trim().length > 0)
          : knowledgeBaseId.length > 0 && trimmedQuery.length > 0;
  // Retrieval reads; `_knowledge_search_config` rejects `is_mutating: true` on
  // it outright, because a read that forces an approval gate upstream devalues
  // the gate. The switch is hidden rather than disabled — there is no decision.
  // Both retrieval and notification reject `is_mutating` outright at the
  // backend: one only reads, and the other changes no external record. Vol. 5
  // puts Notify AFTER the gate, so allowing the flag would demand a second
  // approval to tell someone the first one happened.
  const canMutate = toolType !== "knowledge_search" && toolType !== "notify";

  function buildConfig(): Record<string, unknown> {
    // Preserve any keys the API knows about that this dialog doesn't edit (a
    // body default set through another path, say) rather than dropping them on
    // an unrelated rename.
    const preserved = { ...existingConfig };
    for (const key of [
      "url", "method", "headers", "timeout_seconds", "url_fields", "params", "params_fields", "idempotency",
      "action", "knowledge_base_id", "query", "top_k", "score_floor", "channel", "title", "body",
    ]) {
      delete preserved[key];
    }

    if (toolType === "http_request") {
      return {
        ...preserved,
        url: url.trim(),
        method,
        headers,
        url_fields: urlFields,
        params,
        params_fields: paramsFields,
        // Null, not omitted: `preserved` has already dropped the old key, and an
        // explicit null is what the backend reads as "this endpoint makes no
        // dedupe promise" — which is what keeps a mutating call from being
        // retried after an unknown outcome.
        idempotency: dedupes ? { header: idempotencyHeader.trim() || DEFAULT_IDEMPOTENCY_HEADER } : null,
        timeout_seconds: timeoutSeconds,
      };
    }
    if (toolType === "erp_connector") return { ...preserved, action };
    if (toolType === "notify") {
      return {
        ...preserved,
        channel: notifyChannel,
        title: notifyTitle.trim(),
        body: notifyBody.trim(),
        // `_notify_config` rejects a `url` on a channel that does not use one,
        // so it must be absent rather than an empty string.
        ...(notifyChannel === "webhook" ? { url: url.trim() } : {}),
      };
    }
    return { ...preserved, knowledge_base_id: knowledgeBaseId, query: trimmedQuery, top_k: topK, score_floor: scoreFloor };
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const config = buildConfig();
      // `canMutate &&` is load-bearing, not belt-and-braces: the switch keeps its
      // state while the type Select changes, so flipping it on for an HTTP tool
      // and then switching to retrieval would send a flag the backend 422s.
      const mutating = canMutate && isMutating;
      if (editing) {
        return toolsApi.update(tool.id, {
          name: trimmedName,
          description: description.trim() || null,
          config,
          is_mutating: mutating,
          // Omitted unless edited. `secrets` REPLACES the stored map, so sending
          // the dialog's empty state on an unrelated rename would wipe every
          // credential the tool has — and the config still referencing them
          // would then 422, which is the good outcome of a bad idea.
          ...(secretsTouched ? { secrets } : {}),
        });
      }
      return toolsApi.create({
        workspace_id: workspaceId!,
        name: trimmedName,
        tool_type: toolType,
        description: description.trim() || null,
        config,
        secrets,
        is_mutating: mutating,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["tools", orgId] });
      toast.success(editing ? "Tool updated" : "Tool created");
      onOpenChange(false);
    },
    // 409 is the duplicate-name case: tool names are the LLM's function names
    // and are unique per workspace. The server's message says so already.
    onError: (error) => toast.error(getApiErrorMessage(error, editing ? "Could not update tool" : "Could not create tool")),
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>{editing ? `Edit ${tool.name}` : "New tool"}</DialogTitle>
        <DialogDescription>
          {editing
            ? "Nodes referencing this tool pick the change up on their next run — resolution happens once per run, not at publish."
            : "Register a tool once, then reference it from any workflow node in this workspace."}
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="tool-name">Name</Label>
          <Input id="tool-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="lookup_vendor" className="font-mono" autoFocus />
          <p className="text-xs text-muted-foreground">
            This is the function name a model would see: letters, digits, <code className="font-mono">_</code> and{" "}
            <code className="font-mono">-</code> only, up to 64 characters. Unique within the workspace.
          </p>
          {trimmedName && !nameValid ? <p className="text-xs text-destructive">Not a valid function name.</p> : null}
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="tool-description">Description</Label>
          <Textarea
            id="tool-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What the tool does, in the model's words."
          />
        </div>

        <div className="grid gap-1.5">
          <Label>Type</Label>
          {/* Immutable after create: `ToolUpdate` forbids the field outright,
              because changing the type orphans the type-specific config. */}
          <Select value={toolType} onValueChange={(value) => setToolType(value as ToolType)} disabled={editing}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {TOOL_TYPES.map((type) => <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {editing ? "A tool's type cannot be changed — create a new tool instead." : TOOL_TYPES.find((type) => type.value === toolType)?.help}
          </p>
        </div>

        {toolType === "http_request" ? (
          <>
            <div className="grid grid-cols-[7rem_1fr] gap-3">
              <div className="grid gap-1.5">
                <Label>Method</Label>
                <Select value={method} onValueChange={setMethod}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{HTTP_METHODS.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="tool-url">URL</Label>
                <Input id="tool-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://erp.internal/api/vendors" className="font-mono" />
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label>URL placeholders</Label>
              <KeyValueEditor
                value={urlFields}
                onChange={setUrlFields}
                keyPlaceholder="vendor_id"
                valuePlaceholder="node_outputs.extract.vendor_id"
                addLabel="Add placeholder"
              />
              <p className="text-xs text-muted-foreground">
                Fills <code className="font-mono">{"{vendor_id}"}</code> in the URL from graph state. Every placeholder needs an entry and
                every entry needs a placeholder — publishing fails naming the mismatch. Values are percent-encoded, so one can only ever
                become a single path segment.
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label>Query parameters</Label>
              <KeyValueEditor value={params} onChange={setParams} keyPlaceholder="include" valuePlaceholder="lines" addLabel="Add parameter" />
              <KeyValueEditor
                value={paramsFields}
                onChange={setParamsFields}
                keyPlaceholder="period"
                valuePlaceholder="trigger_payload.period"
                addLabel="Add parameter from state"
              />
              <p className="text-xs text-muted-foreground">
                Static values above, state-resolved below. A state path that resolves to nothing is dropped rather than sent as
                <code className="font-mono"> None</code> — an unset filter means &ldquo;don&rsquo;t filter&rdquo;.
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label>Headers</Label>
              <KeyValueEditor value={headers} onChange={setHeaders} keyPlaceholder="Authorization" valuePlaceholder="Bearer {{secrets.erp_token}}" addLabel="Add header" />
              <p className="text-xs text-muted-foreground">
                Stripped from node output and from the tool audit trail — but stored in plaintext and returned by the API, so put the
                credential itself in Secrets below and reference it here as <code className="font-mono">{"{{secrets.name}}"}</code>.
              </p>
            </div>

            {canMutate && isMutating ? (
              <div className="grid gap-1.5 rounded-xl bg-surface-2 p-3">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="tool-dedupes" className="leading-snug">
                    This endpoint de-duplicates replays
                  </Label>
                  <Switch id="tool-dedupes" checked={dedupes} onCheckedChange={setDedupes} />
                </div>
                {dedupes ? (
                  <Input
                    value={idempotencyHeader}
                    onChange={(event) => setIdempotencyHeader(event.target.value)}
                    placeholder={DEFAULT_IDEMPOTENCY_HEADER}
                    className="mt-1 font-mono"
                    aria-label="Idempotency header name"
                  />
                ) : null}
                <p className="text-xs text-muted-foreground">
                  {dedupes
                    ? "A key derived from the run and the node is sent under this header, identical on every attempt, so a retried write lands once. Only turn this on if the endpoint really honours it — a key it ignores looks like a guarantee and is not one."
                    : "Off means a failed write is NOT retried when the outcome is unknown (a read timeout, a 5xx): the server may already have committed it. Retries still happen when the request provably never arrived."}
                </p>
              </div>
            ) : null}

            <div className="grid gap-1.5">
              <Label htmlFor="tool-timeout">Timeout (seconds)</Label>
              <Input
                id="tool-timeout"
                type="number"
                step="1"
                min={1}
                value={timeoutSeconds}
                onChange={(event) => setTimeoutSeconds(Number(event.target.value) || 30)}
                className="w-28"
              />
            </div>
          </>
        ) : toolType === "notify" ? (
          <>
            <div className="grid gap-1.5">
              <Label>Channel</Label>
              <Select value={notifyChannel} onValueChange={setNotifyChannel}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{NOTIFY_CHANNELS.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{NOTIFY_CHANNELS.find((c) => c.value === notifyChannel)?.help}</p>
            </div>

            {notifyChannel === "webhook" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="notify-url">Webhook URL</Label>
                <Input
                  id="notify-url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://hooks.slack.com/services/…/{{secrets.slack_token}}"
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  An incoming-webhook URL is a bearer credential — put its token in Secrets below and reference it here, or it sits
                  in plaintext and is returned by the API.
                </p>
              </div>
            ) : null}

            <div className="grid gap-1.5">
              <Label htmlFor="notify-title">Default title</Label>
              <Input id="notify-title" value={notifyTitle} onChange={(event) => setNotifyTitle(event.target.value)} placeholder="Request processed" />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="notify-body">Default body</Label>
              <Textarea
                id="notify-body"
                rows={2}
                value={notifyBody}
                onChange={(event) => setNotifyBody(event.target.value)}
                placeholder="A workflow completed and this is its outcome."
              />
              <p className="text-xs text-muted-foreground">
                Defaults a node may override. The values a node wires up with <code className="font-mono">body_fields</code> ride
                alongside the body rather than being interpolated into it — there is no template syntax, deliberately.
              </p>
            </div>
          </>
        ) : toolType === "erp_connector" ? (
          <div className="grid gap-1.5">
            <Label>Action</Label>
            <Select value={action} onValueChange={setAction}>
              <SelectTrigger><SelectValue placeholder="Choose an action" /></SelectTrigger>
              <SelectContent>{ERP_ACTIONS.map((item) => <SelectItem key={item} value={item} className="font-mono">{item}</SelectItem>)}</SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              The payload (<code className="font-mono">vendor</code>, <code className="font-mono">amount</code>,{" "}
              <code className="font-mono">account_code</code>) is wired per node, not here.
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-1.5">
              <Label>Search in</Label>
              <Select value={knowledgeBaseId} onValueChange={setKnowledgeBaseId}>
                <SelectTrigger><SelectValue placeholder={knowledgeQuery.isLoading ? "Loading…" : "Choose a knowledge base"} /></SelectTrigger>
                <SelectContent>
                  {(knowledgeQuery.data ?? []).map((kb) => <SelectItem key={kb.id} value={kb.id}>{kb.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {knowledgeQuery.isSuccess && knowledgeQuery.data.length === 0
                  ? "No knowledge bases in this workspace yet — create one under Knowledge first."
                  : "The corpus is registry-owned, like a URL. A node can change the question asked, never the corpus searched."}
              </p>
            </div>

            <div className="grid gap-1.5">
              {/* Required by `_knowledge_search_config`, which refuses a config
                  with neither `query` nor `query_fields` — a retrieval tool that
                  cannot state its question is not executable. Nodes override it. */}
              <Label htmlFor="tool-query">Default question</Label>
              <Input
                id="tool-query"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="What approval is required for this invoice?"
              />
              <p className="text-xs text-muted-foreground">Used when a node maps nothing from state. Nodes may override it per usage.</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="tool-top-k">Passages to retrieve</Label>
                <Input
                  id="tool-top-k"
                  type="number"
                  min={1}
                  max={20}
                  value={topK}
                  onChange={(event) => setTopK(Math.max(1, Math.min(20, Number(event.target.value) || 5)))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="tool-score-floor">Minimum score</Label>
                <Input
                  id="tool-score-floor"
                  type="number"
                  min={0}
                  max={1}
                  step="0.05"
                  value={scoreFloor}
                  onChange={(event) => setScoreFloor(Math.max(0, Math.min(1, Number(event.target.value) || 0)))}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Both are registry-owned too: a node quietly widening the floor to 0 turns curated retrieval into a noise
              generator that still looks approved. Tune them against the retrieval playground.
            </p>
          </>
        )}

        {toolType !== "knowledge_search" ? (
          <div className="grid gap-1.5">
            <Label>Secrets</Label>
            {tool && tool.secret_keys.length > 0 && !secretsTouched ? (
              <p className="text-xs text-muted-foreground">
                Stored:{" "}
                {tool.secret_keys.map((key) => (
                  <code key={key} className="mr-1.5 font-mono">{`{{secrets.${key}}}`}</code>
                ))}
                <br />
                Values cannot be read back. Adding a row below replaces the whole set, so re-enter every secret you still need.
              </p>
            ) : null}
            <KeyValueEditor
              value={secrets}
              onChange={(next) => {
                setSecrets(next);
                setSecretsTouched(true);
              }}
              keyPlaceholder="erp_token"
              valuePlaceholder="the credential itself"
              addLabel="Add secret"
            />
            <p className="text-xs text-muted-foreground">
              Encrypted at rest with AES-256-GCM and never returned by any endpoint — only the names come back. Reference one from the
              config above as <code className="font-mono">{"{{secrets.name}}"}</code>; it is substituted in the worker at run start and
              reaches neither the node, nor a response, nor the audit trail.
            </p>
          </div>
        ) : null}

        {canMutate ? (
          <div className="flex items-start justify-between gap-3 rounded-xl border border-border p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Writes to an external system</p>
              <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                Any workflow using this tool is blocked from publishing unless a Human Approval node sits somewhere upstream.
                A node can raise this flag for its own use, but never lower it.
              </p>
            </div>
            <Switch aria-label="Writes to an external system" checked={isMutating} onCheckedChange={setIsMutating} />
          </div>
        ) : (
          <p className="rounded-xl border border-border p-3 text-xs leading-snug text-muted-foreground">
            Retrieval only reads, so this tool never forces an approval gate upstream. Each query does spend an embedding
            call, which the run reports as node cost.
          </p>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button disabled={!nameValid || !configComplete || (!editing && !workspaceId) || mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          {editing ? "Save" : "Create"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function ToolDialog({ tool, open, onOpenChange }: { tool: Tool | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Keyed remount so the form's initial state is re-derived from the tool
          being edited — the field editors hold local drafts. */}
      {/* Scrollable body: the retrieval variant is the tallest of the three and
          overflows a 776px-high window, which put the Create button off-screen
          with no way to reach it. Observed in a browser at that height. */}
      <DialogContent className="max-h-[85vh] overflow-y-auto">{open ? <ToolDialogForm key={tool?.id ?? "new-tool"} tool={tool} onOpenChange={onOpenChange} /> : null}</DialogContent>
    </Dialog>
  );
}
