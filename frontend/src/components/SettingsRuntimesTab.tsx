import { useState } from 'react';
import { detectRuntimes, getRuntimes, setDefaultRuntime, RuntimeInfo } from '../api/client';

interface Props {
  runtimes: RuntimeInfo[];
  setRuntimes: (r: RuntimeInfo[]) => void;
  runtimeDefault: string;
  setRuntimeDefault: (id: string) => void;
  runtimesLoading: boolean;
}

export default function SettingsRuntimesTab({
  runtimes, setRuntimes, runtimeDefault, setRuntimeDefault, runtimesLoading,
}: Props) {
  const [runtimeDetecting, setRuntimeDetecting] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-nebula-muted">CLI runtimes execute your agents. Each manages its own auth.</p>
        <button
          onClick={async () => {
            setRuntimeDetecting(true);
            try {
              await detectRuntimes();
              await getRuntimes().then(r => { setRuntimes(r.runtimes); setRuntimeDefault(r.default); });
            } catch {}
            setRuntimeDetecting(false);
          }}
          disabled={runtimeDetecting}
          className="px-3 py-1.5 text-xs bg-nebula-surface-2 border border-nebula-border rounded hover:bg-nebula-hover disabled:opacity-30 text-nebula-muted shrink-0"
        >
          {runtimeDetecting ? 'Scanning...' : 'Re-detect'}
        </button>
      </div>

      {runtimesLoading && runtimes.length === 0 && (
        <div className="space-y-3">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="rounded-lg border border-nebula-border/50 p-3 animate-pulse">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-nebula-border" />
                <div className="h-4 w-24 bg-nebula-border/50 rounded" />
              </div>
              <div className="h-3 w-48 bg-nebula-border/30 rounded mt-2" />
            </div>
          ))}
        </div>
      )}

      {runtimes.map(rt => (
        <div key={rt.id} className={`rounded-lg border ${rt.available ? 'border-nebula-border' : 'border-nebula-border/50'}`}>
          <div className="flex items-center justify-between p-3 pb-0">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${rt.available ? 'bg-green-400' : 'bg-red-400'}`} />
              <span className="text-sm font-medium">{rt.name}</span>
              {rt.available && rt.version && (
                <span className="text-[10px] text-nebula-muted font-mono">{rt.version}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {rt.available && runtimeDefault === rt.id && (
                <span className="text-[10px] bg-nebula-accent/10 text-nebula-accent px-2 py-0.5 rounded">default</span>
              )}
              {rt.available && runtimeDefault !== rt.id && (
                <button
                  onClick={async () => { try { await setDefaultRuntime(rt.id); setRuntimeDefault(rt.id); } catch {} }}
                  className="text-[10px] text-nebula-muted hover:text-nebula-accent"
                >
                  Set as default
                </button>
              )}
            </div>
          </div>

          <div className="p-3 pt-2 space-y-2">
            {rt.available ? (
              <>
                <p className="text-[11px] text-nebula-muted font-mono">{rt.binaryPath}</p>
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className={rt.auth.ok ? 'text-green-400' : 'text-red-400'}>
                    {rt.auth.ok ? 'Auth OK' : rt.auth.error || 'Auth issue'}
                  </span>
                  {!rt.auth.ok && rt.authGuide.command && (
                    <span className="text-nebula-muted">
                      — run: <code className="bg-nebula-bg px-1 rounded font-mono select-all">{rt.authGuide.dockerCommand || rt.authGuide.command}</code>
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-nebula-muted">
                  {rt.supportedModelPrefixes.length > 0
                    ? `Models: ${rt.supportedModelPrefixes.map(p => p + '*').join(', ')}`
                    : 'Models: any'
                  }
                </p>
              </>
            ) : (
              <div className="bg-nebula-bg rounded-lg p-2.5 space-y-1.5">
                <p className="text-[11px] text-nebula-muted">
                  Not detected. Place or symlink the binary into the runtimes volume:
                </p>
                <code className="block text-[11px] text-nebula-text bg-nebula-surface px-2 py-1 rounded font-mono select-all">
                  runtimes/bin/{rt.binaryName}
                </code>
                <p className="text-[11px] text-nebula-muted">Then click Re-detect above.</p>
                {rt.authGuide.description && (
                  <p className="text-[11px] text-nebula-muted">Auth: {rt.authGuide.description}</p>
                )}
                {rt.install.url && (
                  <a href={rt.install.url} target="_blank" rel="noopener noreferrer" className="text-[11px] text-nebula-accent hover:underline">
                    Documentation
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
