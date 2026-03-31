import { useState } from 'react';
import { Agent, createProject } from '../api/client';
import Modal from './Modal';

interface Props {
  agents: Agent[];
  onClose: () => void;
  onCreated: () => void;
}

export default function ProjectForm({ agents, onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [gitRemoteUrl, setGitRemoteUrl] = useState('');
  const [gitApiUrl, setGitApiUrl] = useState('');
  const [gitProvider, setGitProvider] = useState<'gitea' | 'github' | 'gitlab'>('gitea');
  const [coordinatorId, setCoordinatorId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await createProject({
        name, description, git_remote_url: gitRemoteUrl,
        git_api_url: gitApiUrl.trim() || undefined,
        git_provider: gitProvider,
        coordinator_agent_id: coordinatorId || null,
      } as any);
      onCreated();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal onClose={onClose}>
        <h2 className="text-lg font-semibold text-nebula-text mb-4">New Project</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs text-nebula-muted block mb-1">Name</label>
            <input
              value={name} onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent"
              placeholder="Project name" required
            />
          </div>

          <div>
            <label className="text-xs text-nebula-muted block mb-1">Description</label>
            <textarea
              value={description} onChange={e => setDescription(e.target.value)}
              className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent resize-none"
              rows={2} placeholder="What this project is about"
            />
          </div>

          <div>
            <label className="text-xs text-nebula-muted block mb-1">Git Remote URL</label>
            <input
              value={gitRemoteUrl} onChange={e => setGitRemoteUrl(e.target.value)}
              className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent font-mono"
              placeholder="git@gitea:org/repo.git" required
            />
          </div>

          <div>
            <label className="text-xs text-nebula-muted block mb-1">API URL <span className="text-nebula-muted/50">(optional — for non-standard ports)</span></label>
            <input
              value={gitApiUrl} onChange={e => setGitApiUrl(e.target.value)}
              className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent font-mono"
              placeholder="e.g. http://gitea.local:3000"
            />
          </div>

          <div>
            <label className="text-xs text-nebula-muted block mb-1">Git Provider</label>
            <select
              value={gitProvider} onChange={e => setGitProvider(e.target.value as any)}
              className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent"
            >
              <option value="gitea">Gitea</option>
              <option value="github">GitHub</option>
              <option value="gitlab">GitLab</option>
            </select>
          </div>

          <div>
            <label className="text-xs text-nebula-muted block mb-1">Coordinator Agent</label>
            <select
              value={coordinatorId} onChange={e => setCoordinatorId(e.target.value)}
              className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent"
            >
              <option value="">None (assign later)</option>
              {agents.filter(a => a.enabled).map(a => (
                <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>
              ))}
            </select>
          </div>

          {error && <p className="text-xs text-nebula-red">{error}</p>}

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-2 text-sm border border-nebula-border rounded hover:bg-nebula-hover transition-colors text-nebula-muted">
              Cancel
            </button>
            <button type="submit" disabled={loading} className="flex-1 py-2 text-sm bg-nebula-accent text-nebula-bg rounded hover:brightness-110 font-semibold transition-all disabled:opacity-50">
              {loading ? 'Creating...' : 'Create Project'}
            </button>
          </div>
        </form>
    </Modal>
  );
}
