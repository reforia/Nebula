import { useState, useEffect, useCallback } from 'react';
import { getTasks, getProjectTasks, deleteTask, triggerTask, Task } from '../api/client';
import TaskForm from './TaskForm';

interface Props {
  agentId: string;
  projectId?: string;
}

export default function TaskList({ agentId, projectId }: Props) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editTask, setEditTask] = useState<Task | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = projectId ? await getProjectTasks(projectId) : await getTasks(agentId);
      setTasks(data);
    } catch (err) {
      console.error('Failed to load tasks:', err);
    }
  }, [agentId, projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this task?')) return;
    await deleteTask(id);
    refresh();
  };

  const handleTrigger = async (id: string) => {
    await triggerTask(id);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium">Scheduled Tasks</h3>
        <button
          onClick={() => { setEditTask(null); setShowForm(true); }}
          className="px-3 py-1.5 text-xs bg-nebula-accent text-white rounded hover:opacity-90"
        >
          + New Task
        </button>
      </div>

      {tasks.length === 0 ? (
        <p className="text-sm text-nebula-muted">No scheduled tasks</p>
      ) : (
        <div className="space-y-2">
          {tasks.map(task => (
            <div key={task.id} className="bg-nebula-bg border border-nebula-border rounded p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium">{task.name}</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => handleTrigger(task.id)}
                    className="px-2 py-0.5 text-xs bg-nebula-surface border border-nebula-border rounded hover:bg-nebula-hover"
                    title="Run now"
                  >
                    Run
                  </button>
                  <button
                    onClick={() => { setEditTask(task); setShowForm(true); }}
                    className="px-2 py-0.5 text-xs bg-nebula-surface border border-nebula-border rounded hover:bg-nebula-hover"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(task.id)}
                    className="px-2 py-0.5 text-xs text-red-400 hover:text-red-300"
                  >
                    Del
                  </button>
                </div>
              </div>
              <p className="text-xs text-nebula-muted font-mono mb-1">
                {(task as any).trigger_type === 'webhook'
                  ? `webhook: ${window.location.origin}/api/webhooks/${task.id}`
                  : task.cron_expression}
              </p>
              <p className="text-xs text-nebula-muted truncate">{task.prompt}</p>
              <div className="flex items-center gap-3 mt-2 text-xs text-nebula-muted">
                <span className={task.enabled ? 'text-green-400' : 'text-zinc-500'}>{task.enabled ? 'Active' : 'Paused'}</span>
                {task.last_run_at && <span>Last: {new Date(task.last_run_at + 'Z').toLocaleString()}</span>}
                {task.last_status && <span className={task.last_status === 'success' ? 'text-green-400' : 'text-red-400'}>{task.last_status}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <TaskForm
          agentId={agentId}
          projectId={projectId}
          task={editTask}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); refresh(); }}
        />
      )}
    </div>
  );
}
