import { useState } from 'react';
import Modal from './Modal';
import {
  Agent, createProject, validateProvider, listProviderRepos,
  ValidateProviderResult, RepoInfo,
} from '../api/client';

interface Props {
  agents: Agent[];
  onClose: () => void;
  onCreated: () => void;
}

type Page = 'provider' | 'repository' | 'details';

export default function ProjectWizard({ agents, onClose, onCreated }: Props) {
  const [page, setPage] = useState<Page>('provider');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  // Page 1: Provider
  const [provider, setProvider] = useState<'gitea' | 'github'>('gitea');
  const [apiUrl, setApiUrl] = useState('');
  const [token, setToken] = useState('');
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<ValidateProviderResult | null>(null);
  const [insecureSsl, setInsecureSsl] = useState(false);

  // Page 2: Repository
  const [repoMode, setRepoMode] = useState<'link_existing' | 'create_new'>('link_existing');
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [repoSearch, setRepoSearch] = useState('');
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<RepoInfo | null>(null);
  const [newRepoName, setNewRepoName] = useState('');

  // Page 3: Details
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [coordinatorId, setCoordinatorId] = useState('');

  const handleValidate = async () => {
    setValidating(true);
    setError('');
    try {
      const result = await validateProvider({ provider, api_url: provider === 'gitea' ? apiUrl : undefined, token, insecure_ssl: insecureSsl });
      setValidation(result);
      if (!result.valid) setError(result.errors.join(', '));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setValidating(false);
    }
  };

  const handleLoadRepos = async (search = '') => {
    setLoadingRepos(true);
    try {
      const result = await listProviderRepos({ provider, api_url: provider === 'gitea' ? apiUrl : undefined, token, insecure_ssl: insecureSsl, search });
      setRepos(result.repos);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoadingRepos(false);
    }
  };

  const handleGoToRepo = () => {
    setPage('repository');
    handleLoadRepos();
  };

  const handleSelectRepo = (repo: RepoInfo) => {
    setSelectedRepo(repo);
    setName(repo.full_name.split('/').pop() || repo.full_name);
    setDescription(repo.description);
  };

  const handleCreate = async () => {
    setCreating(true);
    setError('');
    try {
      const data: Record<string, any> = {
        name: name.trim(),
        description,
        git_provider: provider,
        git_api_url: provider === 'gitea' ? apiUrl : undefined,
        git_insecure_ssl: insecureSsl,
        git_token: token,
        repo_mode: repoMode,
        coordinator_agent_id: coordinatorId || null,
      };
      if (repoMode === 'link_existing' && selectedRepo) {
        data.git_remote_url = selectedRepo.ssh_url || selectedRepo.clone_url;
      } else if (repoMode === 'create_new') {
        // For new repos, construct URL from provider info
        if (provider === 'gitea' && validation) {
          const host = new URL(apiUrl).host;
          data.git_remote_url = `git@${host}:${validation.username}/${newRepoName.trim()}.git`;
          data.repo_name = newRepoName.trim();
        } else if (provider === 'github' && validation) {
          data.git_remote_url = `git@github.com:${validation.username}/${newRepoName.trim()}.git`;
          data.repo_name = newRepoName.trim();
        }
      }
      await createProject(data);
      onCreated();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const canProceedProvider = validation?.valid && validation.capabilities.list_repos && validation.capabilities.read_repos;
  const canProceedRepo = repoMode === 'link_existing' ? !!selectedRepo : !!newRepoName.trim();
  const canCreate = name.trim().length > 0 && !!coordinatorId;

  const steps = [
    { key: 'provider', label: 'Provider' },
    { key: 'repository', label: 'Repository' },
    { key: 'details', label: 'Details' },
  ];

  return (
    <Modal onClose={onClose} size="lg">
      {/* Stepper */}
      <div className="flex items-center gap-2 mb-6">
        {steps.map((s, i) => (
          <div key={s.key} className="flex items-center gap-2">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold ${
              page === s.key ? 'bg-nebula-accent text-nebula-bg' : 'bg-nebula-surface-2 text-nebula-muted'
            }`}>{i + 1}</div>
            <span className={`text-[12px] ${page === s.key ? 'text-nebula-text font-medium' : 'text-nebula-muted'}`}>{s.label}</span>
            {i < steps.length - 1 && <div className="w-8 h-px bg-nebula-border" />}
          </div>
        ))}
      </div>

      {error && <p className="text-[12px] text-nebula-red mb-3">{error}</p>}

      {/* Page 1: Provider */}
      {page === 'provider' && (
        <div className="space-y-4">
          <div>
            <label className="text-xs text-nebula-muted block mb-1">Git Provider</label>
            <div className="flex gap-2">
              {(['gitea', 'github'] as const).map(p => (
                <button key={p} type="button" onClick={() => { setProvider(p); setValidation(null); }}
                  className={`flex-1 py-2 text-xs rounded-lg border transition-colors ${
                    provider === p ? 'bg-nebula-accent/10 border-nebula-accent/30 text-nebula-accent' : 'bg-nebula-bg border-nebula-border text-nebula-muted'
                  }`}>{p === 'gitea' ? 'Gitea' : 'GitHub'}</button>
              ))}
            </div>
          </div>
          {provider === 'gitea' && (
            <div>
              <label className="text-xs text-nebula-muted block mb-1">Server URL</label>
              <input value={apiUrl} onChange={e => { setApiUrl(e.target.value); setValidation(null); }}
                className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent font-mono"
                placeholder="http://gitea.local:3000" />
            </div>
          )}
          <div>
            <label className="text-xs text-nebula-muted block mb-1">API Token</label>
            <input type="password" value={token} onChange={e => { setToken(e.target.value); setValidation(null); }}
              className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent font-mono"
              placeholder="Your personal access token" />
          </div>
          {provider === 'gitea' && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={insecureSsl} onChange={e => { setInsecureSsl(e.target.checked); setValidation(null); }}
                className="rounded border-nebula-border bg-nebula-bg text-nebula-accent focus:ring-nebula-accent" />
              <span className="text-xs text-nebula-muted">Allow insecure SSL (self-signed certificates)</span>
            </label>
          )}
          <button onClick={handleValidate} disabled={validating || !token || (provider === 'gitea' && !apiUrl)}
            className="w-full py-2 text-sm bg-nebula-surface border border-nebula-border rounded-lg hover:bg-nebula-hover disabled:opacity-30 transition-colors">
            {validating ? 'Testing...' : 'Test Connection'}
          </button>
          {validation && (
            <div className="bg-nebula-bg border border-nebula-border rounded-lg p-3 space-y-1.5">
              {validation.valid && <p className="text-[12px] text-nebula-green">Connected as <strong>{validation.username}</strong></p>}
              {(['list_repos', 'read_repos', 'create_repos', 'create_webhooks'] as const).map(cap => (
                <div key={cap} className="flex items-center gap-2">
                  <span className={`text-[12px] ${validation.capabilities[cap] ? 'text-nebula-green' : 'text-nebula-red'}`}>
                    {validation.capabilities[cap] ? '\u2713' : '\u2717'}
                  </span>
                  <span className="text-[11px] text-nebula-muted">{cap.replace(/_/g, ' ')}</span>
                </div>
              ))}
              {!validation.capabilities.create_repos && (
                <p className="text-[10px] text-nebula-muted mt-1">Token lacks repo creation permission — you can only link existing repos</p>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-nebula-muted hover:text-nebula-text">Cancel</button>
            <button onClick={handleGoToRepo} disabled={!canProceedProvider}
              className="px-4 py-2 text-sm bg-nebula-accent text-nebula-bg rounded-lg hover:brightness-110 disabled:opacity-30 font-medium">
              Next
            </button>
          </div>
        </div>
      )}

      {/* Page 2: Repository */}
      {page === 'repository' && (
        <div className="space-y-4">
          <div className="flex gap-2">
            <button type="button" onClick={() => setRepoMode('link_existing')}
              className={`flex-1 py-2 text-xs rounded-lg border transition-colors ${
                repoMode === 'link_existing' ? 'bg-nebula-accent/10 border-nebula-accent/30 text-nebula-accent' : 'bg-nebula-bg border-nebula-border text-nebula-muted'
              }`}>Link existing</button>
            <button type="button" onClick={() => setRepoMode('create_new')}
              disabled={!validation?.capabilities.create_repos}
              className={`flex-1 py-2 text-xs rounded-lg border transition-colors ${
                repoMode === 'create_new' ? 'bg-nebula-accent/10 border-nebula-accent/30 text-nebula-accent' : 'bg-nebula-bg border-nebula-border text-nebula-muted'
              } disabled:opacity-30 disabled:cursor-not-allowed`}
              title={!validation?.capabilities.create_repos ? 'Token lacks create permission' : undefined}>
              Create new
            </button>
          </div>

          {repoMode === 'link_existing' && (
            <div>
              <div className="flex gap-2 mb-2">
                <input value={repoSearch} onChange={e => setRepoSearch(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleLoadRepos(repoSearch)}
                  className="flex-1 px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent"
                  placeholder="Search repos..." />
                <button onClick={() => handleLoadRepos(repoSearch)} disabled={loadingRepos}
                  className="px-3 py-2 text-xs bg-nebula-surface border border-nebula-border rounded hover:bg-nebula-hover disabled:opacity-30">
                  {loadingRepos ? '...' : 'Search'}
                </button>
              </div>
              <div className="max-h-48 overflow-y-auto space-y-1">
                {repos.map(r => (
                  <button key={r.full_name} onClick={() => handleSelectRepo(r)}
                    className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${
                      selectedRepo?.full_name === r.full_name ? 'bg-nebula-accent/10 border-nebula-accent/30' : 'bg-nebula-bg border-nebula-border hover:bg-nebula-hover'
                    }`}>
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] text-nebula-text font-medium">{r.full_name}</span>
                      {r.private && <span className="text-[9px] px-1 py-0 rounded bg-nebula-muted/20 text-nebula-muted">private</span>}
                    </div>
                    {r.description && <p className="text-[10px] text-nebula-muted truncate">{r.description}</p>}
                  </button>
                ))}
                {repos.length === 0 && !loadingRepos && <p className="text-[11px] text-nebula-muted text-center py-4">No repos found</p>}
              </div>
            </div>
          )}

          {repoMode === 'create_new' && (
            <div>
              <label className="text-xs text-nebula-muted block mb-1">Repository Name</label>
              <input value={newRepoName} onChange={e => { setNewRepoName(e.target.value); setName(e.target.value); }}
                className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent font-mono"
                placeholder="my-project" />
              <p className="text-[10px] text-nebula-muted mt-1">Will be created as a private repository under {validation?.username || 'your account'}</p>
            </div>
          )}

          <div className="flex justify-between pt-2">
            <button onClick={() => setPage('provider')} className="px-4 py-2 text-sm text-nebula-muted hover:text-nebula-text">Back</button>
            <button onClick={() => setPage('details')} disabled={!canProceedRepo}
              className="px-4 py-2 text-sm bg-nebula-accent text-nebula-bg rounded-lg hover:brightness-110 disabled:opacity-30 font-medium">
              Next
            </button>
          </div>
        </div>
      )}

      {/* Page 3: Details */}
      {page === 'details' && (
        <div className="space-y-4">
          <div>
            <label className="text-xs text-nebula-muted block mb-1">Project Name</label>
            <input value={name} onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent"
              placeholder="My Project" />
          </div>
          <div>
            <label className="text-xs text-nebula-muted block mb-1">Description</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}
              className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent resize-none"
              placeholder="What this project is about" />
          </div>
          <div>
            <label className="text-xs text-nebula-muted block mb-1">Coordinator Agent</label>
            <select value={coordinatorId} onChange={e => setCoordinatorId(e.target.value)}
              className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text">
              <option value="">Select an agent...</option>
              {agents.filter(a => a.enabled).map(a => (
                <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>
              ))}
            </select>
          </div>

          <div className="flex justify-between pt-2">
            <button onClick={() => setPage('repository')} className="px-4 py-2 text-sm text-nebula-muted hover:text-nebula-text">Back</button>
            <button onClick={handleCreate} disabled={!canCreate || creating}
              className="px-4 py-2 text-sm bg-nebula-accent text-nebula-bg rounded-lg hover:brightness-110 disabled:opacity-30 font-medium">
              {creating ? 'Creating...' : 'Create Project'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
