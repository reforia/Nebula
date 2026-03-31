import { useState, useEffect, ReactNode } from 'react';

export interface CrudItem {
  id: string;
  name: string;
  enabled: number;
  agent_id: string | null;
}

interface Props<T extends CrudItem> {
  scope: 'org' | 'agent';
  agentId?: string;
  // Labels
  orgLabel: string;
  agentLabel: string;
  emptyText: string;
  addLabel: string;
  itemKind: string;
  // Data
  load: () => Promise<T[]>;
  onUpdate: (item: T, updates: Partial<T>) => Promise<void>;
  onDelete: (item: T) => Promise<void>;
  // Render slots
  renderCreateForm: (props: { onCreated: () => void; onCancel: () => void }) => ReactNode;
  renderSubtitle: (item: T) => ReactNode;
  renderEditor: (item: T, props: {
    items: T[];
    setItems: React.Dispatch<React.SetStateAction<T[]>>;
    saving: string | null;
    onSave: (updates: Partial<T>) => void;
  }) => ReactNode;
  footer?: ReactNode;
  onMutate?: () => void;
}

export default function CrudList<T extends CrudItem>({
  scope, agentId, orgLabel, agentLabel, emptyText, addLabel, itemKind,
  load: loadFn, onUpdate, onDelete,
  renderCreateForm, renderSubtitle, renderEditor, footer, onMutate,
}: Props<T>) {
  const [items, setItems] = useState<T[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [itemError, setItemError] = useState<{ id: string; msg: string } | null>(null);

  const reload = async () => {
    try { setItems(await loadFn()); } catch (err) { console.error(`Failed to load ${itemKind}s:`, err); }
  };

  useEffect(() => { reload(); }, [scope, agentId]);

  const handleUpdate = async (item: T, updates: Partial<T>) => {
    setSaving(item.id);
    setItemError(null);
    try { await onUpdate(item, updates); reload(); onMutate?.(); }
    catch (err: any) {
      setItemError({ id: item.id, msg: err.message || `Failed to update ${itemKind}` });
      reload(); // revert optimistic UI
    }
    finally { setSaving(null); }
  };

  const handleDelete = async (item: T) => {
    if (!confirm(`Delete ${itemKind} "${item.name}"?`)) return;
    setItemError(null);
    try { await onDelete(item); if (expandedId === item.id) setExpandedId(null); reload(); onMutate?.(); }
    catch (err: any) {
      setItemError({ id: item.id, msg: err.message || `Failed to delete ${itemKind}` });
    }
  };

  const ownItems = items.filter(s => scope === 'org' ? s.agent_id === null : s.agent_id !== null);
  const inheritedItems = scope === 'agent' ? items.filter(s => s.agent_id === null) : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <label className="text-xs text-nebula-muted">
          {scope === 'org' ? orgLabel : agentLabel}
        </label>
        <button onClick={() => setCreating(!creating)} className="text-[12px] text-nebula-accent hover:underline">
          {creating ? 'Cancel' : addLabel}
        </button>
      </div>

      {creating && renderCreateForm({
        onCreated: () => { setCreating(false); reload(); onMutate?.(); },
        onCancel: () => setCreating(false),
      })}

      {ownItems.length === 0 && !creating && (
        <p className="text-nebula-muted text-sm py-4 text-center">{emptyText}</p>
      )}

      {ownItems.map(item => {
        const isExpanded = expandedId === item.id;
        return (
          <div key={item.id} className="bg-nebula-bg border border-nebula-border rounded-lg overflow-hidden">
            <div
              className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-nebula-hover transition-colors"
              onClick={() => setExpandedId(isExpanded ? null : item.id)}
            >
              <label className="flex items-center" onClick={e => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={!!item.enabled}
                  onChange={e => handleUpdate(item, { enabled: (e.target.checked ? 1 : 0) } as Partial<T>)}
                  className="accent-nebula-accent"
                />
              </label>
              <div className="flex-1 min-w-0">
                <span className={`text-[13px] font-medium ${item.enabled ? 'text-nebula-text' : 'text-nebula-muted'}`}>
                  {item.name}
                </span>
                {renderSubtitle(item)}
              </div>
              <button
                onClick={e => { e.stopPropagation(); handleDelete(item); }}
                className="text-nebula-muted hover:text-nebula-red text-xs px-1"
                title="Delete"
              >&times;</button>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                className={`text-nebula-muted transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
                <path d="M6 9l6 6 6-6"/>
              </svg>
            </div>

            {itemError?.id === item.id && (
              <div className="px-3 py-1.5 bg-red-900/20 border-t border-red-600/30">
                <p className="text-xs text-red-400">{itemError.msg}</p>
              </div>
            )}

            {isExpanded && (
              <div className="border-t border-nebula-border p-3 space-y-2">
                {renderEditor(item, { items, setItems, saving, onSave: (updates) => handleUpdate(item, updates) })}
              </div>
            )}
          </div>
        );
      })}

      {inheritedItems.length > 0 && (
        <div className="mt-6">
          <label className="text-xs text-nebula-muted block mb-2">Inherited from organization</label>
          {inheritedItems.map(item => (
            <div key={item.id} className="flex items-center gap-3 px-3 py-2 bg-nebula-bg border border-nebula-border/50 rounded-lg mb-1 opacity-60">
              <span className={`w-2 h-2 rounded-full ${item.enabled ? 'bg-nebula-green' : 'bg-nebula-muted'}`} />
              <div className="flex-1 min-w-0">
                <span className="text-[13px] text-nebula-text">{item.name}</span>
                {renderSubtitle(item)}
              </div>
              <span className="text-[10px] text-nebula-muted">org</span>
            </div>
          ))}
        </div>
      )}

      {footer}
    </div>
  );
}
