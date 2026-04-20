import { useState, useEffect } from 'react';
import {
  Agent, Project, ProjectLink, ProjectAgent,
  updateProject, deleteProject,
  getProjectLinks, addProjectLink, removeProjectLink,
  getProjectAgents, assignProjectAgent, updateProjectAgent, removeProjectAgent,
} from '../api/client';
import { useToast } from '../contexts/ToastContext';

interface Props {
  project: Project;
  agents: Agent[];
  onUpdated: () => void;
  onDeleted?: () => void;
}

export default function ProjectSettingsTab({ project, agents, onUpdated, onDeleted }: Props) {
  const { reportError } = useToast();
  const [autoMerge, setAutoMerge] = useState(!!project.auto_merge);
  const [links, setLinks] = useState<ProjectLink[]>([]);
  const [projectAgents, setProjectAgents] = useState<ProjectAgent[]>([]);
  const [newLinkType, setNewLinkType] = useState<'issue_tracker' | 'knowledge_base' | 'ci'>('issue_tracker');
  const [newLinkProvider, setNewLinkProvider] = useState('');
  const [newLinkUrl, setNewLinkUrl] = useState('');
  const [assignAgentId, setAssignAgentId] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    getProjectLinks(project.id).then(setLinks).catch(e => reportError(e, 'Failed to load project links'));
    getProjectAgents(project.id).then(setProjectAgents).catch(e => reportError(e, 'Failed to load project agents'));
  }, [project.id, reportError]);

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
