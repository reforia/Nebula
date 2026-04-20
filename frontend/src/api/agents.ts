import { request, uploadRaw, fetchText } from './http';

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
  mention_context_messages: number | null;
  mention_context_chars: number | null;
  session_initialized: number;
  nas_paths: string;
  initialized: number;
  execution_mode: 'local' | 'remote';
  mcp_auto_reset: number;
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

export const cancelAgent = (agentId: string) =>
  request<{ ok: boolean }>(`/api/agents/${agentId}/cancel`, { method: 'POST' });
export const initializeAgent = (agentId: string) =>
  request<{ ok: boolean }>(`/api/agents/${agentId}/initialize`, { method: 'POST' });

export const generateRemoteToken = (agentId: string) =>
  request<{ token: string }>(`/api/agents/${agentId}/generate-remote-token`, { method: 'POST' });

// Vault
export interface VaultFile {
  name: string;
  size: number;
  modified: string;
}

export const getVaultFiles = (agentId: string) => request<VaultFile[]>(`/api/agents/${agentId}/vault`);

export const uploadVaultFile = (agentId: string, file: File) =>
  uploadRaw<VaultFile>(`/api/agents/${agentId}/vault`, file);

export const getAgentVaultFileContent = (agentId: string, filename: string) =>
  fetchText(`/api/agents/${agentId}/vault/${encodeURIComponent(filename)}`);

export const deleteVaultFile = (agentId: string, filename: string) =>
  request<{ ok: boolean }>(`/api/agents/${agentId}/vault/${encodeURIComponent(filename)}`, { method: 'DELETE' });
