import { useState, useEffect } from 'react';
import { getRuntimes, RuntimeInfo } from '../api/client';

let cachedRuntimes: { runtimes: RuntimeInfo[]; default: string } | null = null;
let listeners: (() => void)[] = [];

export function invalidateRuntimeCache() {
  cachedRuntimes = null;
  listeners.forEach(fn => fn());
}

export function useRuntimes() {
  const [data, setData] = useState(cachedRuntimes);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(!cachedRuntimes);

  useEffect(() => {
    const refresh = () => {
      setLoading(true);
      getRuntimes()
        .then(d => { cachedRuntimes = d; setData(d); setError(false); })
        .catch(() => { setError(true); })
        .finally(() => setLoading(false));
    };
    if (!cachedRuntimes) refresh();
    else { setData(cachedRuntimes); setLoading(false); }
    listeners.push(refresh);
    return () => { listeners = listeners.filter(fn => fn !== refresh); };
  }, []);

  return { data, error, loading };
}

export function useRuntimeInfo(runtimeId: string): RuntimeInfo | null {
  const { data } = useRuntimes();
  return data?.runtimes.find(r => r.id === runtimeId) ?? null;
}

/**
 * Return the first valid model for a runtime if currentModel is incompatible, or null if it's fine.
 */
export function pickModelForRuntime(runtimes: RuntimeInfo[], runtimeId: string, currentModel: string): string | null {
  const rt = runtimes.find(r => r.id === runtimeId);
  if (!rt) return null;
  const models = rt.models ?? [];
  if (models.length > 0) {
    return models.some(m => m.id === currentModel) ? null : models[0].id;
  }
  return null;
}

interface Props {
  value: string;
  onChange: (runtime: string, info?: RuntimeInfo) => void;
}

export default function RuntimeSelector({ value, onChange }: Props) {
  const { data, error, loading } = useRuntimes();
  const runtimes = data?.runtimes ?? [];
  const available = runtimes.filter(r => r.available);

  useEffect(() => {
    if (!value && available.length === 1) {
      onChange(available[0].id);
    }
  }, [value, available.length]);

  if (loading && runtimes.length === 0) {
    return (
      <div className="flex gap-1.5">
        {[1, 2, 3].map(i => (
          <div key={i} className="flex-1 h-8 rounded-lg bg-nebula-bg border border-nebula-border animate-pulse" />
        ))}
      </div>
    );
  }

  if (error && runtimes.length === 0) {
    return <p className="text-xs text-red-400">Failed to load runtimes. Check server connection.</p>;
  }

  if (!loading && available.length === 0) {
    return <p className="text-xs text-red-400">No CLI runtimes detected. Place a supported CLI binary in the runtimes volume and re-detect.</p>;
  }

  const selected = runtimes.find(r => r.id === value);

  return (
    <div>
      <div className="flex gap-1.5">
        {runtimes.map(rt => (
          <button
            key={rt.id}
            type="button"
            disabled={!rt.available}
            onClick={() => onChange(rt.id, rt)}
            title={rt.available ? `${rt.name} ${rt.version || ''} — ${rt.binaryPath}` : `${rt.name} (not installed)`}
            className={`flex-1 py-1.5 px-2 text-xs rounded-lg border transition-colors truncate ${
              value === rt.id
                ? 'bg-nebula-accent/10 border-nebula-accent/30 text-nebula-accent'
                : rt.available
                  ? 'bg-nebula-bg border-nebula-border text-nebula-muted hover:border-nebula-accent/20'
                  : 'bg-nebula-bg border-nebula-border text-nebula-muted/30 cursor-not-allowed'
            }`}
          >
            {rt.name}
          </button>
        ))}
      </div>
      {selected && !selected.auth.ok && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
          <span className="text-red-400">{selected.auth.error || 'Auth failed'}</span>
          {selected.authGuide.command && (
            <span className="text-nebula-muted">
              — run: <code className="bg-nebula-bg px-1 rounded font-mono">{selected.authGuide.command}</code>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
