import { request } from './http';

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
