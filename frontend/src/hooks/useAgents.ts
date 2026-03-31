import { useState, useEffect, useCallback } from 'react';
import { getAgents, Agent } from '../api/client';

export function useAgents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await getAgents();
      setAgents(data);
    } catch (err) {
      console.error('Failed to fetch agents:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const updateUnreadCounts = useCallback((counts: Record<string, number>) => {
    setAgents(prev => prev.map(a => ({
      ...a,
      unread_count: counts[a.id] ?? 0,
    })));
  }, []);

  const updateLastMessage = useCallback((agentId: string, content: string) => {
    setAgents(prev => prev.map(a =>
      a.id === agentId ? { ...a, last_message: content } as any : a
    ));
  }, []);

  return { agents, loading, refresh, updateUnreadCounts, updateLastMessage };
}
