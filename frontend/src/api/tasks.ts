import { request } from './http';

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
  timeout_ms: number | null;
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
