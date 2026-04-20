import { useState } from 'react';
import {
  ProjectMilestone,
  getProjectMilestones, createMilestone, updateMilestone, createDeliverable, updateDeliverable,
} from '../api/client';
import { useToast } from '../contexts/ToastContext';

interface Props {
  projectId: string;
  milestones: ProjectMilestone[];
  setMilestones: (m: ProjectMilestone[]) => void;
  agentName: (id: string | null) => string;
  statusColor: (s: string) => string;
}

export default function ProjectMilestonesTab({ projectId, milestones, setMilestones, agentName, statusColor }: Props) {
  const { reportError } = useToast();
  const [newMilestoneName, setNewMilestoneName] = useState('');
  const [expandedMilestone, setExpandedMilestone] = useState<string | null>(null);
  const [newDeliverableName, setNewDeliverableName] = useState('');

  const refresh = () => getProjectMilestones(projectId).then(setMilestones);

  const handleAddMilestone = async () => {
    if (!newMilestoneName.trim()) return;
    try {
      await createMilestone(projectId, { name: newMilestoneName.trim() });
      setNewMilestoneName('');
      await refresh();
    } catch (err) {
      reportError(err, 'Failed to add milestone');
    }
  };

  const handleAddDeliverable = async (milestoneId: string) => {
    if (!newDeliverableName.trim()) return;
    try {
      await createDeliverable(milestoneId, { name: newDeliverableName.trim() });
      setNewDeliverableName('');
      await refresh();
    } catch (err) {
      reportError(err, 'Failed to add deliverable');
    }
  };

  const handleUpdateStatus = async (type: 'milestone' | 'deliverable', id: string, status: string) => {
    try {
      if (type === 'milestone') await updateMilestone(id, { status } as any);
      else await updateDeliverable(id, { status } as any);
      await refresh();
    } catch (err) {
      reportError(err, `Failed to update ${type}`);
    }
  };

  return (
    <div className="p-6 space-y-4">
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
