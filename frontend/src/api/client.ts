const BASE = '';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    credentials: 'same-origin',
  });

  if (res.status === 401) {
    // Try refreshing the token before redirecting
    const refreshRes = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      credentials: 'same-origin',
    });
    if (refreshRes.ok) {
      // Retry the original request
      const retryRes = await fetch(`${BASE}${url}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
        credentials: 'same-origin',
      });
      if (retryRes.ok) {
        return (await retryRes.json()) as T;
      }
    }
    window.location.href = '/login';
    throw new Error('Not authenticated');
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

// Setup & OAuth
export interface SetupStatus {
  needsSetup: boolean;
  setupIncomplete?: boolean;
  instanceId: string;
  authProvider: 'local' | 'enigma';
  platformUrl?: string;
}
export interface SetupCompleteData {
  settings?: Record<string, string>;
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const res = await fetch('/api/setup/status');
  return res.json();
}
export const completeSetup = (data: SetupCompleteData) =>
  request<{ ok: boolean }>('/api/setup/complete', {
    method: 'POST',
    body: JSON.stringify(data),
  });

export async function getLoginUrl(): Promise<{ url: string; platformUrl: string }> {
  const res = await fetch('/api/auth/login-url');
  if (!res.ok) throw new Error('Failed to get login URL');
  return res.json();
}

export const createAdmin = (email: string, password: string, name: string) =>
  request<AuthResponse>('/api/setup/create-admin', {
    method: 'POST',
    body: JSON.stringify({ email, password, name }),
  });

// Auth
export interface User {
  id: string;
  email: string;
  name: string;
  created_at?: string;
  updated_at?: string;
}

export interface Org {
  id: string;
  name: string;
  owner_id: string;
  created_at: string;
  updated_at?: string;
}

export interface AuthResponse {
  user: User;
  orgs: Org[];
  currentOrgId: string;
}

export interface License {
  plan: string | null;
  plan_name: string | null;
  max_agents: number | null;
  max_seats: number | null;
  expires_at: string | null;
}
export interface AuthMeResponse {
  user: User | null;
  orgs: Org[];
  currentOrgId: string | null;
  authProvider?: 'local' | 'enigma';
  platformUrl?: string;
  license?: License | null;
}

export const register = (email: string, password: string, name: string, orgName?: string) =>
  request<AuthResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, name, orgName }),
  });

export const login = (email: string, password: string) =>
  request<AuthResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

export const refreshToken = (orgId?: string) =>
  request<AuthResponse>('/api/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ orgId }),
  });

export const logout = () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
export const getAuthMe = () => request<AuthMeResponse>('/api/auth/me');

// Organizations
export const getOrgs = () => request<Org[]>('/api/orgs');
export const createOrg = (name: string) => request<Org>('/api/orgs', { method: 'POST', body: JSON.stringify({ name }) });
export const updateOrg = (id: string, name: string) => request<Org>(`/api/orgs/${id}`, { method: 'PUT', body: JSON.stringify({ name }) });
export const deleteOrg = (id: string) => request<{ ok: boolean }>(`/api/orgs/${id}`, { method: 'DELETE' });

// Users
export const updateProfile = (data: { name?: string; email?: string }) =>
  request<User>('/api/users/me', { method: 'PUT', body: JSON.stringify(data) });
export const changePassword = (currentPassword: string, newPassword: string) =>
  request<{ ok: boolean }>('/api/users/me/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) });

// Agents
export interface Agent {
  id: string;
  org_id: string;
  name: string;
  role: string;
  emoji: string;
  session_id: string;
  allowed_tools: string;
  model: string;
  backend: string;
  security_tier: string;
  enabled: number;
  notify_email: number;
  sort_order: number;
  timeout_ms: number | null;
  recovery_token_budget: number | null;
  session_initialized: number;
  nas_paths: string;
  initialized: number;
  execution_mode: 'local' | 'remote';
  has_remote_token?: boolean;
  remote_connected?: boolean | null;
  remote_last_seen?: string | null;
  unread_count?: number;
  claude_md?: string;
  created_at: string;
  updated_at: string;
}

export const getAgents = () => request<Agent[]>('/api/agents');
export const getAgent = (id: string) => request<Agent>(`/api/agents/${id}`);
export const createAgent = (data: Partial<Agent>) => request<Agent>('/api/agents', { method: 'POST', body: JSON.stringify(data) });
export const updateAgent = (id: string, data: Partial<Agent> & { claude_md?: string }) => request<Agent>(`/api/agents/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteAgent = (id: string) => request<{ ok: boolean }>(`/api/agents/${id}`, { method: 'DELETE' });
export const resetAgentSession = (id: string, conversationId?: string) =>
  request<{ ok: boolean }>(`/api/agents/${id}/reset-session`, {
    method: 'POST',
    body: JSON.stringify(conversationId ? { conversation_id: conversationId } : {}),
  });

// Vault
export interface VaultFile {
  name: string;
  size: number;
  modified: string;
}

export const getVaultFiles = (agentId: string) => request<VaultFile[]>(`/api/agents/${agentId}/vault`);

export async function uploadVaultFile(agentId: string, file: File): Promise<VaultFile> {
  const res = await fetch(`/api/agents/${agentId}/vault`, {
    method: 'POST',
    headers: { 'X-Filename': file.name },
    body: file,
    credentials: 'same-origin',
  });
  if (!res.ok) { const d = await res.json(); throw new Error(d.error || `HTTP ${res.status}`); }
  return res.json();
}

export const getAgentVaultFileContent = async (agentId: string, filename: string): Promise<string> => {
  const res = await fetch(`/api/agents/${agentId}/vault/${encodeURIComponent(filename)}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

export const deleteVaultFile = (agentId: string, filename: string) =>
  request<{ ok: boolean }>(`/api/agents/${agentId}/vault/${encodeURIComponent(filename)}`, { method: 'DELETE' });

export const generateRemoteToken = (agentId: string) =>
  request<{ token: string }>(`/api/agents/${agentId}/generate-remote-token`, { method: 'POST' });

// Conversations
export interface Conversation {
  id: string;
  agent_id: string;
  title: string;
  session_id: string;
  session_initialized: number;
  unread_count?: number;
  last_message?: string;
  last_message_at?: string;
  created_at: string;
  updated_at: string;
}

export const getConversations = (agentId: string) =>
  request<Conversation[]>(`/api/agents/${agentId}/conversations`);
export const createConversation = (agentId: string, title?: string) =>
  request<Conversation>(`/api/agents/${agentId}/conversations`, {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
export const updateConversation = (id: string, title: string) =>
  request<Conversation>(`/api/conversations/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ title }),
  });
export const deleteConversation = (id: string) =>
  request<{ ok: boolean }>(`/api/conversations/${id}`, { method: 'DELETE' });

// Messages
export interface Message {
  id: string;
  agent_id: string;
  conversation_id?: string;
  role: 'user' | 'assistant';
  content: string;
  message_type: 'chat' | 'task' | 'error' | 'system' | 'agent' | 'integration';
  task_name?: string;
  metadata?: string;
  reply_to_id?: string;
  reply_to?: { id: string; role: string; agent_id: string; content: string };
  is_read: number;
  created_at: string;
}

export interface SearchResult {
  id: string;
  snippet: string;
  role: 'user' | 'assistant';
  created_at: string;
  agent_id: string;
  agent_name: string;
  agent_emoji: string;
  conversation_id: string;
  conversation_title: string;
  project_id: string | null;
  project_name: string | null;
}
export const searchMessages = (q: string, limit?: number) => {
  const params = new URLSearchParams({ q });
  if (limit) params.set('limit', String(limit));
  return request<SearchResult[]>(`/api/agents/search/messages?${params}`);
};

export const getMessages = (agentId: string, limit?: number, before?: string, conversationId?: string) => {
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  if (before) params.set('before', before);
  if (conversationId) params.set('conversation_id', conversationId);
  return request<Message[]>(`/api/agents/${agentId}/messages?${params}`);
};
export const sendMessage = (agentId: string, content: string, conversationId?: string, imageIds?: string[], replyToId?: string) =>
  request<Message>(`/api/agents/${agentId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, conversation_id: conversationId, image_ids: imageIds, reply_to_id: replyToId }),
  });

export interface UploadedImage {
  id: string;
  filename: string;
  original_name: string;
}

export async function uploadImage(agentId: string, file: File): Promise<UploadedImage> {
  const res = await fetch(`/api/agents/${agentId}/uploads`, {
    method: 'POST',
    headers: { 'X-Filename': file.name },
    body: file,
    credentials: 'same-origin',
  });
  if (!res.ok) { const d = await res.json(); throw new Error(d.error || `HTTP ${res.status}`); }
  return res.json();
}
export const markRead = (agentId: string, conversationId?: string) => {
  const params = new URLSearchParams();
  if (conversationId) params.set('conversation_id', conversationId);
  return request<{ ok: boolean }>(`/api/agents/${agentId}/read?${params}`, { method: 'PUT' });
};

export const cancelAgent = (agentId: string) =>
  request<{ ok: boolean }>(`/api/agents/${agentId}/cancel`, { method: 'POST' });
export const initializeAgent = (agentId: string) =>
  request<{ ok: boolean }>(`/api/agents/${agentId}/initialize`, { method: 'POST' });

// Tasks
export interface Task {
  id: string;
  agent_id: string;
  project_id?: string;
  name: string;
  prompt: string;
  trigger_type: 'cron' | 'webhook';
  cron_expression: string;
  webhook_secret?: string;
  webhook_url?: string;
  enabled: number;
  max_turns: number;
  timeout_ms: number;
  last_run_at?: string;
  last_status?: string;
  created_at: string;
}

export interface CalendarTask extends Task {
  agent_name: string;
  agent_emoji: string;
  project_name?: string;
}

export const getTasks = (agentId: string) => request<Task[]>(`/api/agents/${agentId}/tasks`);
export const getProjectTasks = (projectId: string) => request<CalendarTask[]>(`/api/projects/${projectId}/tasks`);
export const getAllTasks = () => request<CalendarTask[]>('/api/tasks/all');
export const createTask = (agentId: string, data: Partial<Task>) => request<Task>(`/api/agents/${agentId}/tasks`, { method: 'POST', body: JSON.stringify(data) });
export const createProjectTask = (projectId: string, data: Partial<Task> & { agent_id?: string }) => request<Task>(`/api/projects/${projectId}/tasks`, { method: 'POST', body: JSON.stringify(data) });
export const updateTask = (id: string, data: Partial<Task>) => request<Task>(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteTask = (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}`, { method: 'DELETE' });
export const triggerTask = (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}/trigger`, { method: 'POST' });

// Custom Skills
export interface CustomSkill {
  id: string;
  org_id: string;
  agent_id: string | null;
  name: string;
  description: string;
  content: string;
  enabled: number;
  scope?: 'org' | 'agent';
  created_at: string;
  updated_at: string;
}

// Org-wide skills
export const getOrgSkills = () => request<CustomSkill[]>('/api/skills');
export const createOrgSkill = (data: Partial<CustomSkill>) => request<CustomSkill>('/api/skills', { method: 'POST', body: JSON.stringify(data) });
export const updateOrgSkill = (id: string, data: Partial<CustomSkill>) => request<CustomSkill>(`/api/skills/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteOrgSkill = (id: string) => request<{ ok: boolean }>(`/api/skills/${id}`, { method: 'DELETE' });

// Agent secrets
export interface AgentSecret {
  id: string;
  key: string;
  created_at: string;
  updated_at: string;
}
export const getAgentSecrets = (agentId: string) => request<AgentSecret[]>(`/api/agents/${agentId}/secrets`);
export const createAgentSecret = (agentId: string, key: string, value: string) =>
  request<{ ok: boolean; key: string }>(`/api/agents/${agentId}/secrets`, { method: 'POST', body: JSON.stringify({ key, value }) });
export const deleteAgentSecret = (agentId: string, secretId: string) =>
  request<{ ok: boolean }>(`/api/agents/${agentId}/secrets/${secretId}`, { method: 'DELETE' });

// Agent-specific skills (returns both agent + org-wide)
export const getAgentSkills = (agentId: string) => request<CustomSkill[]>(`/api/agents/${agentId}/skills`);
export const createAgentSkill = (agentId: string, data: Partial<CustomSkill>) => request<CustomSkill>(`/api/agents/${agentId}/skills`, { method: 'POST', body: JSON.stringify(data) });
export const updateAgentSkill = (agentId: string, skillId: string, data: Partial<CustomSkill>) => request<CustomSkill>(`/api/agents/${agentId}/skills/${skillId}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteAgentSkill = (agentId: string, skillId: string) => request<{ ok: boolean }>(`/api/agents/${agentId}/skills/${skillId}`, { method: 'DELETE' });

// System
export const getSettings = () => request<Record<string, string>>('/api/settings');
export const updateSettings = (data: Record<string, string>) => request<{ ok: boolean }>('/api/settings', { method: 'PUT', body: JSON.stringify(data) });
export interface OrgStatus {
  ok: boolean;
  agents: number;
  active_tasks: number;
  total_messages: number;
  uptime: number;
  usage: {
    total: { executions: number; tokens_in: number; tokens_out: number; cost: number; errors: number };
    last_30d: { executions: number; tokens_in: number; tokens_out: number; cost: number };
    top_models: Array<{ model: string; executions: number; cost: number }>;
    top_agents: Array<{ agent_id: string; agent_name: string; agent_emoji: string; executions: number; cost: number }>;
  };
}
export const getStatus = () => request<OrgStatus>('/api/status');

// Cleanup
export interface CleanupStatus {
  enabled: boolean;
  cron: string;
  sessions: boolean;
  worktrees: boolean;
  dreaming: boolean;
  nextRun: string | null;
  lastResult: {
    timestamp: string;
    sessions: { deleted: number; scanned: number } | null;
    worktrees: { deleted: number; removed: string[] } | null;
    dreaming: { triggered: number } | null;
  } | null;
}
export const getCleanupStatus = () => request<CleanupStatus>('/api/cleanup/status');
export const runCleanup = () => request<{ timestamp: string; sessions?: any; worktrees?: any; disabled?: boolean }>('/api/cleanup/run', { method: 'POST' });

// Runtimes
export interface RuntimeInfo {
  id: string;
  name: string;
  binaryName: string;
  available: boolean;
  binaryPath: string | null;
  version: string | null;
  skillInjection: 'disk' | 'systemprompt';
  hasBuiltinWebTools: boolean;
  requiresApiKey: boolean;
  supportedModelPrefixes: string[];
  models: ModelInfo[];
  auth: { ok: boolean; error?: string };
  install: { command: string; url: string };
  authGuide: { command: string; description: string };
}
export interface RuntimesResponse {
  runtimes: RuntimeInfo[];
  default: string;
}
export const getRuntimes = () => request<RuntimesResponse>('/api/runtimes');
export const detectRuntimes = () => request<{ runtimes: Pick<RuntimeInfo, 'id' | 'name' | 'available' | 'binaryPath'>[] }>('/api/runtimes/detect', { method: 'POST' });
export const setDefaultRuntime = (runtime: string) => request<{ ok: boolean; default: string }>('/api/runtimes/default', { method: 'PUT', body: JSON.stringify({ runtime }) });
export interface ExecutionError {
  id: string;
  agent_id: string;
  conversation_id: string;
  backend: string;
  model: string;
  error_message: string | null;
  created_at: string;
  agent_name: string;
  agent_emoji: string;
}
export const getErrors = (limit?: number) => request<ExecutionError[]>(`/api/errors${limit ? `?limit=${limit}` : ''}`);
export const dismissError = (id: string) => request<{ ok: boolean }>(`/api/errors/${id}`, { method: 'DELETE' });
export const dismissAllErrors = () => request<{ ok: boolean }>('/api/errors', { method: 'DELETE' });
export const getGlobalKnowledge = () => request<{ content: string }>('/api/global-knowledge');
export const updateGlobalKnowledge = (content: string) => request<{ ok: boolean }>('/api/global-knowledge', { method: 'PUT', body: JSON.stringify({ content }) });

// Secrets Vault
export interface OrgSecret {
  id: string;
  key: string;
  created_at: string;
  updated_at: string;
}
export const getSecrets = () => request<OrgSecret[]>('/api/secrets');
export const createSecret = (key: string, value: string) => request<{ ok: boolean; key: string }>('/api/secrets', { method: 'POST', body: JSON.stringify({ key, value }) });
export const deleteSecret = (id: string) => request<{ ok: boolean }>(`/api/secrets/${id}`, { method: 'DELETE' });

// Projects
export interface Project {
  id: string;
  org_id: string;
  name: string;
  description: string;
  git_remote_url: string;
  git_api_url?: string;
  git_provider: 'gitea' | 'github' | 'gitlab';
  coordinator_agent_id: string | null;
  auto_merge: number;
  status: 'not_ready' | 'active' | 'paused' | 'complete' | 'archived';
  launched_at?: string;
  git_token_key?: string;
  readiness?: ReadinessResult;
  coordinator_name?: string;
  coordinator_emoji?: string;
  milestone_count?: number;
  milestones_done?: number;
  deliverable_count?: number;
  deliverables_done?: number;
  agent_count?: number;
  unread_count?: number;
  agents?: ProjectAgent[];
  created_at: string;
  updated_at: string;
}

export interface ProjectMilestone {
  id: string;
  project_id: string;
  name: string;
  description: string;
  sort_order: number;
  status: 'pending' | 'in_progress' | 'done';
  deliverables?: ProjectDeliverable[];
  created_at: string;
  updated_at: string;
}

export interface ProjectDeliverable {
  id: string;
  milestone_id: string;
  name: string;
  pass_criteria: string;
  branch_name: string | null;
  assigned_agent_id: string | null;
  status: 'pending' | 'in_progress' | 'done' | 'blocked';
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectAgent {
  project_id: string;
  agent_id: string;
  role: 'coordinator' | 'contributor';
  max_concurrent: number;
  agent_name?: string;
  agent_emoji?: string;
  agent_role?: string;
  agent_enabled?: number;
  assigned_deliverables?: number;
  completed_deliverables?: number;
}

export interface ProjectLink {
  id: string;
  project_id: string;
  type: 'issue_tracker' | 'knowledge_base' | 'ci';
  provider: string;
  url: string;
  config: string;
  created_at: string;
}

export interface ProjectDashboard {
  project: { id: string; name: string; status: string; auto_merge: number };
  progress: { total_deliverables: number; done_deliverables: number; percent: number };
  milestones: Array<{
    id: string; name: string; status: string;
    deliverables: { total: number; done: number; in_progress: number; blocked: number; pending: number };
    progress: number;
  }>;
  agents: ProjectAgent[];
  agent_activity: Array<{
    agent_id: string; agent_name: string; agent_emoji: string;
    message_count: number; last_active: string;
  }>;
}

export const getProjects = () => request<Project[]>('/api/projects');
export const getProject = (id: string) => request<Project>(`/api/projects/${id}`);
export const createProject = (data: Record<string, any>) => request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(data) });
export const updateProject = (id: string, data: Partial<Project>) => request<Project>(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteProject = (id: string) => request<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' });
export const getProjectDashboard = (id: string) => request<ProjectDashboard>(`/api/projects/${id}/dashboard`);

// Wizard endpoints
export interface ProviderCapabilities { list_repos: boolean; read_repos: boolean; create_repos: boolean; create_webhooks: boolean }
export interface ValidateProviderResult { valid: boolean; username: string; capabilities: ProviderCapabilities; errors: string[] }
export interface RepoInfo { full_name: string; clone_url: string; ssh_url: string; description: string; private: boolean; default_branch: string }

export const validateProvider = (data: { provider: string; api_url?: string; token: string }) =>
  request<ValidateProviderResult>('/api/projects/validate-provider', { method: 'POST', body: JSON.stringify(data) });
export const listProviderRepos = (data: { provider: string; api_url?: string; token: string; page?: number; per_page?: number; search?: string }) =>
  request<{ repos: RepoInfo[]; total: number }>('/api/projects/list-repos', { method: 'POST', body: JSON.stringify(data) });
export const launchProject = (projectId: string) =>
  request<{ ok: boolean; project: Project }>(`/api/projects/${projectId}/launch`, { method: 'POST' });
export const updateVaultFile = (projectId: string, filePath: string, content: string) =>
  request<{ ok: boolean }>(`/api/projects/${projectId}/vault/${filePath}`, { method: 'PUT', body: JSON.stringify({ content }) });

// Milestones
export const getProjectMilestones = (projectId: string) => request<ProjectMilestone[]>(`/api/projects/${projectId}/milestones`);
export const createMilestone = (projectId: string, data: Partial<ProjectMilestone>) => request<ProjectMilestone>(`/api/projects/${projectId}/milestones`, { method: 'POST', body: JSON.stringify(data) });
export const updateMilestone = (id: string, data: Partial<ProjectMilestone>) => request<ProjectMilestone>(`/api/projects/milestones/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteMilestone = (id: string) => request<{ ok: boolean }>(`/api/projects/milestones/${id}`, { method: 'DELETE' });

// Deliverables
export const createDeliverable = (milestoneId: string, data: Partial<ProjectDeliverable>) => request<ProjectDeliverable>(`/api/projects/milestones/${milestoneId}/deliverables`, { method: 'POST', body: JSON.stringify(data) });
export const updateDeliverable = (id: string, data: Partial<ProjectDeliverable>) => request<ProjectDeliverable>(`/api/projects/deliverables/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteDeliverable = (id: string) => request<{ ok: boolean }>(`/api/projects/deliverables/${id}`, { method: 'DELETE' });

// Project agents
export const getProjectAgents = (projectId: string) => request<ProjectAgent[]>(`/api/projects/${projectId}/agents`);
export const assignProjectAgent = (projectId: string, data: { agent_id: string; role?: string; max_concurrent?: number }) => request<ProjectAgent>(`/api/projects/${projectId}/agents`, { method: 'POST', body: JSON.stringify(data) });
export const updateProjectAgent = (projectId: string, agentId: string, data: Partial<ProjectAgent>) => request<ProjectAgent>(`/api/projects/${projectId}/agents/${agentId}`, { method: 'PUT', body: JSON.stringify(data) });
export const removeProjectAgent = (projectId: string, agentId: string) => request<{ ok: boolean }>(`/api/projects/${projectId}/agents/${agentId}`, { method: 'DELETE' });

// Project links
export const getProjectLinks = (projectId: string) => request<ProjectLink[]>(`/api/projects/${projectId}/links`);
export const addProjectLink = (projectId: string, data: Partial<ProjectLink>) => request<ProjectLink>(`/api/projects/${projectId}/links`, { method: 'POST', body: JSON.stringify(data) });
export const updateProjectLink = (projectId: string, linkId: string, data: Partial<ProjectLink>) => request<ProjectLink>(`/api/projects/${projectId}/links/${linkId}`, { method: 'PUT', body: JSON.stringify(data) });
export const removeProjectLink = (projectId: string, linkId: string) => request<{ ok: boolean }>(`/api/projects/${projectId}/links/${linkId}`, { method: 'DELETE' });

// Project messages
export const getProjectMessages = (projectId: string, limit?: number, before?: string) => {
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  if (before) params.set('before', before);
  return request<Message[]>(`/api/projects/${projectId}/messages?${params}`);
};
export const sendProjectMessage = (projectId: string, content: string, agentId?: string, replyToId?: string) =>
  request<Message>(`/api/projects/${projectId}/messages`, { method: 'POST', body: JSON.stringify({ content, agent_id: agentId, reply_to_id: replyToId }) });

export const markProjectMessagesRead = (projectId: string) =>
  request<{ ok: boolean }>(`/api/projects/${projectId}/messages/read`, { method: 'POST' });

// Project secrets
export const getProjectSecrets = (projectId: string) => request<AgentSecret[]>(`/api/projects/${projectId}/secrets`);
export const createProjectSecret = (projectId: string, key: string, value: string) =>
  request<{ ok: boolean; key: string }>(`/api/projects/${projectId}/secrets`, { method: 'POST', body: JSON.stringify({ key, value }) });
export const deleteProjectSecret = (projectId: string, secretId: string) =>
  request<{ ok: boolean }>(`/api/projects/${projectId}/secrets/${secretId}`, { method: 'DELETE' });

// Project readiness
export interface ReadinessCheck { key: string; label: string; met: boolean }
export interface ChecklistItem { id: string; label: string; met: number; created_at: string }
export interface ReadinessResult { systemChecks: ReadinessCheck[]; agentChecks: ChecklistItem[]; ready: boolean }
export const getProjectReadiness = (projectId: string) => request<ReadinessResult>(`/api/projects/${projectId}/readiness`);
export const getProjectChecklist = (projectId: string) => request<ChecklistItem[]>(`/api/projects/${projectId}/checklist`);
export const createChecklistItem = (projectId: string, label: string) =>
  request<ChecklistItem>(`/api/projects/${projectId}/checklist`, { method: 'POST', body: JSON.stringify({ label }) });
export const updateChecklistItem = (projectId: string, itemId: string, met: boolean) =>
  request<{ ok: boolean }>(`/api/projects/${projectId}/checklist/${itemId}`, { method: 'PUT', body: JSON.stringify({ met }) });
export const deleteChecklistItem = (projectId: string, itemId: string) =>
  request<{ ok: boolean }>(`/api/projects/${projectId}/checklist/${itemId}`, { method: 'DELETE' });
export const testProjectWebhook = (projectId: string) =>
  request<{ ok: boolean; message: string }>(`/api/projects/${projectId}/webhook-test`, { method: 'POST' });

// Project vault (read-only from git)
export const getProjectVault = (projectId: string) => request<string[]>(`/api/projects/${projectId}/vault`);
export const getProjectVaultFile = async (projectId: string, filePath: string): Promise<string> => {
  const res = await fetch(`/api/projects/${projectId}/vault/${filePath}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

// MCP Servers
export interface McpServer {
  id: string;
  org_id: string;
  agent_id: string | null;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  config: string;
  enabled: number;
  scope?: 'org' | 'agent';
  created_at: string;
  updated_at: string;
}

// Org-wide MCP servers
export const getOrgMcpServers = () => request<McpServer[]>('/api/mcp-servers');
export const createOrgMcpServer = (data: Partial<McpServer>) =>
  request<McpServer>('/api/mcp-servers', { method: 'POST', body: JSON.stringify(data) });
export const updateOrgMcpServer = (id: string, data: Partial<McpServer>) =>
  request<McpServer>(`/api/mcp-servers/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteOrgMcpServer = (id: string) =>
  request<{ ok: boolean }>(`/api/mcp-servers/${id}`, { method: 'DELETE' });

// Agent-specific MCP servers
export const getAgentMcpServers = (agentId: string) =>
  request<McpServer[]>(`/api/agents/${agentId}/mcp-servers`);
export const createAgentMcpServer = (agentId: string, data: Partial<McpServer>) =>
  request<McpServer>(`/api/agents/${agentId}/mcp-servers`, { method: 'POST', body: JSON.stringify(data) });
export const updateAgentMcpServer = (agentId: string, serverId: string, data: Partial<McpServer>) =>
  request<McpServer>(`/api/agents/${agentId}/mcp-servers/${serverId}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteAgentMcpServer = (agentId: string, serverId: string) =>
  request<{ ok: boolean }>(`/api/agents/${agentId}/mcp-servers/${serverId}`, { method: 'DELETE' });

// Memories
export interface Memory {
  id: string;
  owner_type: 'agent' | 'project';
  owner_id: string;
  title: string;
  description: string;
  content: string;
  created_at: string;
  updated_at: string;
}
export interface MemoryMeta {
  id: string;
  title: string;
  description: string;
  created_at: string;
  updated_at: string;
}
export interface MemorySearchResult {
  id: string;
  title: string;
  description: string;
  snippet: string;
  score: number;
  source: 'agent' | 'project';
}
export const getAgentMemories = (agentId: string) => request<MemoryMeta[]>(`/api/agents/${agentId}/memory`);
export const getAgentMemory = (agentId: string, memoryId: string) => request<Memory>(`/api/agents/${agentId}/memory/${memoryId}`);
export const createAgentMemory = (agentId: string, data: { title: string; description: string; content: string }) =>
  request<Memory>(`/api/agents/${agentId}/memory`, { method: 'POST', body: JSON.stringify(data) });
export const updateAgentMemory = (agentId: string, memoryId: string, data: { title?: string; description?: string; content?: string }) =>
  request<Memory>(`/api/agents/${agentId}/memory/${memoryId}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteAgentMemory = (agentId: string, memoryId: string) =>
  request<{ ok: boolean }>(`/api/agents/${agentId}/memory/${memoryId}`, { method: 'DELETE' });
export const searchMemories = (query: string, agentId: string, projectId?: string) =>
  request<MemorySearchResult[]>('/api/memory/search', { method: 'POST', body: JSON.stringify({ query, agent_id: agentId, project_id: projectId }) });

// Models
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}
export const getModels = () => request<ModelInfo[]>('/api/models');

// Feedback
export interface FeedbackData {
  type: 'feedback' | 'bug' | 'feature' | 'support';
  subject?: string;
  message: string;
  metadata?: Record<string, string>;
}
export const submitFeedback = (data: FeedbackData) =>
  request<{ ok: boolean }>('/api/feedback', { method: 'POST', body: JSON.stringify(data) });

// Templates
export interface OrgTemplate {
  version?: number;
  name: string;
  description?: string;
  agents: Array<{
    name: string;
    role: string;
    model: string;
    backend: string;
    allowed_tools: string;
    timeout_ms: number | null;
    execution_mode?: string;
    tasks: Array<{ name: string; cron: string | null; prompt: string; enabled: boolean }>;
    skills: Array<{ name: string; description: string; content: string; enabled: boolean }>;
    mcp_servers?: Array<{ name: string; transport: string; config: Record<string, any>; enabled: boolean }>;
  }>;
  skills: Array<{ name: string; description: string; content: string; enabled: boolean }>;
  mcp_servers?: Array<{ name: string; transport: string; config: Record<string, any>; enabled: boolean }>;
}
export interface ImportResult { ok: boolean; created: { agents: number; skills: number; tasks: number; mcp_servers: number } }
export interface TemplateSummary { id: string; name: string; description: string; icon: string; agents: number; skills: number; tasks: number }
export const listTemplates = () => request<TemplateSummary[]>('/api/templates');
export const getTemplate = (id: string) => request<OrgTemplate>(`/api/templates/${id}`);
export const exportTemplate = () => request<OrgTemplate>('/api/templates/export');
export const importTemplate = (template: OrgTemplate) =>
  request<ImportResult>('/api/templates/import', { method: 'POST', body: JSON.stringify(template) });

// Secret references
export interface SecretRef {
  key: string;
  sources: Array<{ name: string; type: 'skill' | 'mcp'; scope: 'org' | 'agent'; id: string }>;
  configured: boolean;
}
export const getSecretRefs = (scope?: 'org' | 'agent', agentId?: string) => {
  const params = new URLSearchParams();
  if (scope) params.set('scope', scope);
  if (agentId) params.set('agent_id', agentId);
  return request<{ refs: SecretRef[] }>(`/api/secret-refs?${params}`);
};
