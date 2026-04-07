import { useState } from 'react';
import { createTask, createProjectTask, updateTask, Task } from '../api/client';
import Modal from './Modal';

interface Props {
  agentId: string;
  projectId?: string;
  task: Task | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function TaskForm({ agentId, projectId, task, onClose, onSaved }: Props) {
  const [name, setName] = useState(task?.name || '');
  const [prompt, setPrompt] = useState(task?.prompt || '');
  const [triggerType, setTriggerType] = useState<'cron' | 'webhook'>((task as any)?.trigger_type || 'cron');
  const [cronExpr, setCronExpr] = useState(task?.cron_expression || '0 9 * * *');
  const [enabled, setEnabled] = useState(task ? !!task.enabled : true);
  const [maxTurns, setMaxTurns] = useState(task?.max_turns || 50);
  const [timeoutMin, setTimeoutMin] = useState<string>(task?.timeout_ms ? String(task.timeout_ms / 60000) : '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !prompt.trim()) {
      setError('Name and prompt are required');
      return;
    }
    if (triggerType === 'cron' && !cronExpr.trim()) {
      setError('Cron expression is required');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const data: any = {
        name, prompt, trigger_type: triggerType,
        enabled: enabled as any, max_turns: maxTurns,
        timeout_ms: timeoutMin ? Math.round(parseFloat(timeoutMin) * 60000) : null,
      };
      if (triggerType === 'cron') data.cron_expression = cronExpr;

      if (task) {
        await updateTask(task.id, data);
      } else if (projectId) {
        await createProjectTask(projectId, { ...data, agent_id: agentId });
      } else {
        await createTask(agentId, data);
      }
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} z={60}>
        <h3 className="text-base font-semibold mb-4">{task ? 'Edit Task' : 'New Task'}</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs text-nebula-muted block mb-1">Task Name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Deploy Notifier" className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded-lg text-sm text-nebula-text focus:outline-none focus:border-nebula-accent/50" autoFocus />
          </div>

          <div>
            <label className="text-xs text-nebula-muted block mb-1">Trigger</label>
            <div className="flex gap-2">
              <button type="button" onClick={() => setTriggerType('cron')}
                className={`flex-1 py-2 text-xs rounded-lg border transition-colors ${triggerType === 'cron' ? 'bg-nebula-accent/10 border-nebula-accent/30 text-nebula-accent' : 'bg-nebula-bg border-nebula-border text-nebula-muted'}`}>
                Cron (scheduled)
              </button>
              <button type="button" onClick={() => setTriggerType('webhook')}
                className={`flex-1 py-2 text-xs rounded-lg border transition-colors ${triggerType === 'webhook' ? 'bg-nebula-accent/10 border-nebula-accent/30 text-nebula-accent' : 'bg-nebula-bg border-nebula-border text-nebula-muted'}`}>
                Webhook (event)
              </button>
            </div>
          </div>

          <div>
            <label className="text-xs text-nebula-muted block mb-1">Prompt</label>
            <textarea value={prompt} onChange={e => setPrompt(e.target.value)}
              placeholder={triggerType === 'webhook' ? 'Analyze this webhook event and...' : 'Check system health...'}
              rows={4} className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded-lg text-sm text-nebula-text focus:outline-none focus:border-nebula-accent/50 resize-none" />
            {triggerType === 'webhook' && (
              <p className="text-[10px] text-nebula-muted mt-1">The webhook payload will be appended to this prompt when triggered.</p>
            )}
          </div>

          {triggerType === 'cron' && (
            <div>
              <label className="text-xs text-nebula-muted block mb-1">Cron Expression</label>
              <input value={cronExpr} onChange={e => setCronExpr(e.target.value)} className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded-lg text-sm text-nebula-text font-mono focus:outline-none focus:border-nebula-accent/50" />
              <p className="text-[10px] text-nebula-muted mt-1">e.g. "0 9 * * *" = daily 9am</p>
            </div>
          )}

          <div>
            <label className="text-xs text-nebula-muted block mb-1">Max Turns</label>
            <input type="number" value={maxTurns} onChange={e => setMaxTurns(parseInt(e.target.value) || 50)} min={1} max={100} className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded-lg text-sm text-nebula-text focus:outline-none focus:border-nebula-accent/50" />
          </div>

          <div>
            <label className="text-xs text-nebula-muted block mb-1">Timeout (minutes)</label>
            <input type="number" value={timeoutMin} onChange={e => setTimeoutMin(e.target.value)} min={1} placeholder="Inherit from agent / org" className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded-lg text-sm text-nebula-text focus:outline-none focus:border-nebula-accent/50" />
            <p className="text-[10px] text-nebula-muted mt-1">Leave empty to inherit from agent or org settings</p>
          </div>

          {triggerType === 'webhook' && task && (task as any).webhook_secret && (
            <div className="bg-nebula-bg border border-nebula-border rounded-lg p-3">
              <p className="text-[11px] text-nebula-muted mb-1">Webhook URL:</p>
              <code className="text-[11px] text-nebula-accent break-all select-all block">
                {window.location.origin}/api/webhooks/{task.id}
              </code>
              <p className="text-[11px] text-nebula-muted mt-2 mb-1">Secret:</p>
              <code className="text-[11px] text-nebula-accent break-all select-all block">
                {(task as any).webhook_secret}
              </code>
              <p className="text-[10px] text-nebula-muted mt-2">
                Configure this URL in Gitea/GitHub with the secret for HMAC verification.
              </p>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="accent-nebula-accent" />
            Enabled
          </label>

          {error && <p className="text-nebula-red text-sm">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-nebula-muted hover:text-nebula-text">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-nebula-accent text-nebula-bg rounded-lg hover:brightness-110 disabled:opacity-50 font-medium">
              {saving ? 'Saving...' : (task ? 'Update' : 'Create')}
            </button>
          </div>
        </form>
    </Modal>
  );
}
