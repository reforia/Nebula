import { useState, useEffect } from 'react';
import MarkdownViewer from './MarkdownViewer';
import {
  Project, ProjectMilestone, ProjectDashboard, ReadinessResult,
  testProjectWebhook, launchProject, getProjectVaultFile, updateVaultFile,
} from '../api/client';

interface Props {
  project: Project;
  milestones: ProjectMilestone[];
  dashboard: ProjectDashboard | null;
  readiness: ReadinessResult | null;
  agentName: (id: string | null) => string;
  statusColor: (s: string) => string;
  onReadinessRefresh?: () => void;
}

export default function ProjectOverviewTab({ project, milestones, dashboard, readiness, agentName, statusColor, onReadinessRefresh }: Props) {
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
                  {(c.key === 'design_spec' || c.key === 'tech_spec') && (isNotReady || c.met) && (
                    <button onClick={() => setEditingSpec(c.key === 'design_spec' ? 'design-spec.md' : 'tech-spec.md')}
                      className="text-[10px] px-2 py-0.5 bg-nebula-surface border border-nebula-border rounded hover:bg-nebula-hover">
                      {isNotReady ? (c.met ? 'Edit' : 'Create') : 'View'}
                    </button>
                  )}
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

      {editingSpec && (
        <SpecEditor projectId={project.id} filePath={editingSpec} isNotReady={isNotReady}
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

      {dashboard && dashboard.agent_activity.length > 0 && (
        <div>
          <h3 className="text-[13px] font-semibold text-nebula-text mb-3">Agent Activity</h3>
          <div className="space-y-2">
            {dashboard.agent_activity.map(a => (
              <div key={a.agent_id} className="bg-nebula-surface border border-nebula-border rounded-lg p-3 flex items-center gap-3">
                <span className="text-base">{a.agent_emoji}</span>
                <span className="text-[12px] text-nebula-text flex-1">{a.agent_name}</span>
                <span className="text-[11px] text-nebula-muted">{a.message_count} messages</span>
                <span className="text-[10px] text-nebula-muted">{new Date(a.last_active + 'Z').toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SpecEditor({ projectId, filePath, isNotReady, onClose, onSaved }: {
  projectId: string; filePath: string; isNotReady: boolean; onClose: () => void; onSaved?: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    getProjectVaultFile(projectId, filePath).then(setContent).catch(() => setContent(''));
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
