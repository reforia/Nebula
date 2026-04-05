import { useState, useEffect } from 'react';
import { Agent, AgentSecret, getAgent, updateAgent, deleteAgent, resetAgentSession, generateRemoteToken, getAgentSecrets, createAgentSecret, deleteAgentSecret, getSettings } from '../api/client';
import TaskList from './TaskList';
import VaultFiles from './VaultFiles';
import SkillEditor from './SkillEditor';
import Modal from './Modal';
import McpServerEditor from './McpServerEditor';
import MemoryEditor from './MemoryEditor';
import ToolsPicker from './ToolsPicker';
import ModelPicker from './ModelPicker';
import RuntimeSelector, { useRuntimes } from './RuntimeSelector';

interface Props {
  agent: Agent;
  conversationId?: string | null;
  onClose: () => void;
  onUpdated: () => void;
  onDeleted: () => void;
}

export default function AgentSettings({ agent, conversationId, onClose, onUpdated, onDeleted }: Props) {
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role);
  const [emoji, setEmoji] = useState(agent.emoji);
  const [model, setModel] = useState(agent.model);
  const [runtime, setRuntime] = useState(agent.backend || 'claude-cli');
  const { data } = useRuntimes();
  const [allowedTools, setAllowedTools] = useState(agent.allowed_tools);
  const [enabled, setEnabled] = useState(!!agent.enabled);
  const [notifyEmail, setNotifyEmail] = useState(!!agent.notify_email);
  const [timeoutMin, setTimeoutMin] = useState<number | ''>(agent.timeout_ms ? Math.round(agent.timeout_ms / 60000) : '');
  const [orgDefaultTimeoutMin, setOrgDefaultTimeoutMin] = useState(10);
  const [recoveryBudget, setRecoveryBudget] = useState<number | ''>(agent.recovery_token_budget || '');
  const [orgDefaultRecoveryBudget, setOrgDefaultRecoveryBudget] = useState(25000);
  const [executionMode, setExecutionMode] = useState<'local' | 'remote'>(agent.execution_mode || 'local');
  const [remoteToken, setRemoteToken] = useState<string | null>(null);
  const [hasRemoteToken, setHasRemoteToken] = useState(false);
  const [remoteConnected, setRemoteConnected] = useState<boolean | null>(null);
  const [nasPaths, setNasPaths] = useState<string[]>([]);
  const [newNasPath, setNewNasPath] = useState('');
  const [claudeMd, setClaudeMd] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'general' | 'knowledge' | 'memory' | 'skills' | 'mcp' | 'secrets' | 'tasks' | 'vault' | 'access'>('general');
  const [agentSecretsList, setAgentSecretsList] = useState<AgentSecret[]>([]);
  const [newASecretKey, setNewASecretKey] = useState('');
  const [newASecretValue, setNewASecretValue] = useState('');
  const [secretSaving, setSecretSaving] = useState(false);
  const [editingASecretId, setEditingASecretId] = useState<string | null>(null);
  const [editASecretValue, setEditASecretValue] = useState('');
  const [editASecretSaving, setEditASecretSaving] = useState(false);

  const refreshSecrets = () => { getAgentSecrets(agent.id).then(setAgentSecretsList).catch(() => {}); };

  useEffect(() => {
    getAgent(agent.id).then(a => {
      setClaudeMd(a.claude_md || '');
      setExecutionMode(a.execution_mode || 'local');
      setHasRemoteToken(!!a.has_remote_token);
      setRemoteConnected(a.remote_connected ?? null);
      try { setNasPaths(JSON.parse(a.nas_paths || '[]')); } catch { setNasPaths([]); }
    }).catch(() => {});
    getSettings().then(s => {
      setOrgDefaultTimeoutMin(Math.round(parseInt(s.default_timeout_ms || '600000') / 60000));
      setOrgDefaultRecoveryBudget(parseInt(s.recovery_token_budget || '25000') || 25000);
    }).catch(() => {});
    refreshSecrets();
  }, [agent.id]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await updateAgent(agent.id, {
        name, role, emoji, model, backend: runtime,
        allowed_tools: allowedTools,
        enabled: enabled as any,
        notify_email: notifyEmail as any,
        timeout_ms: timeoutMin ? timeoutMin * 60000 : null,
        recovery_token_budget: recoveryBudget || null,
        execution_mode: executionMode,
        nas_paths: nasPaths as any,
        claude_md: claudeMd,
      });
      onUpdated();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete agent "${agent.name}"? This will remove all messages and tasks.`)) return;
    try {
      await deleteAgent(agent.id);
      onDeleted();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleResetSession = async () => {
    if (!confirm('Reset the current conversation session? The agent will lose its context for this conversation.')) return;
    try {
      await resetAgentSession(agent.id, conversationId || undefined);
      onUpdated();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const addNasPath = () => {
    const p = newNasPath.trim();
    if (!p || nasPaths.includes(p)) return;
    setNasPaths([...nasPaths, p]);
    setNewNasPath('');
  };

  const tabs = ['general', 'knowledge', 'memory', 'skills', 'mcp', 'secrets', 'tasks', 'vault', 'access'] as const;

  return (
    <Modal onClose={onClose} variant="panel">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-base font-semibold">{agent.emoji} {agent.name}</h2>
            <button onClick={onClose} className="text-nebula-muted hover:text-nebula-text p-1">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>

          {/* Tabs */}
          <div className="flex flex-wrap gap-0.5 mb-5 border-b border-nebula-border">
            {tabs.map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-2 text-[12px] capitalize -mb-px border-b-2 transition-colors whitespace-nowrap ${
                  tab === t ? 'border-nebula-accent text-nebula-text' : 'border-transparent text-nebula-muted hover:text-nebula-text'
                }`}
              >
                {t === 'mcp' ? 'MCP' : t}
              </button>
            ))}
          </div>

          {tab === 'general' && (
            <div className="space-y-4">
              <div>
                <label className="text-xs text-nebula-muted block mb-1">Name</label>
                <input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded-lg text-sm text-nebula-text focus:outline-none focus:border-nebula-accent/50" />
              </div>
              <div>
                <label className="text-xs text-nebula-muted block mb-1">Role</label>
                <textarea value={role} onChange={e => setRole(e.target.value)} rows={3} className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded-lg text-sm text-nebula-text focus:outline-none focus:border-nebula-accent/50 resize-none" />
              </div>
              <div>
                <label className="text-xs text-nebula-muted block mb-1">Emoji</label>
                <input value={emoji} onChange={e => setEmoji(e.target.value)} className="w-20 px-3 py-2 bg-nebula-bg border border-nebula-border rounded-lg text-sm text-nebula-text text-center focus:outline-none focus:border-nebula-accent/50" />
              </div>
              <div>
                <label className="text-xs text-nebula-muted block mb-1">Runtime</label>
                <RuntimeSelector value={runtime} onChange={(rt, info) => {
                  setRuntime(rt);
                  if (info) {
                    const models = info.models ?? [];
                    if (models.length > 0 && !models.some(m => m.id === model)) {
                      setModel(models[0].id);
                    }
                  }
                }} />
              </div>
              {(() => {
                const rtInfo = (data?.runtimes ?? []).find(r => r.id === runtime);
                const authOk = !rtInfo || rtInfo.auth.ok;
                return (
                  <>
                    <div className={!authOk ? 'opacity-50 pointer-events-none' : ''}>
                      <label className="text-xs text-nebula-muted block mb-1">Model</label>
                      <ModelPicker model={model} onChange={setModel} runtimeId={runtime} className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded-lg text-sm text-nebula-text focus:outline-none focus:border-nebula-accent/50" />
                    </div>
                    <div className={!authOk ? 'opacity-50 pointer-events-none' : ''}>
                      <label className="text-xs text-nebula-muted block mb-1">Allowed Tools</label>
                      <ToolsPicker value={allowedTools} onChange={setAllowedTools} hasBuiltinWebTools={rtInfo?.hasBuiltinWebTools ?? true} />
                    </div>
                  </>
                );
              })()}
              <div>
                <label className="text-xs text-nebula-muted block mb-1">Execution Timeout (minutes)</label>
                <input type="number" value={timeoutMin} onChange={e => { const v = e.target.value; setTimeoutMin(v === '' ? '' : (parseInt(v) || 10)); }} min={1} max={120}
                  placeholder={`Org default (${orgDefaultTimeoutMin})`}
                  className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded-lg text-sm text-nebula-text focus:outline-none focus:border-nebula-accent/50" />
                <p className="text-[10px] text-nebula-muted mt-1">Leave empty to use org default. Tasks can override with their own timeout.</p>
              </div>
              <div>
                <label className="text-xs text-nebula-muted block mb-1">Recovery Token Budget</label>
                <input type="number" value={recoveryBudget} onChange={e => { const v = e.target.value; setRecoveryBudget(v === '' ? '' : (parseInt(v) || 25000)); }} min={1000} max={200000} step={1000}
                  placeholder={`Org default (${orgDefaultRecoveryBudget.toLocaleString()})`}
                  className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded-lg text-sm text-nebula-text focus:outline-none focus:border-nebula-accent/50" />
                <p className="text-[10px] text-nebula-muted mt-1">Max tokens of conversation history to recover on session reset (~4 chars/token). Leave empty for org default.</p>
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="accent-nebula-accent" />
                  Enabled
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={notifyEmail} onChange={e => setNotifyEmail(e.target.checked)} className="accent-nebula-accent" />
                  Email notifications
                </label>
              </div>

              {/* Execution Mode */}
              <div className="pt-4 border-t border-nebula-border space-y-3">
                <div>
                  <label className="text-xs text-nebula-muted block mb-1">Execution Mode</label>
                  <select
                    value={executionMode}
                    onChange={e => setExecutionMode(e.target.value as 'local' | 'remote')}
                    className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded-lg text-sm text-nebula-text focus:outline-none focus:border-nebula-accent/50"
                  >
                    <option value="local">Local (Docker container)</option>
                    <option value="remote">Remote (external machine)</option>
                  </select>
                </div>
                {executionMode === 'remote' && (
                  <div className="bg-nebula-bg border border-nebula-border rounded-lg p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-nebula-muted">Status:</span>
                      {remoteConnected === true ? (
                        <span className="text-[11px] text-nebula-green flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-nebula-green inline-block" /> Connected
                        </span>
                      ) : (
                        <span className="text-[11px] text-nebula-muted flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-nebula-muted inline-block" /> Not connected
                        </span>
                      )}
                    </div>
                    {(agent as any).remote_device_info && (
                      <div className="text-[11px] text-nebula-muted">
                        <span className="text-nebula-text">{(agent as any).remote_device_info.hostname}</span>
                        {' '}&middot; {(agent as any).remote_device_info.platform}/{(agent as any).remote_device_info.arch}
                        {' '}&middot; Node {(agent as any).remote_device_info.node}
                      </div>
                    )}
                    {remoteToken ? (
                      <div>
                        <p className="text-[11px] text-nebula-amber mb-1">Copy this token now — it won't be shown again:</p>
                        <code className="block bg-nebula-surface p-2 rounded text-[11px] text-nebula-accent break-all select-all">{remoteToken}</code>
                      </div>
                    ) : (
                      <button
                        onClick={async () => {
                          const { token } = await generateRemoteToken(agent.id);
                          setRemoteToken(token);
                          setHasRemoteToken(true);
                          setExecutionMode('remote');
                        }}
                        className="text-xs px-3 py-1.5 bg-nebula-accent/10 border border-nebula-accent/20 rounded-lg text-nebula-accent hover:bg-nebula-accent/20"
                      >
                        {hasRemoteToken ? 'Regenerate Token' : 'Generate Token'}
                      </button>
                    )}
                    <p className="text-[10px] text-nebula-muted">
                      Install the client: <code className="text-nebula-accent">npm i -g @nebula/agent-client</code><br/>
                      Register: <code className="text-nebula-accent">nebula-agent register --server {window.location.origin} --agent-id {agent.id} --token &lt;token&gt;</code><br/>
                      Start: <code className="text-nebula-accent">nebula-agent start</code>
                    </p>
                  </div>
                )}
              </div>

              <div className="pt-4 border-t border-nebula-border space-y-2">
                <p className="text-[11px] text-nebula-muted">Session: <code className="bg-nebula-bg px-1 rounded">{agent.session_id.slice(0, 8)}...</code></p>
                <div className="flex gap-2">
                  <button onClick={handleResetSession} className="px-3 py-1.5 text-xs bg-nebula-bg border border-nebula-border rounded-lg hover:bg-nebula-hover">
                    Reset Session
                  </button>
                  <button onClick={handleDelete} className="px-3 py-1.5 text-xs bg-nebula-red/10 border border-nebula-red/20 rounded-lg text-nebula-red hover:bg-nebula-red/20">
                    Delete Agent
                  </button>
                </div>
              </div>
            </div>
          )}

          {tab === 'knowledge' && (
            <div>
              <label className="text-xs text-nebula-muted block mb-2">Agent CLAUDE.md</label>
              <textarea
                value={claudeMd}
                onChange={e => setClaudeMd(e.target.value)}
                rows={20}
                className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded-lg text-sm text-nebula-text font-mono focus:outline-none focus:border-nebula-accent/50 resize-y"
                spellCheck={false}
              />
            </div>
          )}

          {tab === 'memory' && <MemoryEditor agentId={agent.id} />}

          {tab === 'skills' && <SkillEditor scope="agent" agentId={agent.id} />}

          {tab === 'mcp' && <McpServerEditor scope="agent" agentId={agent.id} />}

          {tab === 'secrets' && (
            <div className="space-y-4">
              <p className="text-xs text-nebula-muted">
                Agent-specific secrets override org secrets of the same key. Use <code className="text-nebula-accent">{'{{KEY}}'}</code> in skills — agent value wins.
              </p>
              <div className="bg-nebula-bg border border-nebula-border rounded-lg p-3 space-y-2">
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className="text-[11px] text-nebula-muted block mb-1">Key</label>
                    <input value={newASecretKey} onChange={e => setNewASecretKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
                      placeholder="GITEA_TOKEN" className="w-full px-3 py-2 bg-nebula-surface border border-nebula-border rounded-lg text-sm text-nebula-text font-mono focus:outline-none focus:border-nebula-accent/50" />
                  </div>
                  <div className="flex-1">
                    <label className="text-[11px] text-nebula-muted block mb-1">Value</label>
                    <input type="password" value={newASecretValue} onChange={e => setNewASecretValue(e.target.value)}
                      placeholder="token or password" className="w-full px-3 py-2 bg-nebula-surface border border-nebula-border rounded-lg text-sm text-nebula-text font-mono focus:outline-none focus:border-nebula-accent/50" />
                  </div>
                </div>
                <div className="flex justify-end">
                  <button onClick={async () => {
                    if (!newASecretKey.trim() || !newASecretValue.trim()) return;
                    setSecretSaving(true);
                    try {
                      await createAgentSecret(agent.id, newASecretKey, newASecretValue);
                      setNewASecretKey(''); setNewASecretValue(''); refreshSecrets();
                    } catch {} finally { setSecretSaving(false); }
                  }} disabled={secretSaving}
                    className="px-3 py-1.5 text-xs bg-nebula-accent text-nebula-bg rounded-lg hover:brightness-110 disabled:opacity-50 font-medium">
                    {secretSaving ? 'Saving...' : 'Add Secret'}
                  </button>
                </div>
              </div>
              {agentSecretsList.length === 0 ? (
                <p className="text-sm text-nebula-muted py-4 text-center">No agent secrets</p>
              ) : (
                <div className="space-y-1.5">
                  {agentSecretsList.map(s => (
                    <div key={s.id} className="bg-nebula-bg border border-nebula-border rounded-lg px-3 py-2">
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <code className="text-sm text-nebula-accent font-mono">{`{{${s.key}}}`}</code>
                          <span className="text-[11px] text-nebula-muted ml-3">agent override</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-nebula-muted font-mono">••••••••</span>
                          <button onClick={() => { setEditingASecretId(s.id); setEditASecretValue(''); }}
                            className="text-xs text-nebula-accent hover:brightness-110 px-1">Edit</button>
                          <button onClick={async () => {
                            if (!confirm(`Delete agent secret ${s.key}?`)) return;
                            await deleteAgentSecret(agent.id, s.id); refreshSecrets();
                          }} className="text-xs text-red-400 hover:text-red-300 px-1">Del</button>
                        </div>
                      </div>
                      {editingASecretId === s.id && (
                        <div className="flex gap-2 mt-2">
                          <input
                            type="password"
                            value={editASecretValue}
                            onChange={e => setEditASecretValue(e.target.value)}
                            onKeyDown={async e => {
                              if (e.key === 'Enter' && editASecretValue.trim()) {
                                setEditASecretSaving(true);
                                try {
                                  await createAgentSecret(agent.id, s.key, editASecretValue.trim());
                                  setEditingASecretId(null); setEditASecretValue('');
                                  refreshSecrets();
                                } catch {} finally { setEditASecretSaving(false); }
                              }
                            }}
                            placeholder="New secret value"
                            autoFocus
                            className="flex-1 px-2 py-1.5 bg-nebula-surface border border-nebula-border rounded text-sm text-nebula-text font-mono focus:outline-none focus:border-nebula-accent/50"
                          />
                          <button
                            onClick={async () => {
                              if (!editASecretValue.trim()) return;
                              setEditASecretSaving(true);
                              try {
                                await createAgentSecret(agent.id, s.key, editASecretValue.trim());
                                setEditingASecretId(null); setEditASecretValue('');
                                refreshSecrets();
                              } catch {} finally { setEditASecretSaving(false); }
                            }}
                            disabled={editASecretSaving || !editASecretValue.trim()}
                            className="px-3 py-1.5 text-xs bg-nebula-accent/20 text-nebula-accent rounded hover:bg-nebula-accent/30 disabled:opacity-30 font-medium"
                          >
                            {editASecretSaving ? '...' : 'Save'}
                          </button>
                          <button
                            onClick={() => { setEditingASecretId(null); setEditASecretValue(''); }}
                            className="px-2 py-1.5 text-xs text-nebula-muted hover:text-nebula-text"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'tasks' && <TaskList agentId={agent.id} />}

          {tab === 'vault' && <VaultFiles agentId={agent.id} />}

          {tab === 'access' && (
            <div className="space-y-4">
              <div>
                <label className="text-xs text-nebula-muted block mb-2">
                  NAS Paths — directories this agent can access (mounted at /nas in container)
                </label>
                <div className="flex gap-2 mb-3">
                  <input
                    value={newNasPath}
                    onChange={e => setNewNasPath(e.target.value)}
                    placeholder="/volume1/projects/myrepo"
                    onKeyDown={e => e.key === 'Enter' && addNasPath()}
                    className="flex-1 px-3 py-2 bg-nebula-bg border border-nebula-border rounded-lg text-sm text-nebula-text font-mono focus:outline-none focus:border-nebula-accent/50"
                  />
                  <button onClick={addNasPath} className="px-3 py-2 text-xs bg-nebula-accent text-nebula-bg rounded-lg hover:brightness-110 font-medium">
                    Add
                  </button>
                </div>
                {nasPaths.length === 0 ? (
                  <p className="text-sm text-nebula-muted">No NAS paths configured</p>
                ) : (
                  <div className="space-y-1">
                    {nasPaths.map((p, i) => (
                      <div key={i} className="flex items-center justify-between bg-nebula-bg border border-nebula-border rounded-lg px-3 py-2">
                        <code className="text-[12px] text-nebula-text truncate">{p}</code>
                        <button
                          onClick={() => setNasPaths(nasPaths.filter((_, j) => j !== i))}
                          className="ml-2 text-nebula-muted hover:text-nebula-red flex-shrink-0"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-[11px] text-nebula-muted mt-2">
                  Paths are relative to the NAS filesystem. The agent will see them symlinked under its working directory.
                </p>
              </div>
            </div>
          )}

          {error && <p className="text-nebula-red text-sm mt-4">{error}</p>}

          <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-nebula-border">
            <button onClick={onClose} className="px-4 py-2 text-sm text-nebula-muted hover:text-nebula-text">
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving} className="px-4 py-2 text-sm bg-nebula-accent text-nebula-bg rounded-lg hover:brightness-110 disabled:opacity-50 font-medium">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
    </Modal>
  );
}
