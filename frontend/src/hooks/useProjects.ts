import { useState, useEffect, useCallback } from 'react';
import { getProjects, Project } from '../api/client';

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await getProjects();
      setProjects(data);
    } catch (err) {
      console.error('Failed to fetch projects:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const updateProjectUnreadCounts = useCallback((counts: Record<string, number>) => {
    setProjects(prev => prev.map(p => ({
      ...p,
      unread_count: counts[p.id] ?? 0,
    })));
  }, []);

  return { projects, loading, refresh, updateProjectUnreadCounts };
}
