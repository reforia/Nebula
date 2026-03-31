import { useState, useEffect, useCallback } from 'react';
import { getModels, ModelInfo } from '../api/client';

let cachedModels: ModelInfo[] | null = null;
let listeners: (() => void)[] = [];

export function invalidateModelCache() {
  cachedModels = null;
  listeners.forEach(fn => fn());
}

export function useModels() {
  const [models, setModels] = useState<ModelInfo[]>(cachedModels || []);

  const refresh = useCallback(() => {
    getModels()
      .then(m => { cachedModels = m; setModels(m); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!cachedModels) refresh();
    listeners.push(refresh);
    return () => { listeners = listeners.filter(fn => fn !== refresh); };
  }, [refresh]);

  return models;
}
