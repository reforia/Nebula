import { useState, useEffect } from 'react';
import { createAgent, Agent } from '../api/client';
import ToolsPicker from './ToolsPicker';
import ModelPicker from './ModelPicker';
import RuntimeSelector, { useRuntimes } from './RuntimeSelector';
import Modal from './Modal';

interface Props {
  onClose: () => void;
  onCreated: (agent: Agent) => void;
}

export default function AgentForm({ onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [emoji, setEmoji] = useState('');
  const [model, setModel] = useState('claude-sonnet-4-6');
  const { data: runtimeData } = useRuntimes();
  const [runtime, setRuntime] = useState(runtimeData?.default || '');

  // Sync default when runtimeData loads after initial render
  useEffect(() => {
    if (!runtime && runtimeData?.default) setRuntime(runtimeData.default);
  }, [runtimeData?.default]);
  const [allowedTools, setAllowedTools] = useState('Read,Grep,Glob,WebFetch,Bash');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }

    setLoading(true);
    setError('');
    try {
      const agent = await createAgent({
        name: name.trim(),
        role: role.trim(),
        emoji: emoji || undefined,
        model,
        backend: runtime,
        allowed_tools: allowedTools,
      });
      onCreated(agent);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal onClose={onClose}>
        <h2 className="text-lg font-semibold mb-4">New Agent</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs text-nebula-muted block mb-1">Name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. DevOps Bot"
              className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent"
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs text-nebula-muted block mb-1">Role / System Prompt</label>
            <textarea
              value={role}
              onChange={e => setRole(e.target.value)}
              placeholder="You are a DevOps specialist..."
              rows={3}
              className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent resize-none"
            />
          </div>
          <div>
            <label className="text-xs text-nebula-muted block mb-1">Emoji</label>
            <input
              value={emoji}
              onChange={e => setEmoji(e.target.value)}
              placeholder="auto"
              className="w-20 px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text text-center focus:outline-none focus:border-nebula-accent"
            />
          </div>
          <div>
            <label className="text-xs text-nebula-muted block mb-1">Runtime</label>
            <RuntimeSelector value={runtime} onChange={setRuntime} />
          </div>
          <div>
            <label className="text-xs text-nebula-muted block mb-1">Model</label>
            <ModelPicker model={model} onChange={setModel} runtimeId={runtime} />
          </div>
          <div>
            <label className="text-xs text-nebula-muted block mb-1">Allowed Tools</label>
            <ToolsPicker value={allowedTools} onChange={setAllowedTools} hasBuiltinWebTools={runtimeData?.runtimes.find(r => r.id === runtime)?.hasBuiltinWebTools ?? true} />
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-nebula-muted hover:text-nebula-text">
              Cancel
            </button>
            <button type="submit" disabled={loading} className="px-4 py-2 text-sm bg-nebula-accent text-white rounded hover:opacity-90 disabled:opacity-50">
              {loading ? 'Creating...' : 'Create Agent'}
            </button>
          </div>
        </form>
    </Modal>
  );
}
