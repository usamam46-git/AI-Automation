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
  organization_name: string;
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
export type ToolType = "http_request" | "erp_connector";

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
