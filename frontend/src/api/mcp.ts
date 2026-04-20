import { request } from './http';

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

export const getOrgMcpServers = () => request<McpServer[]>('/api/mcp-servers');
export const createOrgMcpServer = (data: Partial<McpServer>) =>
  request<McpServer>('/api/mcp-servers', { method: 'POST', body: JSON.stringify(data) });
export const updateOrgMcpServer = (id: string, data: Partial<McpServer>) =>
  request<McpServer>(`/api/mcp-servers/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteOrgMcpServer = (id: string) =>
  request<{ ok: boolean }>(`/api/mcp-servers/${id}`, { method: 'DELETE' });

export const getAgentMcpServers = (agentId: string) =>
  request<McpServer[]>(`/api/agents/${agentId}/mcp-servers`);
export const createAgentMcpServer = (agentId: string, data: Partial<McpServer>) =>
  request<McpServer>(`/api/agents/${agentId}/mcp-servers`, { method: 'POST', body: JSON.stringify(data) });
export const updateAgentMcpServer = (agentId: string, serverId: string, data: Partial<McpServer>) =>
  request<McpServer>(`/api/agents/${agentId}/mcp-servers/${serverId}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteAgentMcpServer = (agentId: string, serverId: string) =>
  request<{ ok: boolean }>(`/api/agents/${agentId}/mcp-servers/${serverId}`, { method: 'DELETE' });
