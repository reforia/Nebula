import { useState, useEffect, useCallback, useMemo } from 'react';
import { useToast } from '../contexts/ToastContext';
import ChatPanel from './ChatPanel';
import TaskList from './TaskList';
import SecretsList from './SecretsList';
import ProjectOverviewTab from './ProjectOverviewTab';
import ProjectMilestonesTab from './ProjectMilestonesTab';
import ProjectVaultTab from './ProjectVaultTab';
import ProjectSettingsTab from './ProjectSettingsTab';
import {
  Project, Agent, ProjectMilestone, ProjectDashboard, Message,
  getProject, getProjectMilestones, getProjectDashboard, getProjectMessages, sendProjectMessage, markProjectMessagesRead,
  getProjectVault,
  getProjectSecrets, createProjectSecret, deleteProjectSecret,
  getProjectReadiness, ReadinessResult,
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
  const { reportError } = useToast();
  const [tab, setTab] = useState<Tab>(scrollToMessageId ? 'conversation' : 'overview');

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

  useEffect(() => {
    getProject(projectId).then(p => {
      setProject(p);
      setReadiness(p.readiness || null);
    }).catch(e => reportError(e, 'Failed to load project'));
  }, [projectId, reportError]);

  useEffect(() => {
    if (tab === 'milestones' || tab === 'overview') {
      getProjectMilestones(projectId).then(setMilestones).catch(e => reportError(e, 'Failed to load milestones'));
    }
    if (tab === 'overview') {
      getProjectDashboard(projectId).then(setDashboard).catch(e => reportError(e, 'Failed to load project dashboard'));
    }
    if (tab === 'conversation') {
      getProjectMessages(projectId, 100).then(setMessages).catch(e => reportError(e, 'Failed to load messages'));
      markProjectMessagesRead(projectId).then(() => {
        getProject(projectId).then(setProject).catch(e => reportError(e, 'Failed to refresh project'));
        onRead?.();
      }).catch(e => console.warn('[project] mark-read failed:', e));
    }
    if (tab === 'vault') {
      getProjectVault(projectId).then(setVaultFiles).catch(() => setVaultFiles([]));
      setVaultContent(null);
    }
  }, [projectId, tab, onRead, reportError]);

  const addMessage = useCallback((msg: Message) => {
    setMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg]);
  }, []);

  useEffect(() => {
    if (!subscribe) return;
    return subscribe((msg: any) => {
      if (msg.type === 'new_message' && msg.project_id === projectId && msg.message) {
        addMessage(msg.message);
        if (tab === 'conversation') {
          markProjectMessagesRead(projectId).then(() => onRead?.()).catch(e => console.warn('[project] mark-read failed:', e));
        }
      }
    });
  }, [subscribe, projectId, addMessage, tab, onRead]);

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

  const refreshReadiness = () =>
    getProjectReadiness(projectId)
      .then(r => { setReadiness(r); getProject(projectId).then(setProject); })
      .catch(e => reportError(e, 'Failed to refresh readiness'));

  return (
    <div className="flex-1 flex flex-col h-full bg-nebula-bg">
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

      {tab === 'conversation' && (
        <ChatPanel
          messages={messages}
          agents={agents}
          typingNames={projectTypingNames}
          onSend={handleSendMessage}
          disabled={connected === false}
          disconnected={connected === false}
          resetKey={projectId}
          hideNotify
          draft={draft}
          onDraftChange={setDraft}
          scrollToMessageId={scrollToMessageId}
          onScrollToComplete={onScrollToComplete}
        />
      )}
      {tab !== 'conversation' && (
        <div className="flex-1 overflow-y-auto">
          {tab === 'overview' && (
            <ProjectOverviewTab
              project={project} milestones={milestones} dashboard={dashboard} readiness={readiness}
              agentName={agentName} statusColor={statusColor}
              onReadinessRefresh={refreshReadiness}
            />
          )}
          {tab === 'milestones' && (
            <ProjectMilestonesTab
              projectId={projectId} milestones={milestones}
              setMilestones={setMilestones} agentName={agentName} statusColor={statusColor}
            />
          )}
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
          {tab === 'vault' && <ProjectVaultTab projectId={projectId} files={vaultFiles} content={vaultContent} setContent={setVaultContent} />}
          {tab === 'settings' && (
            <ProjectSettingsTab
              project={project} agents={agents}
              onUpdated={() => getProject(projectId).then(setProject)}
              onDeleted={onProjectDeleted}
            />
          )}
        </div>
      )}
    </div>
  );
}
