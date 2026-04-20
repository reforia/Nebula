import { useState } from 'react';
import {
  getCleanupStatus, runCleanup, deleteOrg, CleanupStatus, OrgStatus,
} from '../api/client';
import { useAuth } from '../contexts/AuthContext';

interface Props {
  status: OrgStatus | null;
  settings: Record<string, string>;
  updateSetting: (key: string, value: string) => void;
  cleanupStatus: CleanupStatus | null;
  setCleanupStatus: (s: CleanupStatus) => void;
  setError: (msg: string) => void;
}

export default function SettingsSystemTab({
  status, settings, updateSetting, cleanupStatus, setCleanupStatus, setError,
}: Props) {
  const { currentOrg, orgs, switchOrg } = useAuth();
  const [cleanupRunning, setCleanupRunning] = useState(false);
  const [deleteOrgConfirm, setDeleteOrgConfirm] = useState('');
  const [deletingOrg, setDeletingOrg] = useState(false);

  return (
    <div className="space-y-4">
      {status && (
        <div className="bg-nebula-bg border border-nebula-border rounded p-4 space-y-2 text-sm">
          <p><span className="text-nebula-muted">Uptime:</span> {Math.floor(status.uptime / 3600)}h {Math.floor((status.uptime % 3600) / 60)}m</p>
        </div>
      )}

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
        <p className="text-[11px] text-nebula-muted">Automatically cleans orphaned CLI sessions and stale project worktrees on a schedule.</p>

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
            Stale sessions
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

      {orgs.length > 1 && (
        <div className="pt-4 border-t border-red-900/30 space-y-3">
          <h4 className="text-sm font-medium text-red-400">Danger Zone</h4>
          <p className="text-[11px] text-nebula-muted">
            Permanently delete this organization and all its data — agents, conversations, tasks, skills, and files. This cannot be undone.
          </p>
          <div className="space-y-2">
            <label className="text-[11px] text-nebula-muted block">
              Type <strong className="text-nebula-text">{currentOrg?.name}</strong> to confirm:
            </label>
            <input
              value={deleteOrgConfirm}
              onChange={e => setDeleteOrgConfirm(e.target.value)}
              placeholder={currentOrg?.name}
              className="w-full px-3 py-2 bg-nebula-bg border border-red-900/30 rounded text-sm text-nebula-text focus:outline-none focus:border-red-500"
            />
            <button
              onClick={async () => {
                if (!currentOrg) return;
                setDeletingOrg(true);
                try {
                  await deleteOrg(currentOrg.id);
                  const otherOrg = orgs.find(o => o.id !== currentOrg.id);
                  if (otherOrg) {
                    await switchOrg(otherOrg.id);
                  }
                  window.location.reload();
                } catch (err: any) {
                  setError(err.message);
                } finally {
                  setDeletingOrg(false);
                }
              }}
              disabled={deletingOrg || deleteOrgConfirm !== currentOrg?.name}
              className="px-4 py-2 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              {deletingOrg ? 'Deleting...' : 'Delete Organization'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
