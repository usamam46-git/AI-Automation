import { apiClient } from "@/lib/api-client";

export type TokenResponse = {
  access_token: string;
  token_type: string;
};

export type LoginPayload = {
  email: string;
  password: string;
  organization_id?: string | null;
};

export type RegisterPayload = {
  full_name: string;
  email: string;
  password: string;
  /** Required UNLESS `invite_token` is supplied — the backend's model
   *  validator enforces exactly that, and 422s when neither is present. */
  organization_name?: string;
  /** Join an existing organization instead of creating one. The address must
   *  match the one the invitation was addressed to, or the API 403s. */
  invite_token?: string;
};

export type Workspace = {
  id: string;
  organization_id: string;
  name: string;
  icon: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

export type WorkspacePayload = {
  name: string;
  icon?: string | null;
};

export type TriggerType = "manual" | "schedule" | "webhook" | "email" | "event";
export type WorkflowStatus = "draft" | "published" | "archived";

export type Workflow = {
  id: string;
  organization_id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  trigger_type: TriggerType;
  trigger_config: Record<string, unknown> | null;
  current_version_id: string | null;
  /**
   * Human-facing label for the live version — 2 renders as `v2`. Null until the
   * workflow has been published. Prefer this over `current_version_id` in any UI a
   * person reads: the builder header, the run header and the publish toast all say
   * "v2", and the detail dialog used to be the one surface showing the raw UUID.
   */
  current_version_number: number | null;
  /** Next due fire time (schedule triggers only); null for every other type. */
  next_run_at: string | null;
  last_triggered_at: string | null;
  /**
   * Whether an inbound webhook signing secret exists. A bare bool by design —
   * unlike an API key's last_four, no prefix of an HMAC secret is safe to
   * expose, so there is nothing to mask and show. The plaintext is returned
   * exactly once, by rotateWebhookSecret below.
   */
  has_webhook_secret: boolean;
  created_at: string;
  updated_at: string;
};

export type WorkflowPayload = {
  name: string;
  description?: string | null;
  workspace_id: string;
  trigger_type: TriggerType;
  trigger_config?: Record<string, unknown> | null;
};

/**
 * The one-shot reveal from POST /workflows/{id}/webhook-secret. Not recoverable
 * afterwards — a lost secret must be rotated, not looked up.
 */
export type WebhookSecret = {
  workflow_id: string;
  secret: string;
  endpoint_path: string;
  signature_header: string;
  timestamp_header: string;
};

// --- Workflow graph (versions / nodes / edges) ---------------------------
// Mirrors apps/api/src/modules/workflows/schemas.py. There is no `trigger`
// node type — `Workflow.trigger_type` is a field on the shell, not a node.
export type NodeType = "agent" | "tool" | "condition" | "human_approval" | "subgraph" | "start" | "end";

// Exactly the operators in apps/api/src/graphs/condition_eval.py.
export type ConditionOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "contains";

export type EdgeCondition = {
  field: string;
  operator: ConditionOperator;
  value: unknown;
  branch?: string | null;
};

export type NodeInput = {
  node_key: string;
  node_type: NodeType;
  config: Record<string, unknown>;
  position_x: number;
  position_y: number;
};

export type EdgeInput = {
  source_node_key: string;
  target_node_key: string;
  condition: Record<string, unknown> | null;
};

export type WorkflowNode = {
  id: string;
  node_key: string;
  node_type: NodeType;
  config: Record<string, unknown> | null;
  position_x: number | null;
  position_y: number | null;
};

export type WorkflowEdge = {
  id: string;
  source_node_key: string;
  target_node_key: string;
  condition: Record<string, unknown> | null;
};

export type WorkflowVersion = {
  id: string;
  workflow_id: string;
  version_number: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  published_by: string | null;
  published_at: string | null;
  created_at: string;
};

export type WorkflowVersionSummary = {
  id: string;
  version_number: number;
  published_at: string | null;
  node_count: number;
  edge_count: number;
};

export type WorkflowVersionPayload = {
  nodes: NodeInput[];
  edges: EdgeInput[];
};

// --- Executions -----------------------------------------------------------
// Mirrors apps/api/src/modules/executions/schemas.py.

export type WorkflowRunStatus = "pending" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled" | "rejected";

export type NodeExecutionStatus = "succeeded" | "failed" | "skipped";

// Append-only: every retry writes a NEW row, so one node_key can appear
// several times with a rising `attempt`. There is no started_at/completed_at —
// only latency_ms and created_at. And no node_type: resolving a node's type
// (for its icon) means joining against the version's nodes by node_key.
export type NodeExecution = {
  id: string;
  node_key: string;
  status: NodeExecutionStatus;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  tokens_prompt: number | null;
  tokens_completion: number | null;
  cost_usd: number | null;
  latency_ms: number;
  attempt: number;
  created_at: string;
};

export type WorkflowRun = {
  id: string;
  workflow_version_id: string;
  organization_id: string;
  status: WorkflowRunStatus;
  trigger_payload: Record<string, unknown> | null;
  // Shape emitted by human_approval_handler: { type: "approval_request",
  // node_outputs: {...} }. There is no prompt/message string in it — the
  // approval UI renders node_outputs as the evidence. See apps/web/CLAUDE.md.
  interrupt_payload: Record<string, unknown> | null;
  current_node_key: string | null;
  started_at: string | null;
  completed_at: string | null;
  total_cost_usd: number | null;
  error: Record<string, unknown> | null;
  node_executions: NodeExecution[];
  created_at: string;
  // Denormalized from the run's version -> workflow, so the viewer header can
  // name the workflow and the timeline can fetch the version's nodes.
  workflow_id: string;
  workflow_name: string;
  version_number: number;
};

// Lighter list row — no node_executions, no payloads. See WorkflowRunSummary
// in the backend schemas for why the two shapes are separate.
export type WorkflowRunSummary = {
  id: string;
  workflow_id: string;
  workflow_name: string;
  workflow_version_id: string;
  version_number: number;
  status: WorkflowRunStatus;
  started_at: string | null;
  completed_at: string | null;
  total_cost_usd: number | null;
  created_at: string;
};

export type ResumeDecision = "approved" | "rejected";

export const authApi = {
  async login(payload: LoginPayload) {
    const { data } = await apiClient.post<TokenResponse>("/auth/login", payload);
    return data;
  },
  async register(payload: RegisterPayload) {
    const { data } = await apiClient.post<TokenResponse>("/auth/register", payload);
    return data;
  },
  async refresh() {
    const { data } = await apiClient.post<TokenResponse>("/auth/refresh");
    return data;
  },
  async logout() {
    await apiClient.post("/auth/logout");
  },
};

export const workspacesApi = {
  async list() {
    const { data } = await apiClient.get<Workspace[]>("/workspaces");
    return data;
  },
  async create(payload: WorkspacePayload) {
    const { data } = await apiClient.post<Workspace>("/workspaces", payload);
    return data;
  },
  async update(workspaceId: string, payload: WorkspacePayload) {
    const { data } = await apiClient.patch<Workspace>(`/workspaces/${workspaceId}`, payload);
    return data;
  },
  async archive(workspaceId: string) {
    await apiClient.delete(`/workspaces/${workspaceId}`);
  },
};

export const workflowsApi = {
  async list(params: { workspaceId?: string | null; status?: WorkflowStatus | "all" }) {
    const { data } = await apiClient.get<Workflow[]>("/workflows", {
      params: {
        workspace_id: params.workspaceId || undefined,
        status: params.status && params.status !== "all" ? params.status : undefined,
      },
    });
    return data;
  },
  async create(payload: WorkflowPayload) {
    const { data } = await apiClient.post<Workflow>("/workflows", payload);
    return data;
  },
  async update(workflowId: string, payload: Partial<Pick<WorkflowPayload, "name" | "description" | "trigger_type" | "trigger_config">>) {
    const { data } = await apiClient.patch<Workflow>(`/workflows/${workflowId}`, payload);
    return data;
  },
  /** Generates or ROTATES the signing secret. Rotation invalidates the old one immediately. */
  async rotateWebhookSecret(workflowId: string) {
    const { data } = await apiClient.post<WebhookSecret>(`/workflows/${workflowId}/webhook-secret`);
    return data;
  },
  async archive(workflowId: string) {
    await apiClient.delete(`/workflows/${workflowId}`);
  },
  async get(workflowId: string) {
    const { data } = await apiClient.get<Workflow>(`/workflows/${workflowId}`);
    return data;
  },
  async listVersions(workflowId: string) {
    const { data } = await apiClient.get<WorkflowVersionSummary[]>(`/workflows/${workflowId}/versions`);
    return data;
  },
  async getVersion(workflowId: string, versionId: string) {
    const { data } = await apiClient.get<WorkflowVersion>(`/workflows/${workflowId}/versions/${versionId}`);
    return data;
  },
  // Fully replaces the draft's node/edge rows — there is no delta/patch path.
  // Creates version N+1 when the latest version is already published.
  async saveVersion(workflowId: string, payload: WorkflowVersionPayload) {
    const { data } = await apiClient.post<WorkflowVersion>(`/workflows/${workflowId}/versions`, payload);
    return data;
  },
  async publishVersion(workflowId: string, versionId: string) {
    const { data } = await apiClient.post<WorkflowVersion>(`/workflows/${workflowId}/versions/${versionId}/publish`);
    return data;
  },
};

export const executionsApi = {
  // 422s when the workflow has no published version — see ExecutionService.trigger_run.
  async triggerRun(workflowId: string, payload: { trigger_payload?: Record<string, unknown> | null } = {}) {
    const { data } = await apiClient.post<WorkflowRun>(`/workflows/${workflowId}/run`, {
      trigger_payload: payload.trigger_payload ?? null,
    });
    return data;
  },
  // Bare array, cursor-paginated. `cursor` is the raw ISO created_at of the
  // previous page's last row — the same convention as the workflows list.
  async list(params: { workflowId?: string | null; status?: WorkflowRunStatus | "all"; cursor?: string | null; limit?: number } = {}) {
    const { data } = await apiClient.get<WorkflowRunSummary[]>("/executions", {
      params: {
        workflow_id: params.workflowId || undefined,
        status: params.status && params.status !== "all" ? params.status : undefined,
        cursor: params.cursor || undefined,
        limit: params.limit || undefined,
      },
    });
    return data;
  },
  async get(runId: string) {
    const { data } = await apiClient.get<WorkflowRun>(`/executions/${runId}`);
    return data;
  },
  // 409s when the run is no longer waiting_approval (e.g. another tab decided first).
  async resume(runId: string, payload: { decision: ResumeDecision; comment?: string | null }) {
    const { data } = await apiClient.post<WorkflowRun>(`/executions/${runId}/resume`, {
      decision: payload.decision,
      comment: payload.comment || null,
    });
    return data;
  },
};

// ---------------------------------------------------------------------------
// Integrations (BYOK) — Vol. 2 §13
// ---------------------------------------------------------------------------

export type IntegrationType = "openai_api_key";

// The API NEVER returns the key itself, even to the owning org — `last_four` is
// the only view of it that exists. Don't add a `key` field expecting the server
// to fill it in.
export interface IntegrationStatus {
  type: IntegrationType;
  last_four: string;
  created_at: string;
  updated_at: string;
}

export const integrationsApi = {
  // 404 means "no key stored", not "endpoint missing" — the caller treats it as
  // an empty state rather than an error.
  async get(type: IntegrationType = "openai_api_key") {
    const { data } = await apiClient.get<IntegrationStatus>(`/integrations/${type}`);
    return data;
  },
  // 422 when the key fails the structural `sk-` check. There is no live call to
  // OpenAI at set-time, so a well-formed but invalid key is accepted here and
  // only fails on the next run.
  async set(apiKey: string, type: IntegrationType = "openai_api_key") {
    const { data } = await apiClient.put<IntegrationStatus>(`/integrations/${type}`, { api_key: apiKey });
    return data;
  },
  async remove(type: IntegrationType = "openai_api_key") {
    await apiClient.delete(`/integrations/${type}`);
  },
};

// ---------------------------------------------------------------------------
// Analytics — the home dashboard's stat cards (Vol. 3 §5.1)
// ---------------------------------------------------------------------------

/**
 * Aggregates over the org's workflow_runs. Gated on `execution:read`, the same
 * permission the executions list uses — every figure here is a roll-up of rows
 * that endpoint already returns.
 *
 * The window fields are not decoration: the cards render their subtitles from
 * them, so the labels stay true if the backend constants change.
 */
export type DashboardStats = {
  /** pending + running. Deliberately excludes waiting_approval, which has its own card. */
  active_runs: number;
  needs_approval: number;
  cost_mtd_usd: number;
  /**
   * completed / (completed + failed) as a fraction in [0, 1], or **null** when
   * nothing has finished in the window. Null is not zero — render it as "—",
   * never as "0%".
   */
  success_rate: number | null;
  cost_period_start: string;
  success_rate_window_days: number;
  /** The denominator. Small samples make a headline percentage misleading. */
  success_rate_sample_size: number;
};

export const analyticsApi = {
  async dashboard() {
    const { data } = await apiClient.get<DashboardStats>("/analytics/dashboard");
    return data;
  },
};

// ---------------------------------------------------------------------------
// Tools registry — Vol. 2 §3.3/§7.2, Vol. 4 §4.1/§4.3
// ---------------------------------------------------------------------------

/**
 * Vol. 2 §7.2 names four tool types; only these two are implemented, and the
 * backend rejects `python_function`/`mcp` by name at **create**, not at run
 * time. Same list as the builder's inline form — keep the two in sync.
 */
export type ToolType = "http_request" | "erp_connector" | "knowledge_search";

/** OpenAI's function-name grammar, mirrored from `TOOL_NAME_PATTERN` in the API's schemas.py. */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export type Tool = {
  id: string;
  organization_id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  tool_type: ToolType;
  /**
   * The JSON Schema handed to a model as the function's parameters. There is no
   * editor for it yet — agent function-calling is deferred (see the deferral
   * note in apps/api/CLAUDE.md), so nothing reads this field. It round-trips
   * untouched on PATCH rather than being cleared.
   */
  input_schema: Record<string, unknown> | null;
  /** Type-specific settings: url/method/headers for http_request, action for erp_connector. */
  config: Record<string, unknown> | null;
  is_mutating: boolean;
  /** Soft-delete flag. The list endpoint already excludes inactive rows. */
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type ToolPayload = {
  workspace_id: string;
  name: string;
  tool_type: ToolType;
  description?: string | null;
  config?: Record<string, unknown> | null;
  is_mutating?: boolean;
};

/**
 * `tool_type` and `workspace_id` are absent on purpose — `ToolUpdate` sets
 * `extra="forbid"`, so sending either is a 422 rather than a silent no-op.
 * Changing the type would orphan the type-specific config; changing the
 * workspace would move the row's tenancy anchor.
 */
export type ToolUpdatePayload = Partial<Pick<ToolPayload, "name" | "description" | "config" | "is_mutating">>;

export const toolsApi = {
  // Bare array, cursor-paginated on `created_at` — the same convention as the
  // workflows and executions lists.
  async list(params: { workspaceId?: string | null; toolType?: ToolType | "all"; cursor?: string | null; limit?: number } = {}) {
    const { data } = await apiClient.get<Tool[]>("/tools", {
      params: {
        workspace_id: params.workspaceId || undefined,
        tool_type: params.toolType && params.toolType !== "all" ? params.toolType : undefined,
        cursor: params.cursor || undefined,
        limit: params.limit || undefined,
      },
    });
    return data;
  },
  // 422 when the config fails `validate_tool_config` — the registry is validated
  // by the same code that executes it, so a row that saves is a row that runs.
  async create(payload: ToolPayload) {
    const { data } = await apiClient.post<Tool>("/tools", payload);
    return data;
  },
  async get(toolId: string) {
    const { data } = await apiClient.get<Tool>(`/tools/${toolId}`);
    return data;
  },
  async update(toolId: string, payload: ToolUpdatePayload) {
    const { data } = await apiClient.patch<Tool>(`/tools/${toolId}`, payload);
    return data;
  },
  // Soft delete. **409 while a published version still references the tool** —
  // `tool_executions.tool_id` cascades, so a hard delete would erase the audit
  // trail. Draft references do not block.
  async remove(toolId: string) {
    await apiClient.delete(`/tools/${toolId}`);
  },
};

// ---------------------------------------------------------------------------
// Knowledge bases (days 8-9)
// ---------------------------------------------------------------------------

/**
 * Mirrors `SUPPORTED_EMBEDDING_MODELS` in the API's llm_client.py.
 *
 * Both are requested at 1536 dimensions, so they share one HNSW index and are
 * interchangeable in the schema — the only difference is price. `-small` is the
 * API's create-time default (6.5x cheaper) even though the COLUMN default is
 * `-large`; that mismatch is deliberate, not a bug to reconcile here.
 */
export const EMBEDDING_MODELS = ["text-embedding-3-small", "text-embedding-3-large"] as const;
export type EmbeddingModel = (typeof EMBEDDING_MODELS)[number];

/** uploaded -> processing -> indexed | failed. Written by the worker, never by the client. */
export type DocumentStatus = "uploaded" | "processing" | "indexed" | "failed";

export type KnowledgeBase = {
  id: string;
  organization_id: string;
  workspace_id: string;
  name: string;
  embedding_model: string;
  created_at: string;
  updated_at: string;
};

export type KnowledgeDocument = {
  id: string;
  organization_id: string;
  knowledge_base_id: string;
  file_name: string;
  mime_type: string;
  status: DocumentStatus;
  page_count: number | null;
  /** Null until the worker indexes it — the upload response does not carry one. */
  content_hash: string | null;
  /** Populated only on `failed`, and it is the whole reason the column exists. */
  error: string | null;
  created_at: string;
  updated_at: string;
};

/** Never carries `embedding`: 1536 floats per chunk is megabytes of unusable payload. */
export type DocumentChunk = {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  token_count: number;
};

export type RetrievalHit = {
  document_id: string;
  document_name: string;
  chunk_index: number;
  content: string;
  score: number;
};

export type ChunkSearchResult = {
  query: string;
  hits: RetrievalHit[];
  hit_count: number;
  embedding_model: string;
  tokens: number;
  cost_usd: number;
};

export type KnowledgeBasePayload = {
  workspace_id: string;
  name: string;
  embedding_model?: EmbeddingModel;
};

/**
 * `embedding_model` is absent on purpose — `KnowledgeBaseUpdate` sets
 * `extra="forbid"`, and changing the model would invalidate every stored chunk
 * while silently re-embedding the whole corpus. It is immutable in practice.
 */
export type KnowledgeBaseUpdatePayload = { name: string };

/** The upload result, plus whether the server deduplicated it (200 rather than 202). */
export type UploadResult = { document: KnowledgeDocument; deduplicated: boolean };

export const knowledgeApi = {
  async list(params: { workspaceId?: string | null; cursor?: string | null; limit?: number } = {}) {
    const { data } = await apiClient.get<KnowledgeBase[]>("/knowledge-bases", {
      params: {
        workspace_id: params.workspaceId || undefined,
        cursor: params.cursor || undefined,
        limit: params.limit || undefined,
      },
    });
    return data;
  },
  async create(payload: KnowledgeBasePayload) {
    const { data } = await apiClient.post<KnowledgeBase>("/knowledge-bases", payload);
    return data;
  },
  async get(kbId: string) {
    const { data } = await apiClient.get<KnowledgeBase>(`/knowledge-bases/${kbId}`);
    return data;
  },
  async update(kbId: string, payload: KnowledgeBaseUpdatePayload) {
    const { data } = await apiClient.patch<KnowledgeBase>(`/knowledge-bases/${kbId}`, payload);
    return data;
  },
  async remove(kbId: string) {
    await apiClient.delete(`/knowledge-bases/${kbId}`);
  },

  /**
   * Multipart upload.
   *
   * **The status code carries meaning the body does not**: 202 means the bytes
   * were stored and ingestion was enqueued; 200 means an identical file was
   * already indexed in this KB, so nothing was stored and nothing was embedded.
   * Surfacing that difference is the only way a user learns their re-upload
   * cost nothing, so it is returned rather than discarded.
   *
   * **`Content-Type` MUST be overridden here even though the browser is the one
   * that ends up setting it.** `apiClient` defaults every request to
   * `application/json`, and axios reads that default in `transformRequest`
   * *before* it looks at the body: seeing a JSON content type it runs the
   * FormData through `formDataToJSON()`, so the file serialises to `{}` and the
   * server receives `{"file":{}}` as JSON — a 422 "Field required", never a
   * malformed multipart. Naming `multipart/form-data` here only takes it off
   * that path; axios then strips the header again in `resolveConfig` so the
   * browser generates the real one with a boundary. Observed as a live 422, not
   * theorised.
   */
  async upload(kbId: string, file: File): Promise<UploadResult> {
    const body = new FormData();
    body.append("file", file);
    const response = await apiClient.post<KnowledgeDocument>(`/knowledge-bases/${kbId}/documents`, body, {
      headers: { "Content-Type": "multipart/form-data" },
    });
    return { document: response.data, deduplicated: response.status === 200 };
  },

  async listDocuments(kbId: string, params: { cursor?: string | null; limit?: number } = {}) {
    const { data } = await apiClient.get<KnowledgeDocument[]>(`/knowledge-bases/${kbId}/documents`, {
      params: { cursor: params.cursor || undefined, limit: params.limit || undefined },
    });
    return data;
  },
  async getDocument(kbId: string, documentId: string) {
    const { data } = await apiClient.get<KnowledgeDocument>(`/knowledge-bases/${kbId}/documents/${documentId}`);
    return data;
  },
  async removeDocument(kbId: string, documentId: string) {
    await apiClient.delete(`/knowledge-bases/${kbId}/documents/${documentId}`);
  },

  /** Offset-paginated, not cursor — chunks share a `created_at` and have a natural total order. */
  async listChunks(kbId: string, documentId: string, params: { offset?: number; limit?: number } = {}) {
    const { data } = await apiClient.get<DocumentChunk[]>(`/knowledge-bases/${kbId}/documents/${documentId}/chunks`, {
      params: { offset: params.offset ?? 0, limit: params.limit ?? 50 },
    });
    return data;
  },

  /**
   * POST despite being read-only: the query is free text, and a GET would write
   * every user question into access logs and proxy caches. Each call embeds the
   * query and is billable, which is why the response reports tokens and cost.
   */
  async search(kbId: string, payload: { query: string; top_k?: number; score_floor?: number }) {
    const { data } = await apiClient.post<ChunkSearchResult>(`/knowledge-bases/${kbId}/search`, payload);
    return data;
  },
};

// ---------------------------------------------------------------------------
// Audit log — Vol. 2 §3.5, §13 §700
// ---------------------------------------------------------------------------

/**
 * One append-only audit event.
 *
 * `metadata` is free-form JSONB whose shape depends entirely on `action` —
 * `lib/audit-log.ts` is the only place that reads into it, and it reads
 * defensively. Do not narrow this type per action: the backend vocabulary is
 * open by design (Vol. 2 §3.5), so a union here would be wrong the first time
 * someone adds an action.
 *
 * `actor_email` is joined, not stored — the column is a bare polymorphic
 * `actor_id`. It is null for `system` and `agent` rows by construction, and
 * also for a `user` row whose user has since been deleted.
 */
export type AuditLogEntry = {
  id: string;
  organization_id: string;
  actor_type: "user" | "agent" | "system";
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
};

export const auditApi = {
  /**
   * Bare array, cursor-paginated on the raw ISO `created_at` of the previous
   * page's last row — the same convention as the Workflows and Executions
   * lists. Gated on `audit:read`, which is Owner/Admin only, so a 403 here is
   * an expected state and not an error to retry.
   */
  async list(params: { action?: string | null; resourceType?: string | null; cursor?: string | null; limit?: number } = {}) {
    const { data } = await apiClient.get<AuditLogEntry[]>("/audit-logs", {
      params: {
        action: params.action || undefined,
        resource_type: params.resourceType || undefined,
        cursor: params.cursor || undefined,
        limit: params.limit || undefined,
      },
    });
    return data;
  },
};

// ---------------------------------------------------------------------------
// Organization members — Vol. 3 §10
// ---------------------------------------------------------------------------

export const ASSIGNABLE_ROLES = ["Admin", "Editor", "Approver", "Viewer"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];
export type MemberStatus = "invited" | "active" | "suspended";

/**
 * One row of the roster.
 *
 * `user_id` is **null while an invitation is pending** — the address may have no
 * account yet — and `email` then comes from `invited_email`. Never key a list on
 * `user_id`; use `id`, the membership id, which is what every mutation endpoint
 * takes.
 */
export type Member = {
  id: string;
  user_id: string | null;
  email: string;
  full_name: string | null;
  role_id: string;
  role_name: string;
  status: MemberStatus;
  created_at: string;
};

export type CurrentMember = {
  membership_id: string;
  user_id: string;
  email: string;
  role_name: string;
  /** The raw stored column — wildcards and all (`["*"]` for Owner). */
  permissions: string[];
  /**
   * The same grant with `*` / `*:read` resolved by the backend against the real
   * vocabulary, including the reads the wildcard deliberately does not reach.
   * **Gate on this.** The frontend does not reimplement the wildcard rules —
   * see the header of `lib/permissions.ts`.
   */
  effective_permissions: string[];
  status: MemberStatus;
};

/**
 * A system role. The endpoint returns ALL of them, Owner included, ordered by
 * power — the reference table needs the role that can do everything.
 * **Filter dropdowns on `assignable`,** never on the list being short.
 */
export type RoleOption = {
  id: string;
  name: string;
  permissions: string[];
  effective_permissions: string[];
  assignable: boolean;
};

/**
 * A freshly created invitation.
 *
 * `accept_url` is returned in the body because the platform sends no email —
 * `worker_notifications` has an empty task registry. The UI shows it to copy.
 */
export type InviteResult = { member: Member; accept_url: string; expires_in_days: number };

export type InvitePreview = { organization_name: string; email: string; role_name: string };
export type AcceptInviteResult = { organization_id: string; organization_name: string; role_name: string };

export const membersApi = {
  async list() {
    const { data } = await apiClient.get<Member[]>("/organizations/members");
    return data;
  },
  // No permission gate on the backend — it returns only what the caller already
  // is, which is exactly what the UI needs to decide what to hide.
  async me() {
    const { data } = await apiClient.get<CurrentMember>("/organizations/members/me");
    return data;
  },
  async roles() {
    const { data } = await apiClient.get<RoleOption[]>("/organizations/roles");
    return data;
  },
  // 409 when the address is already a member or already invited.
  async invite(payload: { email: string; role_name: AssignableRole }) {
    const { data } = await apiClient.post<InviteResult>("/organizations/members", payload);
    return data;
  },
  // 409 on the last active Owner, or on editing yourself.
  async changeRole(membershipId: string, roleName: AssignableRole) {
    const { data } = await apiClient.patch<Member>(`/organizations/members/${membershipId}/role`, { role_name: roleName });
    return data;
  },
  async changeStatus(membershipId: string, status: "active" | "suspended") {
    const { data } = await apiClient.patch<Member>(`/organizations/members/${membershipId}/status`, { status });
    return data;
  },
  async remove(membershipId: string) {
    await apiClient.delete(`/organizations/members/${membershipId}`);
  },
  // Unauthenticated: the invitee may have no account yet.
  async previewInvite(token: string) {
    const { data } = await apiClient.get<InvitePreview>(`/organizations/invitations/${encodeURIComponent(token)}`);
    return data;
  },
  async acceptInvite(token: string) {
    const { data } = await apiClient.post<AcceptInviteResult>(`/organizations/invitations/${encodeURIComponent(token)}/accept`);
    return data;
  },
};
