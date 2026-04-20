import { request, fetchText } from './http';
import type { Message } from './messages';
import type { AgentSecret } from './secrets';

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

// Wizard
export interface ProviderCapabilities { list_repos: boolean; read_repos: boolean; create_repos: boolean; create_webhooks: boolean }
export interface ValidateProviderResult { valid: boolean; username: string; capabilities: ProviderCapabilities; errors: string[] }
export interface RepoInfo { full_name: string; clone_url: string; ssh_url: string; description: string; private: boolean; default_branch: string }

export const validateProvider = (data: { provider: string; api_url?: string; token: string; insecure_ssl?: boolean }) =>
  request<ValidateProviderResult>('/api/projects/validate-provider', { method: 'POST', body: JSON.stringify(data) });
export const listProviderRepos = (data: { provider: string; api_url?: string; token: string; insecure_ssl?: boolean; page?: number; per_page?: number; search?: string }) =>
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

// Readiness
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
export const getProjectVaultFile = (projectId: string, filePath: string) =>
  fetchText(`/api/projects/${projectId}/vault/${filePath}`);
