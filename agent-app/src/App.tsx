import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

declare const __APP_VERSION__: string;

interface AgentState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  server: string;
  agent_id: string;
  agent_name: string;
  error: string;
  device: string;
  last_activity: string;
}

type DetectedRuntime = [string, string]; // [id, path]

export default function App() {
  const [state, setState] = useState<AgentState>({
    status: 'disconnected', server: '', agent_id: '', agent_name: '',
    error: '', device: '', last_activity: '',
  });
  const [server, setServer] = useState('');
  const [agentId, setAgentId] = useState('');
  const [token, setToken] = useState('');
  const [proxy, setProxy] = useState('');
  const [registered, setRegistered] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [detectedRuntimes, setDetectedRuntimes] = useState<DetectedRuntime[]>([]);
  const [runtimesLoading, setRuntimesLoading] = useState(true);

  useEffect(() => {
    // Load saved config
    invoke<AgentState | null>('get_state').then(s => {
      if (s) {
        setState(s);
        if (s.server && s.agent_id) {
          setServer(s.server);
          setAgentId(s.agent_id);
          setRegistered(true);
        }
      }
    });

    // Detect available CLI runtimes
    invoke<DetectedRuntime[]>('detect_runtimes')
      .then(r => { setDetectedRuntimes(r); setRuntimesLoading(false); })
      .catch(() => setRuntimesLoading(false));

    // Listen for state updates from Rust
    const unlisten = listen<AgentState>('agent-state', (event) => {
      setState(event.payload);
    });
    const unlistenLog = listen<string>('agent-log', (event) => {
      setLogs(prev => [...prev.slice(-100), event.payload]);
    });

    // Refresh state when window becomes visible (user clicks tray)
    const onFocus = async () => {
      const s = await invoke<AgentState>('get_state');
      if (s) setState(s);
    };
    window.addEventListener('focus', onFocus);

    return () => {
      unlisten.then(f => f());
      unlistenLog.then(f => f());
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const handleRescan = async () => {
    setRuntimesLoading(true);
    try {
      const r = await invoke<DetectedRuntime[]>('detect_runtimes');
      setDetectedRuntimes(r);
    } catch {}
    setRuntimesLoading(false);
  };

  const handleRegister = async () => {
    if (!server || !agentId || !token) return;
    try {
      await invoke('register', { server, agentId, token, proxy: proxy || null });
      setRegistered(true);
    } catch (e: any) {
      setState(prev => ({ ...prev, error: String(e) }));
    }
  };

  const handleConnect = async () => {
    setState(prev => ({ ...prev, status: 'connecting', error: '' }));
    await invoke('connect_agent');
    setTimeout(async () => {
      const s = await invoke<AgentState>('get_state');
      if (s) setState(s);
    }, 2000);
  };
  const handleDisconnect = async () => {
    await invoke('disconnect_agent');
    const s = await invoke<AgentState>('get_state');
    if (s) setState(s);
  };
  const handleUnregister = async () => {
    await invoke('unregister');
    setRegistered(false);
    setServer('');
    setAgentId('');
    setToken('');
    setState({ status: 'disconnected', server: '', agent_id: '', agent_name: '', error: '', device: '', last_activity: '' });
  };

  const RUNTIME_LABELS: Record<string, string> = {
    'claude-cli': 'Claude Code',
    'opencode': 'OpenCode',
    'codex': 'Codex CLI',
    'gemini': 'Gemini CLI',
  };

  const statusColor = {
    connected: 'bg-nebula-green',
    connecting: 'bg-yellow-500 animate-pulse',
    disconnected: 'bg-nebula-muted',
    error: 'bg-nebula-red',
  }[state.status];

  // Shared runtimes display
  const runtimesBlock = (
    <div className="bg-nebula-surface border border-nebula-border rounded-lg p-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] text-nebula-muted">CLI Runtimes</span>
        <button onClick={handleRescan} disabled={runtimesLoading} className="text-[10px] text-nebula-muted hover:text-nebula-accent disabled:opacity-30">
          {runtimesLoading ? 'Scanning...' : 'Re-scan'}
        </button>
      </div>
      {detectedRuntimes.length > 0 ? (
        <div className="space-y-1">
          {detectedRuntimes.map(([id, path]) => (
            <div key={id} className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
              <span className="text-[11px] text-nebula-text">{RUNTIME_LABELS[id] || id}</span>
              <span className="text-[10px] text-nebula-muted font-mono truncate">{path}</span>
            </div>
          ))}
        </div>
      ) : runtimesLoading ? (
        <p className="text-[10px] text-nebula-muted">Detecting...</p>
      ) : (
        <div className="space-y-1">
          <p className="text-[10px] text-red-400">No CLI runtimes found.</p>
          <p className="text-[10px] text-nebula-muted">Install at least one:</p>
          <code className="block text-[10px] text-nebula-text font-mono select-all">npm install -g @anthropic-ai/claude-code</code>
          <code className="block text-[10px] text-nebula-text font-mono select-all">npm install -g opencode-ai</code>
        </div>
      )}
    </div>
  );

  return (
    <div className="p-4 min-h-screen bg-nebula-bg select-none">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <div className="w-6 h-6 rounded-md bg-gradient-to-br from-[#c9a84c] to-[#8b7524] flex items-center justify-center">
          <span className="text-[10px] font-bold text-nebula-bg">N</span>
        </div>
        <span className="text-sm font-semibold">Nebula Agent</span>
        <span className="text-[10px] text-nebula-muted">v{__APP_VERSION__}</span>
        <div className="flex-1" />
        <div className={`w-2 h-2 rounded-full ${statusColor}`} />
        <span className="text-[11px] text-nebula-muted capitalize">{state.status}</span>
      </div>

      {!registered ? (
        /* Registration form */
        <div className="space-y-3">
          <p className="text-[12px] text-nebula-muted">Connect this machine as a remote agent.</p>

          {runtimesBlock}

          <input
            value={server}
            onChange={e => setServer(e.target.value)}
            placeholder="Server URL (http://your-nas:8090)"
            className="w-full px-3 py-2 bg-nebula-surface border border-nebula-border rounded-lg text-[12px] text-nebula-text placeholder:text-nebula-muted/50 focus:outline-none focus:border-nebula-accent/50"
          />
          <input
            value={agentId}
            onChange={e => setAgentId(e.target.value)}
            placeholder="Agent ID"
            className="w-full px-3 py-2 bg-nebula-surface border border-nebula-border rounded-lg text-[12px] text-nebula-text font-mono placeholder:text-nebula-muted/50 focus:outline-none focus:border-nebula-accent/50"
          />
          <input
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="Remote Token"
            type="password"
            className="w-full px-3 py-2 bg-nebula-surface border border-nebula-border rounded-lg text-[12px] text-nebula-text font-mono placeholder:text-nebula-muted/50 focus:outline-none focus:border-nebula-accent/50"
          />
          <input
            value={proxy}
            onChange={e => setProxy(e.target.value)}
            placeholder="HTTP Proxy (optional, e.g. http://proxy:7890)"
            className="w-full px-3 py-2 bg-nebula-surface border border-nebula-border rounded-lg text-[12px] text-nebula-text font-mono placeholder:text-nebula-muted/50 focus:outline-none focus:border-nebula-accent/50"
          />
          {state.error && (
            <p className="text-[11px] text-nebula-red">{state.error}</p>
          )}
          <button
            onClick={handleRegister}
            disabled={!server || !agentId || !token || detectedRuntimes.length === 0}
            className="w-full py-2 bg-nebula-accent text-nebula-bg rounded-lg text-[12px] font-semibold hover:brightness-110 disabled:opacity-30"
          >
            {detectedRuntimes.length === 0 ? 'Install a CLI runtime first' : 'Register & Connect'}
          </button>
        </div>
      ) : (
        /* Connected view */
        <div className="space-y-3">
          <div className="bg-nebula-surface border border-nebula-border rounded-lg p-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-nebula-muted">Server</span>
              <span className="text-[11px] text-nebula-text truncate ml-2">{state.server || server}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-nebula-muted">Agent</span>
              <span className="text-[11px] text-nebula-text">{state.agent_name || agentId.slice(0, 12) + '...'}</span>
            </div>
            {state.device && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-nebula-muted">Device</span>
                <span className="text-[11px] text-nebula-text">{state.device}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-nebula-muted">Runtimes</span>
              <span className="text-[11px] text-nebula-text">
                {detectedRuntimes.length > 0
                  ? detectedRuntimes.map(([id]) => RUNTIME_LABELS[id] || id).join(', ')
                  : 'None detected'}
              </span>
            </div>
            {state.last_activity && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-nebula-muted">Last activity</span>
                <span className="text-[11px] text-nebula-text">{state.last_activity}</span>
              </div>
            )}
          </div>

          {state.error && (
            <p className="text-[11px] text-nebula-red bg-nebula-red/10 border border-nebula-red/20 rounded-lg p-2">{state.error}</p>
          )}

          <div className="flex gap-2">
            {state.status === 'connected' || state.status === 'connecting' ? (
              <button onClick={handleDisconnect} className="flex-1 py-2 bg-nebula-surface border border-nebula-border rounded-lg text-[12px] text-nebula-muted hover:text-nebula-text">
                Disconnect
              </button>
            ) : (
              <button onClick={handleConnect} className="flex-1 py-2 bg-nebula-accent text-nebula-bg rounded-lg text-[12px] font-semibold hover:brightness-110">
                Connect
              </button>
            )}
            <button onClick={() => setShowLogs(!showLogs)} className="px-3 py-2 bg-nebula-surface border border-nebula-border rounded-lg text-[12px] text-nebula-muted hover:text-nebula-text">
              Logs
            </button>
          </div>

          {showLogs && (
            <div className="bg-nebula-surface border border-nebula-border rounded-lg p-2 max-h-40 overflow-y-auto">
              {logs.length === 0 ? (
                <p className="text-[10px] text-nebula-muted">No logs yet</p>
              ) : logs.map((log, i) => (
                <p key={i} className="text-[10px] text-nebula-muted font-mono leading-tight">{log}</p>
              ))}
            </div>
          )}

          <button onClick={handleUnregister} className="w-full py-1.5 text-[11px] text-nebula-muted hover:text-nebula-red">
            Unregister
          </button>
        </div>
      )}
    </div>
  );
}
