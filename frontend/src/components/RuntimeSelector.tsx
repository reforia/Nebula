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

  useEffect(() => {
    const refresh = () => {
      getRuntimes()
        .then(d => { cachedRuntimes = d; setData(d); setError(false); })
        .catch(() => { setError(true); });
    };
    if (!cachedRuntimes) refresh();
    else setData(cachedRuntimes);
    listeners.push(refresh);
    return () => { listeners = listeners.filter(fn => fn !== refresh); };
  }, []);

  return { data, error };
}

export function useRuntimeInfo(runtimeId: string): RuntimeInfo | null {
  const { data } = useRuntimes();
  return data?.runtimes.find(r => r.id === runtimeId) ?? null;
}

interface Props {
  value: string;
  onChange: (runtime: string) => void;
}

export default function RuntimeSelector({ value, onChange }: Props) {
  const { data, error } = useRuntimes();
  const runtimes = data?.runtimes ?? [];
  const available = runtimes.filter(r => r.available);

  useEffect(() => {
    if (!value && available.length === 1) {
      onChange(available[0].id);
    }
  }, [value, available.length]);

  if (runtimes.length === 0) {
    if (error) return <p className="text-xs text-red-400">Failed to load runtimes. Check server connection.</p>;
    return <p className="text-xs text-nebula-muted">Loading runtimes...</p>;
  }

  if (available.length === 0) {
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
            onClick={() => onChange(rt.id)}
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
