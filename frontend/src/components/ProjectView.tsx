import { useState, useEffect, useCallback, useMemo } from 'react';
import ChatPanel from './ChatPanel';
import TaskList from './TaskList';
import SecretsList from './SecretsList';
import MarkdownViewer from './MarkdownViewer';
import {
  Project, Agent, ProjectMilestone, ProjectDeliverable, ProjectDashboard, ProjectLink, ProjectAgent, Message,
  getProject, getProjectMilestones, getProjectDashboard, getProjectMessages, sendProjectMessage, markProjectMessagesRead,
  createMilestone, updateMilestone, deleteMilestone,
  createDeliverable, updateDeliverable, deleteDeliverable,
  getProjectVault, getProjectVaultFile, updateVaultFile,
  updateProject, deleteProject,
  getProjectLinks, addProjectLink, removeProjectLink,
  getProjectAgents, assignProjectAgent, updateProjectAgent, removeProjectAgent,
  getProjectSecrets, createProjectSecret, deleteProjectSecret,
  getProjectReadiness, ReadinessResult, createChecklistItem, updateChecklistItem, deleteChecklistItem, testProjectWebhook,
  launchProject,
} from '../api/client';

type Tab = 'overview' | 'milestones' | 'conversation' | 'tasks' | 'vault' | 'secrets' | 'settings';

interface Props {
  projectId: string;
  agents: Agent[];
  typingAgents: Map<string, { conversationId: string; projectId?: string }>;
  connected?: boolean;
  onProjectDeleted?: () => void;
  onRead?: () => void;
  onOpenSidebar?: () => void;
  subscribe?: (cb: (msg: any) => void) => () => void;
  scrollToMessageId?: string | null;
  onScrollToComplete?: () => void;
}

export default function ProjectView({ projectId, agents, typingAgents, connected, onProjectDeleted, onRead, onOpenSidebar, subscribe, scrollToMessageId, onScrollToComplete }: Props) {
  const [tab, setTab] = useState<Tab>(scrollToMessageId ? 'conversation' : 'overview');

  // Switch to conversation tab when navigated from global search
  useEffect(() => {
    if (scrollToMessageId) setTab('conversation');
  }, [scrollToMessageId]);
  const [project, setProject] = useState<Project | null>(null);
  const [milestones, setMilestones] = useState<ProjectMilestone[]>([]);
  const [dashboard, setDashboard] = useState<ProjectDashboard | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [vaultFiles, setVaultFiles] = useState<string[]>([]);
  const [vaultContent, setVaultContent] = useState<{ path: string; content: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [readiness, setReadiness] = useState<ReadinessResult | null>(null);

  // Load project detail + readiness
  useEffect(() => {
    getProject(projectId).then(p => {
      setProject(p);
      setReadiness(p.readiness || null);
    }).catch(console.error);
  }, [projectId]);

  // Load tab-specific data
  useEffect(() => {
    if (tab === 'milestones' || tab === 'overview') {
      getProjectMilestones(projectId).then(setMilestones).catch(console.error);
    }
    if (tab === 'overview') {
      getProjectDashboard(projectId).then(setDashboard).catch(console.error);
    }
    if (tab === 'conversation') {
      getProjectMessages(projectId, 100).then(setMessages).catch(console.error);
      markProjectMessagesRead(projectId).then(() => {
        getProject(projectId).then(setProject).catch(() => {});
        onRead?.();
      }).catch(() => {});
    }
    if (tab === 'vault') {
      getProjectVault(projectId).then(setVaultFiles).catch(() => setVaultFiles([]));
      setVaultContent(null);
    }
  }, [projectId, tab]);

  const addMessage = useCallback((msg: Message) => {
    setMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg]);
  }, []);

  // WebSocket: real-time message updates for this project
  useEffect(() => {
    if (!subscribe) return;
    return subscribe((msg: any) => {
      if (msg.type === 'new_message' && msg.project_id === projectId && msg.message) {
        addMessage(msg.message);
        // Auto-mark as read if the conversation tab is active
        if (tab === 'conversation') {
          markProjectMessagesRead(projectId).then(() => onRead?.()).catch(() => {});
        }
      }
    });
  }, [subscribe, projectId, addMessage, tab, onRead]);

  // Derive typing names from the shared typingAgents map (survives refresh via WS snapshot)
  const projectTypingNames = useMemo(() => {
    const names: string[] = [];
    for (const [agentId, info] of typingAgents) {
      if (info.projectId === projectId) {
        const a = agents.find(x => x.id === agentId);
        if (a) names.push(`${a.emoji} ${a.name}`);
      }
    }
    return names;
  }, [typingAgents, projectId, agents]);

  const handleSendMessage = async (content: string, _images?: File[], replyToId?: string) => {
    // TODO: image upload support for project conversations
    const msg = await sendProjectMessage(projectId, content, undefined, replyToId);
    addMessage(msg);
  };

  const agentName = (id: string | null) => {
    if (!id) return 'System';
    const a = agents.find(a => a.id === id);
    return a ? `${a.emoji} ${a.name}` : id.slice(0, 8);
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'not_ready': return 'bg-nebula-red/20 text-nebula-red';
      case 'active': return 'bg-nebula-green/20 text-nebula-green';
      case 'done': case 'complete': return 'bg-nebula-green/20 text-nebula-green';
      case 'in_progress': return 'bg-nebula-accent/20 text-nebula-accent';
      case 'blocked': case 'paused': return 'bg-nebula-red/20 text-nebula-red';
      case 'archived': return 'bg-nebula-muted/20 text-nebula-muted';
      default: return 'bg-nebula-muted/20 text-nebula-muted';
    }
  };

  if (!project) return <div className="flex-1 flex items-center justify-center text-nebula-muted">Loading...</div>;

  const unread = project.unread_count || 0;
  const isReady = project.status !== 'not_ready';
  const disabledTabs = isReady ? new Set<Tab>() : new Set<Tab>(['milestones', 'tasks']);
  const tabs: { key: Tab; label: string; badge?: number }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'milestones', label: 'Milestones' },
    { key: 'conversation', label: 'Conversation', badge: unread },
    { key: 'tasks', label: 'Tasks' },
    { key: 'vault', label: 'Vault' },
    { key: 'secrets', label: 'Secrets' },
    { key: 'settings', label: 'Settings' },
  ];

  return (
    <div className="flex-1 flex flex-col h-full bg-nebula-bg">
      {/* Header */}
      <div className="border-b border-nebula-border px-4 sm:px-6 py-4">
        <div className="flex items-center gap-3 mb-3">
          <button onClick={onOpenSidebar} className="md:hidden p-1.5 -ml-1 text-nebula-muted hover:text-nebula-text rounded-lg hover:bg-nebula-hover">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
          </button>
          <div className="w-8 h-8 rounded-lg bg-nebula-accent/10 flex items-center justify-center text-nebula-accent font-bold text-sm">
            P
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-nebula-text truncate">{project.name}</h2>
            <p className="text-[11px] text-nebula-muted truncate">{project.git_remote_url}</p>
          </div>
          <span className={`ml-auto text-[10px] px-2 py-0.5 rounded-full ${statusColor(project.status)}`}>
            {project.status}
          </span>
        </div>
        {/* Tabs */}
        <div className="flex gap-1 overflow-x-auto scrollbar-hide">
          {tabs.map(t => {
            const disabled = disabledTabs.has(t.key);
            return (
            <button
              key={t.key}
              onClick={() => !disabled && setTab(t.key)}
              disabled={disabled}
              className={`px-3 py-1.5 text-[12px] rounded-md transition-colors whitespace-nowrap shrink-0 ${
                disabled
                  ? 'text-nebula-muted/30 cursor-not-allowed'
                  : tab === t.key
                    ? 'bg-nebula-accent/15 text-nebula-accent font-medium'
                    : 'text-nebula-muted hover:text-nebula-text hover:bg-nebula-hover'
              }`}
              title={disabled ? 'Project must be ready before using this tab' : undefined}
            >
              {t.label}
              {t.badge ? (
                <span className="ml-1 bg-nebula-accent text-nebula-bg text-[9px] font-bold px-1 py-0 rounded-full min-w-[14px] text-center">
                  {t.badge}
                </span>
              ) : null}
            </button>
            );
          })}
        </div>
      </div>

      {/* Conversation tab rendered as direct flex child (ChatPanel manages its own scroll) */}
      {tab === 'conversation' && (
        <ConversationTab
          messages={messages} agents={agents} onSend={handleSendMessage} projectId={projectId}
          typingNames={projectTypingNames}
          connected={connected}
          draft={draft}
          onDraftChange={setDraft}
          scrollToMessageId={scrollToMessageId}
          onScrollToComplete={onScrollToComplete}
        />
      )}
      {/* Other tabs use a scroll wrapper */}
      {tab !== 'conversation' && (
        <div className="flex-1 overflow-y-auto">
          {tab === 'overview' && <OverviewTab project={project} milestones={milestones} dashboard={dashboard} readiness={readiness} agentName={agentName} statusColor={statusColor} onReadinessRefresh={() => getProjectReadiness(projectId).then(r => { setReadiness(r); getProject(projectId).then(setProject); })} />}
          {tab === 'milestones' && <MilestonesTab projectId={projectId} milestones={milestones} agents={agents} setMilestones={setMilestones} agentName={agentName} statusColor={statusColor} />}
          {tab === 'tasks' && project.coordinator_agent_id && (
            <div className="p-6">
              <TaskList agentId={project.coordinator_agent_id} projectId={projectId} />
            </div>
          )}
          {tab === 'tasks' && !project.coordinator_agent_id && (
            <div className="p-6 text-sm text-nebula-muted">Assign a coordinator agent to manage project tasks.</div>
          )}
          {tab === 'secrets' && (
            <div className="p-6">
              <div className="bg-nebula-surface border border-nebula-border rounded-lg p-4">
                <h3 className="text-[13px] font-semibold text-nebula-text mb-1">Project Secrets</h3>
                <p className="text-[11px] text-nebula-muted mb-3">Write-only secrets available to agents in project context. Referenced as {'{{KEY}}'} in skills and MCP configs. Agent-scoped secrets are NOT inherited — project secrets are isolated.</p>
                <SecretsList
                  load={() => getProjectSecrets(projectId)}
                  create={(key, value) => createProjectSecret(projectId, key, value)}
                  remove={(secretId) => deleteProjectSecret(projectId, secretId)}
                />
              </div>
            </div>
          )}
          {tab === 'vault' && <VaultTab projectId={projectId} files={vaultFiles} content={vaultContent} setContent={setVaultContent} />}
          {tab === 'settings' && <SettingsTab project={project} agents={agents} onUpdated={() => getProject(projectId).then(setProject)} onDeleted={onProjectDeleted} />}
        </div>
      )}
    </div>
  );
}

// ==================== Tab Components ====================

function OverviewTab({ project, milestones, dashboard, readiness, agentName, statusColor, onReadinessRefresh }: {
  project: Project; milestones: ProjectMilestone[]; dashboard: ProjectDashboard | null; readiness: ReadinessResult | null;
  agentName: (id: string | null) => string; statusColor: (s: string) => string; onReadinessRefresh?: () => void;
}) {
  const [webhookTesting, setWebhookTesting] = useState(false);
  const [webhookResult, setWebhookResult] = useState<string | null>(null);
  const [editingSpec, setEditingSpec] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const totalDeliverables = milestones.reduce((sum, m) => sum + (m.deliverables?.length || 0), 0);
  const doneDeliverables = milestones.reduce((sum, m) => sum + (m.deliverables?.filter(d => d.status === 'done').length || 0), 0);
  const progress = totalDeliverables > 0 ? Math.round((doneDeliverables / totalDeliverables) * 100) : 0;
  const isNotReady = project.status === 'not_ready';

  return (
    <div className="p-6 space-y-6">
      {project.description && <p className="text-[13px] text-nebula-text/80">{project.description}</p>}

      {/* Readiness checklist — always visible */}
      {readiness && (
        <div className={`rounded-lg p-4 ${isNotReady ? 'bg-nebula-red/5 border border-nebula-red/20' : 'bg-nebula-surface border border-nebula-border'}`}>
          <div className="flex items-center justify-between mb-3">
            <h3 className={`text-[13px] font-semibold ${isNotReady ? 'text-nebula-red' : 'text-nebula-text'}`}>
              {isNotReady ? 'Project Not Ready' : 'Readiness Status'}
            </h3>
            <button onClick={onReadinessRefresh} className="text-[11px] text-nebula-muted hover:text-nebula-text">Refresh</button>
          </div>
          {isNotReady && <p className="text-[11px] text-nebula-muted mb-3">All prerequisites must be met before the project can be launched.</p>}
          <div className="space-y-2">
            {readiness.systemChecks.map(c => (
              <div key={c.key}>
                <div className="flex items-center gap-2">
                  <span className={`text-[12px] ${c.met ? 'text-nebula-green' : 'text-nebula-red'}`}>{c.met ? '\u2713' : '\u2717'}</span>
                  <span className={`text-[12px] ${c.met ? 'text-nebula-muted' : 'text-nebula-text'} flex-1`}>{c.label}</span>
                  {/* Spec file buttons — edit when not_ready, view when active */}
                  {(c.key === 'design_spec' || c.key === 'tech_spec') && (isNotReady || c.met) && (
                    <button onClick={() => setEditingSpec(c.key === 'design_spec' ? 'design-spec.md' : 'tech-spec.md')}
                      className="text-[10px] px-2 py-0.5 bg-nebula-surface border border-nebula-border rounded hover:bg-nebula-hover">
                      {isNotReady ? (c.met ? 'Edit' : 'Create') : 'View'}
                    </button>
                  )}
                  {/* Webhook test button */}
                  {c.key === 'webhook' && !c.met && (
                    <button onClick={async () => {
                        setWebhookTesting(true); setWebhookResult(null);
                        try { const res = await testProjectWebhook(project.id); setWebhookResult(res.message); if (res.ok) onReadinessRefresh?.(); }
                        catch (err: any) { setWebhookResult(err.message); }
                        finally { setWebhookTesting(false); }
                      }} disabled={webhookTesting}
                      className="text-[10px] px-2 py-0.5 bg-nebula-surface border border-nebula-border rounded hover:bg-nebula-hover disabled:opacity-50">
                      {webhookTesting ? 'Testing...' : 'Test'}
                    </button>
                  )}
                </div>
                {c.key === 'webhook' && !c.met && (
                  <div className="ml-5 mt-1">
                    <p className="text-[10px] text-nebula-muted">Webhook URL:</p>
                    <code className="text-[10px] text-nebula-accent break-all select-all block mt-0.5">
                      {window.location.origin}/api/project-webhooks/{project.id}/ci
                    </code>
                    {webhookResult && <p className={`text-[10px] mt-1 ${webhookResult.includes('success') ? 'text-nebula-green' : 'text-nebula-red/80'}`}>{webhookResult}</p>}
                  </div>
                )}
              </div>
            ))}
            {readiness.agentChecks.map(c => (
              <div key={c.id} className="flex items-center gap-2">
                <span className={`text-[12px] ${c.met ? 'text-nebula-green' : 'text-nebula-red'}`}>{c.met ? '\u2713' : '\u2717'}</span>
                <span className={`text-[12px] ${c.met ? 'text-nebula-muted' : 'text-nebula-text'}`}>{c.label}</span>
                <span className="text-[9px] text-nebula-muted/50">custom</span>
              </div>
            ))}
          </div>
          {/* Launch button — only when not_ready and all checks pass */}
          {isNotReady && readiness.ready && (
            <button onClick={async () => {
                setLaunching(true);
                try { await launchProject(project.id); onReadinessRefresh?.(); }
                catch (err: any) { setWebhookResult(err.message); }
                finally { setLaunching(false); }
              }} disabled={launching}
              className="w-full mt-4 py-2.5 bg-nebula-accent text-nebula-bg rounded-lg font-semibold text-[13px] hover:brightness-110 disabled:opacity-50 shadow-glow">
              {launching ? 'Launching...' : 'Launch Project'}
            </button>
          )}
        </div>
      )}

      {/* Spec editor modal */}
      {editingSpec && (
        <SpecEditorView projectId={project.id} filePath={editingSpec} isNotReady={isNotReady}
          onClose={() => setEditingSpec(null)} onSaved={onReadinessRefresh} />
      )}

      <div className="grid grid-cols-3 gap-4">
        <div className="bg-nebula-surface border border-nebula-border rounded-lg p-4">
          <p className="text-[11px] text-nebula-muted mb-1">Progress</p>
          <p className="text-2xl font-bold text-nebula-accent">{progress}%</p>
          <p className="text-[11px] text-nebula-muted mt-1">{doneDeliverables}/{totalDeliverables} deliverables</p>
          <div className="w-full bg-nebula-bg rounded-full h-1.5 mt-2">
            <div className="bg-nebula-accent rounded-full h-1.5 transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
        <div className="bg-nebula-surface border border-nebula-border rounded-lg p-4">
          <p className="text-[11px] text-nebula-muted mb-1">Milestones</p>
          <p className="text-2xl font-bold text-nebula-text">{milestones.filter(m => m.status === 'done').length}/{milestones.length}</p>
        </div>
        <div className="bg-nebula-surface border border-nebula-border rounded-lg p-4">
          <p className="text-[11px] text-nebula-muted mb-1">Coordinator</p>
          <p className="text-sm text-nebula-text">{agentName(project.coordinator_agent_id)}</p>
        </div>
      </div>

      {milestones.length > 0 && (
        <div>
          <h3 className="text-[13px] font-semibold text-nebula-text mb-3">Milestones</h3>
          <div className="space-y-2">
            {milestones.map(m => {
              const total = m.deliverables?.length || 0;
              const done = m.deliverables?.filter(d => d.status === 'done').length || 0;
              const mProgress = total > 0 ? Math.round((done / total) * 100) : 0;
              return (
                <div key={m.id} className="bg-nebula-surface border border-nebula-border rounded-lg p-3">
                  <div className="flex items-center gap-3 mb-2">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${statusColor(m.status)}`}>{m.status}</span>
                    <span className="text-[13px] text-nebula-text flex-1">{m.name}</span>
                    <span className="text-[11px] text-nebula-muted">{done}/{total}</span>
                    <span className="text-[11px] text-nebula-muted">{mProgress}%</span>
                  </div>
                  <div className="w-full bg-nebula-bg rounded-full h-1">
                    <div className="bg-nebula-accent rounded-full h-1 transition-all" style={{ width: `${mProgress}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Agent activity */}
      {dashboard && dashboard.agent_activity.length > 0 && (
        <div>
          <h3 className="text-[13px] font-semibold text-nebula-text mb-3">Agent Activity</h3>
          <div className="space-y-2">
            {dashboard.agent_activity.map(a => (
              <div key={a.agent_id} className="bg-nebula-surface border border-nebula-border rounded-lg p-3 flex items-center gap-3">
                <span className="text-base">{a.agent_emoji}</span>
                <span className="text-[12px] text-nebula-text flex-1">{a.agent_name}</span>
                <span className="text-[11px] text-nebula-muted">{a.message_count} messages</span>
                <span className="text-[10px] text-nebula-muted">{new Date(a.last_active).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MilestonesTab({ projectId, milestones, agents, setMilestones, agentName, statusColor }: {
  projectId: string; milestones: ProjectMilestone[]; agents: Agent[];
  setMilestones: (m: ProjectMilestone[]) => void; agentName: (id: string | null) => string; statusColor: (s: string) => string;
}) {
  const [newMilestoneName, setNewMilestoneName] = useState('');
  const [expandedMilestone, setExpandedMilestone] = useState<string | null>(null);
  const [newDeliverableName, setNewDeliverableName] = useState('');

  const handleAddMilestone = async () => {
    if (!newMilestoneName.trim()) return;
    try {
      await createMilestone(projectId, { name: newMilestoneName.trim() });
      setNewMilestoneName('');
      const updated = await getProjectMilestones(projectId);
      setMilestones(updated);
    } catch (err) {
      console.error(err);
    }
  };

  const handleAddDeliverable = async (milestoneId: string) => {
    if (!newDeliverableName.trim()) return;
    try {
      await createDeliverable(milestoneId, { name: newDeliverableName.trim() });
      setNewDeliverableName('');
      const updated = await getProjectMilestones(projectId);
      setMilestones(updated);
    } catch (err) {
      console.error(err);
    }
  };

  const handleUpdateStatus = async (type: 'milestone' | 'deliverable', id: string, status: string) => {
    try {
      if (type === 'milestone') await updateMilestone(id, { status } as any);
      else await updateDeliverable(id, { status } as any);
      const updated = await getProjectMilestones(projectId);
      setMilestones(updated);
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="p-6 space-y-4">
      {/* Add milestone */}
      <div className="flex gap-2">
        <input
          value={newMilestoneName} onChange={e => setNewMilestoneName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAddMilestone()}
          className="flex-1 px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent"
          placeholder="New milestone name..."
        />
        <button onClick={handleAddMilestone} className="px-4 py-2 text-sm bg-nebula-accent text-nebula-bg rounded hover:brightness-110 font-medium transition-all">
          Add
        </button>
      </div>

      {milestones.map(m => (
        <div key={m.id} className="bg-nebula-surface border border-nebula-border rounded-lg">
          <div
            className="p-4 flex items-center gap-3 cursor-pointer hover:bg-nebula-hover transition-colors"
            onClick={() => setExpandedMilestone(expandedMilestone === m.id ? null : m.id)}
          >
            <svg className={`w-4 h-4 text-nebula-muted transition-transform ${expandedMilestone === m.id ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>
            <span className="text-[13px] font-medium text-nebula-text flex-1">{m.name}</span>
            <select
              value={m.status}
              onChange={e => { e.stopPropagation(); handleUpdateStatus('milestone', m.id, e.target.value); }}
              onClick={e => e.stopPropagation()}
              className={`text-[10px] px-2 py-0.5 rounded-full border-0 cursor-pointer ${statusColor(m.status)}`}
            >
              <option value="pending">pending</option>
              <option value="in_progress">in_progress</option>
              <option value="done">done</option>
            </select>
            <span className="text-[11px] text-nebula-muted">{m.deliverables?.length || 0}</span>
          </div>

          {expandedMilestone === m.id && (
            <div className="border-t border-nebula-border px-4 pb-4">
              {m.deliverables?.map(d => (
                <div key={d.id} className="flex items-center gap-3 py-2 border-b border-nebula-border/50 last:border-0">
                  <select
                    value={d.status}
                    onChange={e => handleUpdateStatus('deliverable', d.id, e.target.value)}
                    className={`text-[10px] px-2 py-0.5 rounded-full border-0 cursor-pointer ${statusColor(d.status)}`}
                  >
                    <option value="pending">pending</option>
                    <option value="in_progress">in_progress</option>
                    <option value="done">done</option>
                    <option value="blocked">blocked</option>
                  </select>
                  <span className="text-[12px] text-nebula-text flex-1">{d.name}</span>
                  {d.branch_name && <span className="text-[10px] text-nebula-muted font-mono">{d.branch_name}</span>}
                  {d.assigned_agent_id && <span className="text-[10px] text-nebula-muted">{agentName(d.assigned_agent_id)}</span>}
                </div>
              ))}

              <div className="flex gap-2 mt-3">
                <input
                  value={newDeliverableName} onChange={e => setNewDeliverableName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddDeliverable(m.id)}
                  className="flex-1 px-3 py-1.5 bg-nebula-bg border border-nebula-border rounded text-[12px] text-nebula-text focus:outline-none focus:border-nebula-accent"
                  placeholder="New deliverable..."
                />
                <button onClick={() => handleAddDeliverable(m.id)} className="px-3 py-1.5 text-[12px] bg-nebula-accent/20 text-nebula-accent rounded hover:bg-nebula-accent/30 transition-colors">
                  Add
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ConversationTab({ messages, agents, onSend, typingNames = [], projectId, connected, draft, onDraftChange, scrollToMessageId, onScrollToComplete }: {
  messages: Message[]; agents: Agent[]; onSend: (content: string) => Promise<void>;
  typingNames?: string[];
  projectId: string;
  connected?: boolean;
  draft?: string;
  onDraftChange?: (v: string) => void;
  scrollToMessageId?: string | null;
  onScrollToComplete?: () => void;
}) {
  return (
    <ChatPanel
      messages={messages}
      agents={agents}
      typingNames={typingNames}
      onSend={onSend}
      disabled={connected === false}
      disconnected={connected === false}
      resetKey={projectId}
      hideNotify
      draft={draft}
      onDraftChange={onDraftChange}
      scrollToMessageId={scrollToMessageId}
      onScrollToComplete={onScrollToComplete}
    />
  );
}

function SpecEditorView({ projectId, filePath, isNotReady, onClose, onSaved }: {
  projectId: string; filePath: string; isNotReady: boolean; onClose: () => void; onSaved?: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    getProjectVaultFile(projectId, filePath)
      .then(setContent)
      .catch(() => setContent(''));
  }, [projectId, filePath]);
  if (content === null) return null;
  return (
    <MarkdownViewer
      initialContent={content}
      filePath={filePath}
      editable={isNotReady}
      onSave={isNotReady ? async (text) => { await updateVaultFile(projectId, filePath, text); onSaved?.(); } : undefined}
      onClose={onClose}
    />
  );
}

function VaultTab({ projectId, files, content, setContent }: {
  projectId: string; files: string[];
  content: { path: string; content: string } | null;
  setContent: (c: { path: string; content: string } | null) => void;
}) {
  const [mdViewing, setMdViewing] = useState<{ path: string; content: string } | null>(null);

  const openFile = async (filePath: string) => {
    try {
      const text = await getProjectVaultFile(projectId, filePath);
      if (filePath.endsWith('.md')) {
        setMdViewing({ path: filePath, content: text });
      } else {
        setContent({ path: filePath, content: text });
      }
    } catch (err) {
      console.error(err);
    }
  };

  if (content) {
    return (
      <div className="p-6">
        <button onClick={() => setContent(null)} className="text-[12px] text-nebula-accent hover:underline mb-3 flex items-center gap-1">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          Back to files
        </button>
        <div className="bg-nebula-surface border border-nebula-border rounded-lg p-4">
          <p className="text-[11px] text-nebula-muted font-mono mb-3">{content.path}</p>
          <pre className="text-[12px] text-nebula-text whitespace-pre-wrap font-mono leading-relaxed">{content.content}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {files.length === 0 ? (
        <p className="text-center text-nebula-muted text-sm py-12">No files in vault yet</p>
      ) : (
        <div className="space-y-1">
          {files.map(f => (
            <button
              key={f} onClick={() => openFile(f)}
              className="w-full text-left px-4 py-2.5 bg-nebula-surface border border-nebula-border rounded-lg hover:bg-nebula-hover transition-colors flex items-center gap-3"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-nebula-muted"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              <span className="text-[13px] text-nebula-text font-mono">{f}</span>
            </button>
          ))}
        </div>
      )}
      {mdViewing && (
        <MarkdownViewer
          initialContent={mdViewing.content}
          filePath={mdViewing.path}
          onClose={() => setMdViewing(null)}
        />
      )}
    </div>
  );
}

function SettingsTab({ project, agents, onUpdated, onDeleted }: {
  project: Project; agents: Agent[];
  onUpdated: () => void; onDeleted?: () => void;
}) {
  const [autoMerge, setAutoMerge] = useState(!!project.auto_merge);
  const [links, setLinks] = useState<ProjectLink[]>([]);
  const [projectAgents, setProjectAgents] = useState<ProjectAgent[]>([]);
  const [newLinkType, setNewLinkType] = useState<'issue_tracker' | 'knowledge_base' | 'ci'>('issue_tracker');
  const [newLinkProvider, setNewLinkProvider] = useState('');
  const [newLinkUrl, setNewLinkUrl] = useState('');
  const [assignAgentId, setAssignAgentId] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    getProjectLinks(project.id).then(setLinks).catch(console.error);
    getProjectAgents(project.id).then(setProjectAgents).catch(console.error);
  }, [project.id]);

  const handleToggleAutoMerge = async () => {
    const next = !autoMerge;
    setAutoMerge(next);
    await updateProject(project.id, { auto_merge: next ? 1 : 0 } as any);
    onUpdated();
  };

  const handleAddLink = async () => {
    if (!newLinkProvider.trim() || !newLinkUrl.trim()) return;
    await addProjectLink(project.id, { type: newLinkType, provider: newLinkProvider.trim(), url: newLinkUrl.trim() });
    setNewLinkProvider(''); setNewLinkUrl('');
    getProjectLinks(project.id).then(setLinks);
  };

  const handleRemoveLink = async (linkId: string) => {
    await removeProjectLink(project.id, linkId);
    getProjectLinks(project.id).then(setLinks);
  };

  const handleAssignAgent = async () => {
    if (!assignAgentId) return;
    await assignProjectAgent(project.id, { agent_id: assignAgentId });
    setAssignAgentId('');
    getProjectAgents(project.id).then(setProjectAgents);
  };

  const handleRemoveAgent = async (agentId: string) => {
    await removeProjectAgent(project.id, agentId);
    getProjectAgents(project.id).then(setProjectAgents);
  };

  const handleUpdateConcurrency = async (agentId: string, maxConcurrent: number) => {
    await updateProjectAgent(project.id, agentId, { max_concurrent: maxConcurrent } as any);
    getProjectAgents(project.id).then(setProjectAgents);
  };

  const handleDelete = async () => {
    await deleteProject(project.id);
    onDeleted?.();
  };

  const assignedIds = new Set(projectAgents.map(a => a.agent_id));
  const availableAgents = agents.filter(a => a.enabled && !assignedIds.has(a.id));

  const providerOptions: Record<string, string[]> = {
    issue_tracker: ['youtrack', 'jira', 'github_issues', 'gitea_issues'],
    knowledge_base: ['youtrack_kb', 'confluence', 'notion'],
    ci: ['teamcity', 'gitea_actions', 'github_actions'],
  };

  return (
    <div className="p-6 space-y-6">
      {/* Auto-merge */}
      <div className="bg-nebula-surface border border-nebula-border rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[13px] font-medium text-nebula-text">Auto-merge</p>
            <p className="text-[11px] text-nebula-muted mt-0.5">Automatically merge PRs when CI passes</p>
          </div>
          <button
            onClick={handleToggleAutoMerge}
            className={`w-10 h-5 rounded-full transition-colors relative ${autoMerge ? 'bg-nebula-accent' : 'bg-nebula-bg border border-nebula-border'}`}
          >
            <div className={`w-4 h-4 rounded-full bg-white absolute top-0.5 transition-all ${autoMerge ? 'left-5' : 'left-0.5'}`} />
          </button>
        </div>
      </div>

      {/* Agent assignments */}
      <div className="bg-nebula-surface border border-nebula-border rounded-lg p-4">
        <h3 className="text-[13px] font-semibold text-nebula-text mb-3">Assigned Agents</h3>
        <div className="space-y-2 mb-3">
          {projectAgents.map(pa => (
            <div key={pa.agent_id} className="flex flex-wrap items-center gap-2 sm:gap-3 py-2 border-b border-nebula-border/50 last:border-0">
              <span className="text-base">{pa.agent_emoji}</span>
              <span className="text-[12px] text-nebula-text flex-1 min-w-[80px]">{pa.agent_name}</span>
              <span className={`text-[10px] px-2 py-0.5 rounded-full ${pa.role === 'coordinator' ? 'bg-nebula-accent/20 text-nebula-accent' : 'bg-nebula-muted/20 text-nebula-muted'}`}>
                {pa.role}
              </span>
              <select
                value={pa.max_concurrent}
                onChange={e => handleUpdateConcurrency(pa.agent_id, parseInt(e.target.value))}
                className="text-[11px] bg-nebula-bg border border-nebula-border rounded px-2 py-0.5 text-nebula-text"
                title="Max concurrent branches"
              >
                {[1,2,3,4,5].map(n => <option key={n} value={n}>{n} concurrent</option>)}
              </select>
              <button onClick={() => handleRemoveAgent(pa.agent_id)} className="text-nebula-muted hover:text-nebula-red text-[11px] transition-colors">
                Remove
              </button>
            </div>
          ))}
        </div>
        {availableAgents.length > 0 && (
          <div className="flex gap-2">
            <select
              value={assignAgentId} onChange={e => setAssignAgentId(e.target.value)}
              className="flex-1 px-3 py-1.5 bg-nebula-bg border border-nebula-border rounded text-[12px] text-nebula-text"
            >
              <option value="">Select agent...</option>
              {availableAgents.map(a => <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>)}
            </select>
            <button onClick={handleAssignAgent} className="px-3 py-1.5 text-[12px] bg-nebula-accent/20 text-nebula-accent rounded hover:bg-nebula-accent/30 transition-colors">
              Assign
            </button>
          </div>
        )}
      </div>

      {/* External links */}
      <div className="bg-nebula-surface border border-nebula-border rounded-lg p-4">
        <h3 className="text-[13px] font-semibold text-nebula-text mb-3">External Integrations</h3>
        <div className="space-y-2 mb-3">
          {links.map(link => (
            <div key={link.id} className="flex flex-wrap items-center gap-2 sm:gap-3 py-2 border-b border-nebula-border/50 last:border-0">
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-nebula-muted/20 text-nebula-muted">{link.type}</span>
              <span className="text-[11px] text-nebula-text">{link.provider}</span>
              <span className="text-[10px] text-nebula-muted truncate flex-1 min-w-[100px] font-mono">{link.url}</span>
              <button onClick={() => handleRemoveLink(link.id)} className="text-nebula-muted hover:text-nebula-red text-[11px] transition-colors">
                Remove
              </button>
            </div>
          ))}
          {links.length === 0 && <p className="text-[11px] text-nebula-muted">No integrations linked</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <select value={newLinkType} onChange={e => setNewLinkType(e.target.value as any)} className="px-2 py-1.5 bg-nebula-bg border border-nebula-border rounded text-[11px] text-nebula-text">
            <option value="issue_tracker">Issue Tracker</option>
            <option value="knowledge_base">Knowledge Base</option>
            <option value="ci">CI/CD</option>
          </select>
          <select value={newLinkProvider} onChange={e => setNewLinkProvider(e.target.value)} className="px-2 py-1.5 bg-nebula-bg border border-nebula-border rounded text-[11px] text-nebula-text">
            <option value="">Provider...</option>
            {(providerOptions[newLinkType] || []).map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <input
            value={newLinkUrl} onChange={e => setNewLinkUrl(e.target.value)}
            className="flex-1 min-w-[120px] px-2 py-1.5 bg-nebula-bg border border-nebula-border rounded text-[11px] text-nebula-text font-mono"
            placeholder="URL..."
          />
          <button onClick={handleAddLink} className="px-3 py-1.5 text-[11px] bg-nebula-accent/20 text-nebula-accent rounded hover:bg-nebula-accent/30 transition-colors">
            Add
          </button>
        </div>
      </div>

      {/* Delete project */}
      <div className="bg-nebula-surface border border-nebula-red/20 rounded-lg p-4">
        <h3 className="text-[13px] font-semibold text-nebula-red mb-2">Danger Zone</h3>
        {!confirmDelete ? (
          <button onClick={() => setConfirmDelete(true)} className="text-[12px] text-nebula-red hover:underline">
            Delete this project...
          </button>
        ) : (
          <div className="flex items-center gap-3">
            <p className="text-[12px] text-nebula-text">Are you sure? This cannot be undone.</p>
            <button onClick={handleDelete} className="px-3 py-1 text-[12px] bg-nebula-red text-white rounded hover:brightness-110">
              Delete
            </button>
            <button onClick={() => setConfirmDelete(false)} className="px-3 py-1 text-[12px] border border-nebula-border rounded text-nebula-muted hover:bg-nebula-hover">
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
