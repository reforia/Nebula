import { request } from './http';

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
  templateId?: string;
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

export const createAdmin = (email: string, password: string, name: string, orgName?: string) =>
  request<AuthResponse>('/api/setup/create-admin', {
    method: 'POST',
    body: JSON.stringify({ email, password, name, orgName }),
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
