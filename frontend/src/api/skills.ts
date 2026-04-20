import { request } from './http';

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

export const getOrgSkills = () => request<CustomSkill[]>('/api/skills');
export const createOrgSkill = (data: Partial<CustomSkill>) => request<CustomSkill>('/api/skills', { method: 'POST', body: JSON.stringify(data) });
export const updateOrgSkill = (id: string, data: Partial<CustomSkill>) => request<CustomSkill>(`/api/skills/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteOrgSkill = (id: string) => request<{ ok: boolean }>(`/api/skills/${id}`, { method: 'DELETE' });

export const getAgentSkills = (agentId: string) => request<CustomSkill[]>(`/api/agents/${agentId}/skills`);
export const createAgentSkill = (agentId: string, data: Partial<CustomSkill>) => request<CustomSkill>(`/api/agents/${agentId}/skills`, { method: 'POST', body: JSON.stringify(data) });
export const updateAgentSkill = (agentId: string, skillId: string, data: Partial<CustomSkill>) => request<CustomSkill>(`/api/agents/${agentId}/skills/${skillId}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteAgentSkill = (agentId: string, skillId: string) => request<{ ok: boolean }>(`/api/agents/${agentId}/skills/${skillId}`, { method: 'DELETE' });
