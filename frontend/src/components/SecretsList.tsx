import { useState, useEffect, useRef } from 'react';
import { AgentSecret } from '../api/client';

interface Props {
  load: () => Promise<AgentSecret[]>;
  create: (key: string, value: string) => Promise<any>;
  remove: (secretId: string) => Promise<any>;
}

export default function SecretsList({ load, create, remove }: Props) {
  const [secrets, setSecrets] = useState<AgentSecret[]>([]);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [saving, setSaving] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = () => { loadRef.current().then(setSecrets).catch(() => {}); };
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAdd = async () => {
    if (!newKey.trim() || !newValue.trim()) return;
    setSaving(true);
    try {
      await create(newKey.trim(), newValue.trim());
      setNewKey(''); setNewValue('');
      refresh();
    } catch (err) {
      console.error('Failed to save secret:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await remove(id);
    } catch (err) {
      console.error('Failed to delete secret:', err);
    }
    refresh();
  };

  return (
    <div>
      <div className="space-y-1.5 mb-3">
        {secrets.map(s => (
          <div key={s.id} className="flex items-center gap-2 py-1.5 border-b border-nebula-border/50 last:border-0">
            <span className="text-[12px] font-mono text-nebula-accent flex-1">{s.key}</span>
            <span className="text-[10px] text-nebula-muted">***</span>
            <button onClick={() => handleDelete(s.id)} className="text-nebula-muted hover:text-nebula-red text-[11px] transition-colors">
              Delete
            </button>
          </div>
        ))}
        {secrets.length === 0 && <p className="text-[11px] text-nebula-muted">No secrets configured</p>}
      </div>
      <div className="flex gap-2">
        <input
          value={newKey} onChange={e => setNewKey(e.target.value)}
          className="flex-1 px-2 py-1.5 bg-nebula-bg border border-nebula-border rounded text-[11px] text-nebula-text font-mono"
          placeholder="KEY_NAME"
        />
        <input
          type="password"
          value={newValue} onChange={e => setNewValue(e.target.value)}
          className="flex-1 px-2 py-1.5 bg-nebula-bg border border-nebula-border rounded text-[11px] text-nebula-text"
          placeholder="Secret value"
        />
        <button
          onClick={handleAdd}
          disabled={saving || !newKey.trim() || !newValue.trim()}
          className="px-3 py-1.5 text-[11px] bg-nebula-accent/20 text-nebula-accent rounded hover:bg-nebula-accent/30 disabled:opacity-30 transition-colors"
        >
          {saving ? '...' : 'Add'}
        </button>
      </div>
    </div>
  );
}
