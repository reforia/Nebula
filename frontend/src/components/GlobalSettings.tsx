import { useState, useEffect } from 'react';
import { getSettings, updateSettings, getStatus, OrgStatus, checkCCAuth, getGlobalKnowledge, updateGlobalKnowledge, getSecrets, createSecret, deleteSecret, OrgSecret, updateOrg, getErrors, dismissError, dismissAllErrors, ExecutionError, exportTemplate, importTemplate, OrgTemplate, getSecretRefs, SecretRef, listTemplates, getTemplate, TemplateSummary, getCleanupStatus, runCleanup, CleanupStatus, getRuntimes, detectRuntimes, setDefaultRuntime, setRuntimePath, RuntimeInfo } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
// Models are now static from runtime adapters — no cache invalidation needed
import SkillEditor from './SkillEditor';
import Modal from './Modal';
import McpServerEditor from './McpServerEditor';

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

interface Props {
  onClose: () => void;
  onLogout: () => void;
}

export default function GlobalSettings({ onClose, onLogout }: Props) {
  const { currentOrg, refresh: refreshAuth } = useAuth();
  const [tab, setTab] = useState<'general' | 'templates' | 'smtp' | 'runtimes' | 'knowledge' | 'skills' | 'mcp' | 'secrets' | 'system'>('general');
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [globalMd, setGlobalMd] = useState('');
  const [status, setStatus] = useState<OrgStatus | null>(null);
  const [ccAuth, setCcAuth] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [orgName, setOrgName] = useState(currentOrg?.name || '');

  // Secrets state
  const [secrets, setSecrets] = useState<OrgSecret[]>([]);
  const [newSecretKey, setNewSecretKey] = useState('');
  const [newSecretValue, setNewSecretValue] = useState('');
  const [secretError, setSecretError] = useState('');
  const [secretSaving, setSecretSaving] = useState(false);

  // Error log state
  const [errors, setErrors] = useState<ExecutionError[]>([]);
  const [showErrors, setShowErrors] = useState(false);

  // Secret refs state
  const [secretRefs, setSecretRefs] = useState<SecretRef[]>([]);

  // Template state
  const [importStatus, setImportStatus] = useState<string>('');
  const [availableTemplates, setAvailableTemplates] = useState<TemplateSummary[]>([]);
  const [previewTemplate, setPreviewTemplate] = useState<OrgTemplate | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Cleanup state
  const [cleanupStatus, setCleanupStatus] = useState<CleanupStatus | null>(null);
  const [cleanupRunning, setCleanupRunning] = useState(false);

  const refreshSecrets = () => {
    getSecrets().then(setSecrets).catch(() => {});
    getSecretRefs('org').then(r => setSecretRefs(r.refs)).catch(() => {});
  };

  useEffect(() => {
    getSettings().then(setSettings).catch(() => {});
    getGlobalKnowledge().then(r => setGlobalMd(r.content)).catch(() => {});
    getStatus().then(setStatus).catch(() => {});
    refreshSecrets();
    listTemplates().then(setAvailableTemplates).catch(() => {});
  }, []);

  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [runtimeDefault, setRuntimeDefault] = useState('');
  const [runtimeDetecting, setRuntimeDetecting] = useState(false);
  const [runtimeCustomPaths, setRuntimeCustomPaths] = useState<Record<string, string>>({});
  const [runtimePathSaving, setRuntimePathSaving] = useState<Record<string, boolean>>({});
  const [runtimePathError, setRuntimePathError] = useState<Record<string, string>>({});

  useEffect(() => {
    getRuntimes().then(r => { setRuntimes(r.runtimes); setRuntimeDefault(r.default); }).catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      if (tab === 'general' && currentOrg && orgName.trim() && orgName.trim() !== currentOrg.name) {
        await updateOrg(currentOrg.id, orgName.trim());
        await refreshAuth();
      }
      await updateSettings(settings);
      if (tab === 'knowledge') {
        await updateGlobalKnowledge(globalMd);
      }
      // (No longer needed — model list comes from static runtime adapters)
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleCheckAuth = async () => {
    setCcAuth(null);
    const result = await checkCCAuth();
    setCcAuth(result);
  };

  const updateSetting = (key: string, value: string) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  return (
    <Modal onClose={onClose} variant="panel">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-semibold">Settings</h2>
            <button onClick={onClose} className="text-nebula-muted hover:text-nebula-text text-xl">&times;</button>
          </div>

          <div className="flex flex-wrap gap-1 mb-6 border-b border-nebula-border">
            {(['general', 'templates', 'smtp', 'runtimes', 'knowledge', 'skills', 'mcp', 'secrets', 'system'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-2 text-xs capitalize -mb-px border-b-2 transition-colors ${
                  tab === t ? 'border-nebula-accent text-nebula-text' : 'border-transparent text-nebula-muted hover:text-nebula-text'
                }`}
              >
                {t === 'mcp' ? 'MCP' : t === 'smtp' ? 'SMTP' : t}
              </button>
            ))}
          </div>

          {tab === 'general' && (
            <div className="space-y-5">
              {/* Org name */}
              <div>
                <label className="text-xs text-nebula-muted block mb-1">Organization Name</label>
                <input
                  value={orgName}
                  onChange={e => setOrgName(e.target.value)}
                  className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent"
                />
              </div>

              {/* Default agent timeout */}
              <div>
                <label className="text-xs text-nebula-muted block mb-1">Default Agent Timeout (minutes)</label>
                <input
                  type="number"
                  value={Math.round(parseInt(settings.default_timeout_ms || '600000') / 60000)}
                  onChange={e => updateSetting('default_timeout_ms', String((parseInt(e.target.value) || 10) * 60000))}
                  min={1} max={120}
                  className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent"
                />
                <p className="text-[10px] text-nebula-muted mt-1">Default execution timeout for new agents. Each agent can override this in their settings.</p>
              </div>

              {/* Task stagger */}
              <div>
                <label className="text-xs text-nebula-muted block mb-1">Task Stagger Delay (minutes)</label>
                <input
                  type="number"
                  value={Math.round(parseInt(settings.task_stagger_ms || '0') / 60000)}
                  onChange={e => updateSetting('task_stagger_ms', String((parseInt(e.target.value) || 0) * 60000))}
                  min={0} max={30}
                  className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent"
                />
                <p className="text-[10px] text-nebula-muted mt-1">Delay between concurrent cron tasks to avoid API rate limits. 0 = no stagger (all fire simultaneously).</p>
              </div>

              {/* Org overview */}
              {status && (
                <div>
                  <label className="text-xs text-nebula-muted block mb-2">Overview</label>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { label: 'Agents', value: status.agents },
                      { label: 'Active Tasks', value: status.active_tasks },
                      { label: 'Messages', value: status.total_messages.toLocaleString() },
                    ].map(s => (
                      <div key={s.label} className="bg-nebula-bg border border-nebula-border rounded-lg p-3 text-center">
                        <p className="text-lg font-semibold text-nebula-text">{s.value}</p>
                        <p className="text-[11px] text-nebula-muted">{s.label}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Usage stats */}
              {status?.usage && (
                <div>
                  <label className="text-xs text-nebula-muted block mb-2">Usage (last 30 days)</label>
                  <div className="grid grid-cols-3 gap-2 mb-3">
                    <div className="bg-nebula-bg border border-nebula-border rounded-lg p-3 text-center">
                      <p className="text-lg font-semibold text-nebula-text">{status.usage.last_30d.executions.toLocaleString()}</p>
                      <p className="text-[11px] text-nebula-muted">Executions</p>
                    </div>
                    <div className="bg-nebula-bg border border-nebula-border rounded-lg p-3 text-center">
                      <p className="text-lg font-semibold text-nebula-text">{formatTokens(status.usage.last_30d.tokens_in + status.usage.last_30d.tokens_out)}</p>
                      <p className="text-[11px] text-nebula-muted">Tokens</p>
                    </div>
                    <div className="bg-nebula-bg border border-nebula-border rounded-lg p-3 text-center">
                      <p className="text-lg font-semibold text-nebula-text">${status.usage.last_30d.cost.toFixed(2)}</p>
                      <p className="text-[11px] text-nebula-muted">Cost</p>
                    </div>
                  </div>

                  {/* All-time summary */}
                  <div className="bg-nebula-bg border border-nebula-border rounded-lg p-3 mb-3">
                    <p className="text-[11px] text-nebula-muted mb-1">All time</p>
                    <p className="text-sm text-nebula-text">
                      {status.usage.total.executions.toLocaleString()} executions
                      <span className="text-nebula-muted mx-1.5">/</span>
                      {formatTokens(status.usage.total.tokens_in + status.usage.total.tokens_out)} tokens
                      <span className="text-nebula-muted mx-1.5">/</span>
                      ${status.usage.total.cost.toFixed(2)}
                      {status.usage.total.errors > 0 && (
                        <button
                          onClick={() => { setShowErrors(!showErrors); if (!showErrors) getErrors(50).then(setErrors).catch(() => {}); }}
                          className="text-nebula-red ml-2 hover:underline"
                        >
                          ({status.usage.total.errors} errors)
                        </button>
                      )}
                    </p>
                  </div>

                  {/* Error log */}
                  {showErrors && (
                    <div className="bg-nebula-bg border border-nebula-border rounded-lg p-3 mb-3">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-[11px] text-nebula-muted">Recent errors</p>
                        <div className="flex items-center gap-2">
                          {errors.length > 0 && (
                            <button
                              onClick={async () => {
                                if (!confirm('Dismiss all errors?')) return;
                                await dismissAllErrors();
                                setErrors([]);
                                setShowErrors(false);
                                getStatus().then(setStatus).catch(() => {});
                              }}
                              className="text-[11px] text-nebula-red hover:text-red-300"
                            >
                              Dismiss all
                            </button>
                          )}
                          <button onClick={() => setShowErrors(false)} className="text-[11px] text-nebula-muted hover:text-nebula-text">&times;</button>
                        </div>
                      </div>
                      {errors.length === 0 ? (
                        <p className="text-[11px] text-nebula-muted text-center py-2">No errors recorded</p>
                      ) : (
                        <div className="space-y-2 max-h-64 overflow-y-auto">
                          {errors.map(e => (
                            <div key={e.id} className="border-b border-nebula-border pb-2 last:border-0 last:pb-0">
                              <div className="flex items-center justify-between text-[11px]">
                                <span className="text-nebula-text">{e.agent_emoji} {e.agent_name}</span>
                                <div className="flex items-center gap-2">
                                  <span className="text-nebula-muted">{new Date(e.created_at).toLocaleString()}</span>
                                  <button
                                    onClick={async () => {
                                      await dismissError(e.id);
                                      setErrors(prev => prev.filter(err => err.id !== e.id));
                                      getStatus().then(setStatus).catch(() => {});
                                    }}
                                    className="text-nebula-muted hover:text-nebula-text text-[10px]"
                                    title="Dismiss"
                                  >
                                    &times;
                                  </button>
                                </div>
                              </div>
                              <p className="text-[11px] text-nebula-red mt-0.5 font-mono break-all">{e.error_message || 'Unknown error'}</p>
                              <p className="text-[10px] text-nebula-muted mt-0.5">{e.backend} / {e.model}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Top models */}
                  {status.usage.top_models.length > 0 && (
                    <div className="bg-nebula-bg border border-nebula-border rounded-lg p-3 mb-3">
                      <p className="text-[11px] text-nebula-muted mb-2">Top models</p>
                      <div className="space-y-1.5">
                        {status.usage.top_models.map(m => (
                          <div key={m.model} className="flex items-center justify-between text-[12px]">
                            <span className="text-nebula-text truncate flex-1 font-mono">{m.model}</span>
                            <span className="text-nebula-muted ml-2 flex-shrink-0">
                              {m.executions}x / ${m.cost.toFixed(2)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Top agents */}
                  {status.usage.top_agents.length > 0 && (
                    <div className="bg-nebula-bg border border-nebula-border rounded-lg p-3">
                      <p className="text-[11px] text-nebula-muted mb-2">Top agents</p>
                      <div className="space-y-1.5">
                        {status.usage.top_agents.map(a => (
                          <div key={a.agent_id} className="flex items-center justify-between text-[12px]">
                            <span className="text-nebula-text truncate flex-1">{a.agent_emoji} {a.agent_name}</span>
                            <span className="text-nebula-muted ml-2 flex-shrink-0">
                              {a.executions}x / ${a.cost.toFixed(2)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

            </div>
          )}

          {tab === 'templates' && (
            <div className="space-y-4">
              <p className="text-[11px] text-nebula-muted">Apply a template to add pre-configured agents, skills, and tasks. Nothing existing is overwritten.</p>

              {/* Export / Import from file */}
              <div className="flex gap-2 items-center">
                <button
                  onClick={async () => {
                    try {
                      const tpl = await exportTemplate();
                      const blob = new Blob([JSON.stringify(tpl, null, 2)], { type: 'application/json' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `template-${(currentOrg?.name || 'org').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                    } catch (err: any) { setError(err.message); }
                  }}
                  className="px-3 py-1.5 text-xs bg-nebula-surface-2 border border-nebula-border rounded hover:bg-nebula-hover text-nebula-muted"
                >
                  Export This Org
                </button>
                <label className="px-3 py-1.5 text-xs bg-nebula-surface-2 border border-nebula-border rounded hover:bg-nebula-hover text-nebula-muted cursor-pointer">
                  Import from File
                  <input type="file" accept=".json" className="hidden" onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    e.target.value = '';
                    try {
                      const text = await file.text();
                      const tpl = JSON.parse(text);
                      const agentCount = tpl.agents?.length || 0;
                      const skillCount = (tpl.skills?.length || 0) + (tpl.agents || []).reduce((s: number, a: any) => s + (a.skills?.length || 0), 0);
                      const taskCount = (tpl.agents || []).reduce((s: number, a: any) => s + (a.tasks?.length || 0), 0);
                      if (!confirm(`Import "${tpl.name || 'template'}"?\n\n${agentCount} agents, ${skillCount} skills, ${taskCount} tasks\n\nThis will add to your org (nothing is overwritten).`)) return;
                      const result = await importTemplate(tpl);
                      setImportStatus(`Imported: ${result.created.agents} agents, ${result.created.skills} skills, ${result.created.tasks} tasks, ${result.created.mcp_servers} MCP servers`);
                      setTimeout(() => setImportStatus(''), 5000);
                    } catch (err: any) { setError(err.message || 'Invalid template file'); }
                  }} />
                </label>
              </div>

              {importStatus && <p className="text-xs text-green-400">{importStatus}</p>}

              {/* Template gallery */}
              {availableTemplates.length > 0 && !previewTemplate && (
                <div className="grid grid-cols-2 gap-2">
                  {availableTemplates.map(t => (
                    <button
                      key={t.id}
                      onClick={async () => {
                        setPreviewLoading(true);
                        try {
                          const tpl = await getTemplate(t.id);
                          setPreviewTemplate(tpl);
                        } catch (err: any) { setError(err.message); }
                        finally { setPreviewLoading(false); }
                      }}
                      disabled={previewLoading}
                      className="text-left bg-nebula-bg border border-nebula-border rounded-lg p-3 hover:border-nebula-accent/50 transition-colors disabled:opacity-50"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        {t.icon && <span className="text-lg">{t.icon}</span>}
                        <span className="text-[13px] font-medium text-nebula-text">{t.name}</span>
                      </div>
                      <p className="text-[11px] text-nebula-muted line-clamp-2">{t.description}</p>
                      <p className="text-[10px] text-nebula-muted mt-1.5">{t.agents} agents, {t.skills} skills, {t.tasks} tasks</p>
                    </button>
                  ))}
                </div>
              )}

              {/* Template preview */}
              {previewTemplate && (
                <div className="bg-nebula-bg border border-nebula-border rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h5 className="text-sm font-medium text-nebula-text">{previewTemplate.name}</h5>
                    <button onClick={() => setPreviewTemplate(null)} className="text-xs text-nebula-muted hover:text-nebula-text">&times; Close</button>
                  </div>
                  {previewTemplate.description && (
                    <p className="text-[12px] text-nebula-muted">{previewTemplate.description}</p>
                  )}

                  {/* Agents */}
                  <div>
                    <p className="text-[11px] text-nebula-muted font-medium mb-1">Agents</p>
                    <div className="space-y-1">
                      {previewTemplate.agents.map((a: any, i: number) => (
                        <div key={i} className="bg-nebula-surface border border-nebula-border rounded px-2.5 py-1.5">
                          <span className="text-[12px] text-nebula-text font-medium">{a.name}</span>
                          <span className="text-[10px] text-nebula-muted ml-2">{a.model}</span>
                          {a.tasks.length > 0 && <span className="text-[10px] text-nebula-accent ml-2">{a.tasks.length} tasks</span>}
                          <p className="text-[10px] text-nebula-muted mt-0.5 line-clamp-1">{a.role}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Org skills */}
                  {previewTemplate.skills.length > 0 && (
                    <div>
                      <p className="text-[11px] text-nebula-muted font-medium mb-1">Org-wide Skills</p>
                      <div className="flex flex-wrap gap-1">
                        {previewTemplate.skills.map((s: any, i: number) => (
                          <span key={i} className="text-[10px] bg-nebula-surface border border-nebula-border rounded px-2 py-0.5 text-nebula-muted">{s.name}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Required secrets */}
                  {(() => {
                    const allContent = [
                      ...previewTemplate.skills.map((s: any) => s.content),
                      ...previewTemplate.agents.flatMap((a: any) => a.skills.map((s: any) => s.content)),
                    ].join(' ');
                    const refs = [...new Set([...allContent.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map(m => m[1]))];
                    return refs.length > 0 ? (
                      <div>
                        <p className="text-[11px] text-yellow-400 font-medium mb-1">Required Secrets</p>
                        <div className="flex flex-wrap gap-1">
                          {refs.map(r => (
                            <code key={r} className="text-[10px] bg-yellow-900/20 border border-yellow-600/30 rounded px-2 py-0.5 text-yellow-400">{`{{${r}}}`}</code>
                          ))}
                        </div>
                        <p className="text-[10px] text-nebula-muted mt-1">Configure these in the Secrets tab after importing.</p>
                      </div>
                    ) : null;
                  })()}

                  <button
                    onClick={async () => {
                      try {
                        const result = await importTemplate(previewTemplate);
                        setImportStatus(`Imported: ${result.created.agents} agents, ${result.created.skills} skills, ${result.created.tasks} tasks`);
                        setPreviewTemplate(null);
                        setTimeout(() => setImportStatus(''), 5000);
                      } catch (err: any) { setError(err.message); }
                    }}
                    className="w-full py-2 text-xs bg-nebula-accent text-nebula-bg rounded hover:brightness-110 font-medium"
                  >
                    Apply Template
                  </button>
                </div>
              )}

              <p className="text-[10px] text-nebula-muted">Add custom templates to <code className="text-nebula-accent">/data/templates/</code> as JSON files.</p>
            </div>
          )}

          {tab === 'smtp' && (
            <div className="space-y-3">
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="text-xs text-nebula-muted block mb-1">SMTP Host</label>
                  <input value={settings.smtp_host || ''} onChange={e => updateSetting('smtp_host', e.target.value)} placeholder="smtp.gmail.com" className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent" />
                </div>
                <div className="w-24">
                  <label className="text-xs text-nebula-muted block mb-1">Port</label>
                  <input value={settings.smtp_port || '587'} onChange={e => updateSetting('smtp_port', e.target.value)} className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent" />
                </div>
              </div>
              <div>
                <label className="text-xs text-nebula-muted block mb-1">Username</label>
                <input value={settings.smtp_user || ''} onChange={e => updateSetting('smtp_user', e.target.value)} className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent" />
              </div>
              <div>
                <label className="text-xs text-nebula-muted block mb-1">Password</label>
                <input type="password" value={settings.smtp_pass || ''} onChange={e => updateSetting('smtp_pass', e.target.value)} className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent" />
              </div>
              <div>
                <label className="text-xs text-nebula-muted block mb-1">From Address</label>
                <input value={settings.smtp_from || ''} onChange={e => updateSetting('smtp_from', e.target.value)} placeholder="nebula@example.com" className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent" />
              </div>
              <div>
                <label className="text-xs text-nebula-muted block mb-1">Notify To</label>
                <input value={settings.notify_email_to || ''} onChange={e => updateSetting('notify_email_to', e.target.value)} placeholder="you@example.com" className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={settings.notifications_enabled === '1'} onChange={e => updateSetting('notifications_enabled', e.target.checked ? '1' : '0')} className="accent-nebula-accent" />
                Enable email notifications
              </label>

              <div className="pt-4 mt-4 border-t border-nebula-border">
                <h4 className="text-sm font-medium mb-3">Mail Access (IMAP — for agents)</h4>
                <p className="text-[11px] text-nebula-muted mb-3">Uses SMTP username/password above. Only need to set IMAP host.</p>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="text-xs text-nebula-muted block mb-1">IMAP Host</label>
                    <input value={settings.imap_host || ''} onChange={e => updateSetting('imap_host', e.target.value)} placeholder="imap.gmail.com" className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent" />
                  </div>
                  <div className="w-24">
                    <label className="text-xs text-nebula-muted block mb-1">Port</label>
                    <input value={settings.imap_port || '993'} onChange={e => updateSetting('imap_port', e.target.value)} className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent" />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm mt-3">
                  <input type="checkbox" checked={settings.mail_enabled === '1'} onChange={e => updateSetting('mail_enabled', e.target.checked ? '1' : '0')} className="accent-nebula-accent" />
                  Enable mail access for agents
                </label>
              </div>
            </div>
          )}

          {tab === 'runtimes' && (
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

              {runtimes.map(rt => (
                <div key={rt.id} className={`rounded-lg border ${rt.available ? 'border-nebula-border' : 'border-nebula-border/50'}`}>
                  {/* Header */}
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
                        {/* Detected — show path and auth status */}
                        <p className="text-[11px] text-nebula-muted font-mono">{rt.binaryPath}</p>
                        <div className="flex items-center gap-1.5 text-[11px]">
                          <span className={rt.auth.ok ? 'text-green-400' : 'text-red-400'}>
                            {rt.auth.ok ? 'Auth OK' : rt.auth.error || 'Auth issue'}
                          </span>
                          {!rt.auth.ok && rt.authGuide.command && (
                            <span className="text-nebula-muted">
                              — run: <code className="bg-nebula-bg px-1 rounded font-mono">{rt.authGuide.command}</code>
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
                      <>
                        {/* Not detected — show install instructions */}
                        <div className="bg-nebula-bg rounded-lg p-2.5 space-y-1.5">
                          <p className="text-[11px] text-nebula-muted">Not detected. Install:</p>
                          <code className="block text-[11px] text-nebula-text bg-nebula-surface px-2 py-1 rounded font-mono select-all">
                            {rt.install.command}
                          </code>
                          {rt.authGuide.description && (
                            <p className="text-[11px] text-nebula-muted">Then authenticate: {rt.authGuide.description}</p>
                          )}
                          {rt.authGuide.command && (
                            <code className="block text-[11px] text-nebula-text bg-nebula-surface px-2 py-1 rounded font-mono select-all">
                              {rt.authGuide.command}
                            </code>
                          )}
                          {rt.install.url && (
                            <a href={rt.install.url} target="_blank" rel="noopener noreferrer" className="text-[11px] text-nebula-accent hover:underline">
                              Documentation
                            </a>
                          )}
                        </div>

                        {/* Manual path override */}
                        <div className="space-y-1">
                          <p className="text-[11px] text-nebula-muted">Or specify the binary path manually:</p>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={runtimeCustomPaths[rt.id] ?? ''}
                              onChange={e => setRuntimeCustomPaths(prev => ({ ...prev, [rt.id]: e.target.value }))}
                              placeholder={`/path/to/${rt.id === 'claude-cli' ? 'claude' : 'opencode'}`}
                              className="flex-1 px-2 py-1.5 bg-nebula-bg border border-nebula-border rounded text-[11px] text-nebula-text font-mono focus:outline-none focus:border-nebula-accent/50"
                            />
                            <button
                              onClick={async () => {
                                const p = runtimeCustomPaths[rt.id]?.trim();
                                if (!p) return;
                                setRuntimePathSaving(prev => ({ ...prev, [rt.id]: true }));
                                setRuntimePathError(prev => ({ ...prev, [rt.id]: '' }));
                                try {
                                  await setRuntimePath(rt.id, p);
                                  await getRuntimes().then(r => { setRuntimes(r.runtimes); setRuntimeDefault(r.default); });
                                } catch (err: any) {
                                  setRuntimePathError(prev => ({ ...prev, [rt.id]: err.message }));
                                }
                                setRuntimePathSaving(prev => ({ ...prev, [rt.id]: false }));
                              }}
                              disabled={!runtimeCustomPaths[rt.id]?.trim() || runtimePathSaving[rt.id]}
                              className="px-2 py-1.5 text-[11px] bg-nebula-surface-2 border border-nebula-border rounded hover:bg-nebula-hover disabled:opacity-30 text-nebula-muted"
                            >
                              {runtimePathSaving[rt.id] ? '...' : 'Set'}
                            </button>
                          </div>
                          {runtimePathError[rt.id] && (
                            <p className="text-[10px] text-red-400">{runtimePathError[rt.id]}</p>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === 'knowledge' && (
            <div>
              <label className="text-xs text-nebula-muted block mb-2">Global CLAUDE.md — shared context for all agents</label>
              <textarea
                value={globalMd}
                onChange={e => setGlobalMd(e.target.value)}
                rows={20}
                className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text font-mono focus:outline-none focus:border-nebula-accent resize-y"
                spellCheck={false}
              />
            </div>
          )}

          {tab === 'skills' && <SkillEditor scope="org" onMutate={refreshSecrets} />}

          {tab === 'mcp' && <McpServerEditor scope="org" onMutate={refreshSecrets} />}

          {tab === 'secrets' && (
            <div className="space-y-4">
              <p className="text-xs text-nebula-muted">
                Store API tokens and credentials securely. Reference them in custom skills as <code className="text-nebula-accent">{'{{KEY_NAME}}'}</code> — values are resolved at runtime and never shown in the UI.
              </p>

              {/* Add new secret */}
              <div className="bg-nebula-bg border border-nebula-border rounded-lg p-3 space-y-2">
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className="text-[11px] text-nebula-muted block mb-1">Key</label>
                    <input
                      value={newSecretKey}
                      onChange={e => setNewSecretKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
                      placeholder="GITEA_TOKEN"
                      className="w-full px-3 py-2 bg-nebula-surface border border-nebula-border rounded text-sm text-nebula-text font-mono focus:outline-none focus:border-nebula-accent/50"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-[11px] text-nebula-muted block mb-1">Value</label>
                    <input
                      type="password"
                      value={newSecretValue}
                      onChange={e => setNewSecretValue(e.target.value)}
                      placeholder="token or password"
                      className="w-full px-3 py-2 bg-nebula-surface border border-nebula-border rounded text-sm text-nebula-text font-mono focus:outline-none focus:border-nebula-accent/50"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  {secretError && <p className="text-xs text-nebula-red">{secretError}</p>}
                  <div className="flex-1" />
                  <button
                    onClick={async () => {
                      if (!newSecretKey.trim() || !newSecretValue.trim()) {
                        setSecretError('Both key and value are required');
                        return;
                      }
                      setSecretSaving(true);
                      setSecretError('');
                      try {
                        await createSecret(newSecretKey, newSecretValue);
                        setNewSecretKey('');
                        setNewSecretValue('');
                        refreshSecrets();
                      } catch (err: any) {
                        setSecretError(err.message);
                      } finally {
                        setSecretSaving(false);
                      }
                    }}
                    disabled={secretSaving}
                    className="px-3 py-1.5 text-xs bg-nebula-accent text-nebula-bg rounded hover:brightness-110 disabled:opacity-50 font-medium"
                  >
                    {secretSaving ? 'Saving...' : 'Add Secret'}
                  </button>
                </div>
              </div>

              {/* Existing secrets */}
              {secrets.length === 0 ? (
                <p className="text-sm text-nebula-muted py-4 text-center">No secrets configured</p>
              ) : (
                <div className="space-y-1.5">
                  {secrets.map(s => (
                    <div key={s.id} className="flex items-center justify-between bg-nebula-bg border border-nebula-border rounded-lg px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <code className="text-sm text-nebula-accent font-mono">{`{{${s.key}}}`}</code>
                        <span className="text-[11px] text-nebula-muted ml-3">
                          {s.updated_at !== s.created_at ? 'updated' : 'added'} {new Date(s.updated_at).toLocaleDateString()}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-nebula-muted font-mono">••••••••</span>
                        <button
                          onClick={async () => {
                            if (!confirm(`Delete secret ${s.key}?`)) return;
                            try {
                            await deleteSecret(s.id);
                            refreshSecrets();
                            } catch (err: any) { setSecretError(err.message); return; }
                          }}
                          className="text-xs text-red-400 hover:text-red-300 px-1"
                        >
                          Del
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Discovered secret references — unconfigured */}
              {secretRefs.filter(r => !r.configured).length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs text-nebula-muted font-medium">Required by skills (not yet configured):</p>
                  {secretRefs.filter(r => !r.configured).map(r => (
                    <div key={r.key} className="flex items-center justify-between bg-nebula-bg border border-yellow-600/30 rounded-lg px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <code className="text-sm text-yellow-400 font-mono">{`{{${r.key}}}`}</code>
                        <span className="text-[11px] text-nebula-muted ml-3">
                          used by: {r.sources.map(s => s.name).join(', ')}
                        </span>
                      </div>
                      <button
                        onClick={() => { setNewSecretKey(r.key); }}
                        className="text-xs text-nebula-accent hover:brightness-110 px-2"
                      >
                        Configure
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="bg-nebula-surface-2 border border-nebula-border rounded-lg p-3 mt-4">
                <p className="text-xs text-nebula-muted mb-1.5 font-medium">Usage in custom skills:</p>
                <code className="text-[11px] text-nebula-accent block">curl -H "Authorization: Bearer {'{{GITEA_TOKEN}}'}" ...</code>
                <p className="text-[11px] text-nebula-muted mt-2">Secrets are replaced at execution time. The actual values never appear in conversation history, skill definitions, or the UI.</p>
              </div>
            </div>
          )}

          {tab === 'system' && (
            <div className="space-y-4">
              {status && (
                <div className="bg-nebula-bg border border-nebula-border rounded p-4 space-y-2 text-sm">
                  <p><span className="text-nebula-muted">Uptime:</span> {Math.floor(status.uptime / 3600)}h {Math.floor((status.uptime % 3600) / 60)}m</p>
                </div>
              )}

              <div>
                <button onClick={handleCheckAuth} className="px-3 py-2 text-sm bg-nebula-bg border border-nebula-border rounded hover:bg-nebula-hover">
                  Check CC Auth
                </button>
                {ccAuth && (
                  <p className={`text-sm mt-2 ${ccAuth.ok ? 'text-green-400' : 'text-red-400'}`}>
                    {ccAuth.ok ? `OK — ${ccAuth.version}` : `Error: ${ccAuth.error}`}
                  </p>
                )}
              </div>

              {/* Cleanup service */}
              <div className="pt-4 border-t border-nebula-border space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-medium">Cleanup Service</h4>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={settings.cleanup_enabled !== '0'}
                      onChange={e => updateSetting('cleanup_enabled', e.target.checked ? '1' : '0')}
                      className="accent-nebula-accent"
                    />
                    Enabled
                  </label>
                </div>
                <p className="text-[11px] text-nebula-muted">Automatically cleans orphaned CC CLI sessions and stale project worktrees on a schedule.</p>

                <div>
                  <label className="text-xs text-nebula-muted block mb-1">Schedule (cron expression)</label>
                  <input
                    value={settings.cleanup_cron || '0 3 * * *'}
                    onChange={e => updateSetting('cleanup_cron', e.target.value)}
                    placeholder="0 3 * * *"
                    className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text font-mono focus:outline-none focus:border-nebula-accent"
                  />
                  <p className="text-[10px] text-nebula-muted mt-1">Default: <code>0 3 * * *</code> (daily at 3:00 AM). Format: minute hour day month weekday</p>
                </div>

                <div className="flex gap-4">
                  <label className="flex items-center gap-2 text-[12px] text-nebula-text">
                    <input
                      type="checkbox"
                      checked={settings.cleanup_sessions !== '0'}
                      onChange={e => updateSetting('cleanup_sessions', e.target.checked ? '1' : '0')}
                      className="accent-nebula-accent"
                    />
                    Stale CC sessions
                  </label>
                  <label className="flex items-center gap-2 text-[12px] text-nebula-text">
                    <input
                      type="checkbox"
                      checked={settings.cleanup_worktrees !== '0'}
                      onChange={e => updateSetting('cleanup_worktrees', e.target.checked ? '1' : '0')}
                      className="accent-nebula-accent"
                    />
                    Stale worktrees
                  </label>
                  <label className="flex items-center gap-2 text-[12px] text-nebula-text">
                    <input
                      type="checkbox"
                      checked={settings.cleanup_dreaming !== '0'}
                      onChange={e => updateSetting('cleanup_dreaming', e.target.checked ? '1' : '0')}
                      className="accent-nebula-accent"
                    />
                    Agent dreaming
                  </label>
                </div>
                <p className="text-[10px] text-nebula-muted -mt-1">Dreaming: each agent reviews and prunes stale CLAUDE.md entries, memories, and temp files during cleanup.</p>

                <div className="flex items-center gap-3">
                  <button
                    onClick={async () => {
                      setCleanupRunning(true);
                      try {
                        await runCleanup();
                        const s = await getCleanupStatus();
                        setCleanupStatus(s);
                      } catch (err: any) { setError(err.message); }
                      finally { setCleanupRunning(false); }
                    }}
                    disabled={cleanupRunning}
                    className="px-3 py-1.5 text-xs bg-nebula-surface-2 border border-nebula-border rounded hover:bg-nebula-hover text-nebula-muted disabled:opacity-50"
                  >
                    {cleanupRunning ? 'Running...' : 'Run Now'}
                  </button>
                  <button
                    onClick={async () => {
                      try {
                        const s = await getCleanupStatus();
                        setCleanupStatus(s);
                      } catch {}
                    }}
                    className="text-[11px] text-nebula-muted hover:text-nebula-text"
                  >
                    Refresh status
                  </button>
                </div>

                {cleanupStatus && (
                  <div className="bg-nebula-bg border border-nebula-border rounded-lg p-3 text-[12px] space-y-1">
                    {cleanupStatus.nextRun && (
                      <p className="text-nebula-muted">Next run: <span className="text-nebula-text">{new Date(cleanupStatus.nextRun).toLocaleString()}</span></p>
                    )}
                    {cleanupStatus.lastResult && (
                      <>
                        <p className="text-nebula-muted">Last run: <span className="text-nebula-text">{new Date(cleanupStatus.lastResult.timestamp).toLocaleString()}</span></p>
                        {cleanupStatus.lastResult.sessions && (
                          <p className="text-nebula-muted">Sessions: <span className="text-nebula-text">{cleanupStatus.lastResult.sessions.deleted} deleted / {cleanupStatus.lastResult.sessions.scanned} scanned</span></p>
                        )}
                        {cleanupStatus.lastResult.worktrees && (
                          <p className="text-nebula-muted">Worktrees: <span className="text-nebula-text">{cleanupStatus.lastResult.worktrees.deleted} removed{cleanupStatus.lastResult.worktrees.removed.length > 0 ? ` (${cleanupStatus.lastResult.worktrees.removed.join(', ')})` : ''}</span></p>
                        )}
                        {cleanupStatus.lastResult.dreaming && (
                          <p className="text-nebula-muted">Dreaming: <span className="text-nebula-text">{cleanupStatus.lastResult.dreaming.triggered} agent(s) triggered</span></p>
                        )}
                      </>
                    )}
                    {!cleanupStatus.lastResult && <p className="text-nebula-muted">No cleanup has run yet</p>}
                  </div>
                )}
              </div>
            </div>
          )}

          {error && <p className="text-red-400 text-sm mt-4">{error}</p>}

          <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-nebula-border">
            <button onClick={onClose} className="px-4 py-2 text-sm text-nebula-muted hover:text-nebula-text">Close</button>
            <button onClick={handleSave} disabled={saving} className="px-4 py-2 text-sm bg-nebula-accent text-white rounded hover:opacity-90 disabled:opacity-50">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
    </Modal>
  );
}
