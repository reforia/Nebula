import { request } from './http';

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
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}
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
  authGuide: { command: string; dockerCommand?: string | null; description: string };
}
export interface RuntimesResponse {
  runtimes: RuntimeInfo[];
  default: string;
}
export const getRuntimes = () => request<RuntimesResponse>('/api/runtimes');
export const detectRuntimes = () => request<{ runtimes: Pick<RuntimeInfo, 'id' | 'name' | 'available' | 'binaryPath'>[] }>('/api/runtimes/detect', { method: 'POST' });
export const setDefaultRuntime = (runtime: string) => request<{ ok: boolean; default: string }>('/api/runtimes/default', { method: 'PUT', body: JSON.stringify({ runtime }) });

// Errors
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

// Global knowledge
export const getGlobalKnowledge = () => request<{ content: string }>('/api/global-knowledge');
export const updateGlobalKnowledge = (content: string) => request<{ ok: boolean }>('/api/global-knowledge', { method: 'PUT', body: JSON.stringify({ content }) });

// Models
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
