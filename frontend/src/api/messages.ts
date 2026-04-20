import { request, uploadRaw } from './http';

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

export const uploadImage = (agentId: string, file: File) =>
  uploadRaw<UploadedImage>(`/api/agents/${agentId}/uploads`, file);

export const markRead = (agentId: string, conversationId?: string) => {
  const params = new URLSearchParams();
  if (conversationId) params.set('conversation_id', conversationId);
  return request<{ ok: boolean }>(`/api/agents/${agentId}/read?${params}`, { method: 'PUT' });
};
