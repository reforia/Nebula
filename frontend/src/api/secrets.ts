import { request } from './http';

export interface OrgSecret {
  id: string;
  key: string;
  created_at: string;
  updated_at: string;
}
export interface AgentSecret {
  id: string;
  key: string;
  created_at: string;
  updated_at: string;
}

export const getSecrets = () => request<OrgSecret[]>('/api/secrets');
export const createSecret = (key: string, value: string) => request<{ ok: boolean; key: string }>('/api/secrets', { method: 'POST', body: JSON.stringify({ key, value }) });
export const deleteSecret = (id: string) => request<{ ok: boolean }>(`/api/secrets/${id}`, { method: 'DELETE' });

export const getAgentSecrets = (agentId: string) => request<AgentSecret[]>(`/api/agents/${agentId}/secrets`);
export const createAgentSecret = (agentId: string, key: string, value: string) =>
  request<{ ok: boolean; key: string }>(`/api/agents/${agentId}/secrets`, { method: 'POST', body: JSON.stringify({ key, value }) });
export const deleteAgentSecret = (agentId: string, secretId: string) =>
  request<{ ok: boolean }>(`/api/agents/${agentId}/secrets/${secretId}`, { method: 'DELETE' });

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
