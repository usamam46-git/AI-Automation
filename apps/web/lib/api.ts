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
  async archive(workflowId: string) {
    await apiClient.delete(`/workflows/${workflowId}`);
  },
};
