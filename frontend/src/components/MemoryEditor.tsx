import { useState, useEffect } from 'react';
import { MemoryMeta, Memory, getAgentMemories, getAgentMemory, createAgentMemory, updateAgentMemory, deleteAgentMemory, searchMemories, MemorySearchResult } from '../api/client';

interface Props {
  agentId: string;
}

export default function MemoryEditor({ agentId }: Props) {
  const [memories, setMemories] = useState<MemoryMeta[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedMemory, setExpandedMemory] = useState<Memory | null>(null);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editContent, setEditContent] = useState('');
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newContent, setNewContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MemorySearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  const refresh = () => {
    getAgentMemories(agentId).then(setMemories).catch(() => {});
  };

  useEffect(() => { refresh(); }, [agentId]);

  const handleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setExpandedMemory(null);
      setEditing(false);
      return;
    }
    try {
      const mem = await getAgentMemory(agentId, id);
      setExpandedId(id);
      setExpandedMemory(mem);
      setEditing(false);
    } catch {}
  };

  const handleEdit = () => {
    if (!expandedMemory) return;
    setEditTitle(expandedMemory.title);
    setEditDesc(expandedMemory.description);
    setEditContent(expandedMemory.content);
    setEditing(true);
  };

  const handleSave = async () => {
    if (!expandedMemory) return;
    setSaving(true);
    setError('');
    try {
      const updated = await updateAgentMemory(agentId, expandedMemory.id, {
        title: editTitle, description: editDesc, content: editContent,
      });
      setExpandedMemory(updated);
      setEditing(false);
      refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = async () => {
    if (!newTitle.trim() || !newDesc.trim() || !newContent.trim()) return;
    setSaving(true);
    setError('');
    try {
      await createAgentMemory(agentId, { title: newTitle.trim(), description: newDesc.trim(), content: newContent.trim() });
      setNewTitle(''); setNewDesc(''); setNewContent('');
      setCreating(false);
      refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string, title: string) => {
    if (!confirm(`Delete memory "${title}"?`)) return;
    try {
      await deleteAgentMemory(agentId, id);
      if (expandedId === id) {
        setExpandedId(null);
        setExpandedMemory(null);
      }
      refresh();
    } catch {}
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) { setSearchResults(null); return; }
    setSearching(true);
    try {
      const results = await searchMemories(searchQuery.trim(), agentId);
      setSearchResults(results);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const clearSearch = () => {
    setSearchQuery('');
    setSearchResults(null);
  };

  return (
    <div className="space-y-3">
      {/* Search */}
      <div className="flex gap-2">
        <input
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
          placeholder="Search memories..."
          className="flex-1 px-3 py-2 bg-nebula-bg border border-nebula-border rounded-lg text-sm text-nebula-text focus:outline-none focus:border-nebula-accent/50"
        />
        {searchResults !== null && (
          <button onClick={clearSearch} className="px-3 py-2 text-xs text-nebula-muted hover:text-nebula-text border border-nebula-border rounded-lg">
            Clear
          </button>
        )}
        <button onClick={handleSearch} disabled={searching}
          className="px-3 py-2 text-xs bg-nebula-accent/10 border border-nebula-accent/20 rounded-lg text-nebula-accent hover:bg-nebula-accent/20 disabled:opacity-50">
          {searching ? '...' : 'Search'}
        </button>
        <button onClick={() => { setCreating(!creating); setError(''); }}
          className="px-3 py-2 text-xs bg-nebula-accent text-nebula-bg rounded-lg hover:brightness-110 font-medium">
          + New
        </button>
      </div>

      {error && <p className="text-nebula-red text-xs">{error}</p>}

      {/* Create form */}
      {creating && (
        <div className="bg-nebula-bg border border-nebula-accent/20 rounded-lg p-3 space-y-2">
          <input value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="Title"
            className="w-full px-3 py-2 bg-nebula-surface border border-nebula-border rounded-lg text-sm text-nebula-text focus:outline-none focus:border-nebula-accent/50" />
          <input value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="One-line description"
            className="w-full px-3 py-2 bg-nebula-surface border border-nebula-border rounded-lg text-sm text-nebula-text focus:outline-none focus:border-nebula-accent/50" />
          <textarea value={newContent} onChange={e => setNewContent(e.target.value)} placeholder="Memory content..." rows={6}
            className="w-full px-3 py-2 bg-nebula-surface border border-nebula-border rounded-lg text-sm text-nebula-text font-mono focus:outline-none focus:border-nebula-accent/50 resize-y" spellCheck={false} />
          <div className="flex justify-end gap-2">
            <button onClick={() => setCreating(false)} className="px-3 py-1.5 text-xs text-nebula-muted hover:text-nebula-text">Cancel</button>
            <button onClick={handleCreate} disabled={saving} className="px-3 py-1.5 text-xs bg-nebula-accent text-nebula-bg rounded-lg hover:brightness-110 disabled:opacity-50 font-medium">
              {saving ? 'Saving...' : 'Create'}
            </button>
          </div>
        </div>
      )}

      {/* Search results */}
      {searchResults !== null && (
        <div>
          <p className="text-xs text-nebula-muted mb-2">{searchResults.length} result{searchResults.length !== 1 ? 's' : ''}</p>
          {searchResults.length === 0 ? (
            <p className="text-sm text-nebula-muted py-4 text-center">No matches found</p>
          ) : (
            <div className="space-y-1.5">
              {searchResults.map(r => (
                <div key={r.id} onClick={() => { clearSearch(); handleExpand(r.id); }} className="bg-nebula-bg border border-nebula-border rounded-lg px-3 py-2 cursor-pointer hover:border-nebula-accent/30">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-nebula-text">{r.title}</span>
                    <span className="text-[10px] text-nebula-muted px-1.5 py-0.5 bg-nebula-surface rounded">{r.source}</span>
                    <span className="text-[10px] text-nebula-muted ml-auto">{r.score.toFixed(2)}</span>
                  </div>
                  <p className="text-xs text-nebula-muted mt-1 line-clamp-2">{r.snippet}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Memory list */}
      {searchResults === null && (
        memories.length === 0 ? (
          <p className="text-sm text-nebula-muted py-4 text-center">No memories yet. The agent stores knowledge here as it learns.</p>
        ) : (
          <div className="space-y-1.5">
            {memories.map(m => (
              <div key={m.id} className="bg-nebula-bg border border-nebula-border rounded-lg overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-nebula-hover" onClick={() => handleExpand(m.id)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    className={`flex-shrink-0 transition-transform ${expandedId === m.id ? 'rotate-90' : ''}`}>
                    <path d="M9 18l6-6-6-6"/>
                  </svg>
                  <span className="text-sm font-medium text-nebula-text truncate">{m.title}</span>
                  <span className="text-xs text-nebula-muted truncate flex-1">{m.description}</span>
                  <button onClick={e => { e.stopPropagation(); handleDelete(m.id, m.title); }}
                    className="text-nebula-muted hover:text-nebula-red flex-shrink-0 p-1">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                  </button>
                </div>

                {expandedId === m.id && expandedMemory && (
                  <div className="border-t border-nebula-border px-3 py-3">
                    {editing ? (
                      <div className="space-y-2">
                        <input value={editTitle} onChange={e => setEditTitle(e.target.value)}
                          className="w-full px-3 py-2 bg-nebula-surface border border-nebula-border rounded-lg text-sm text-nebula-text focus:outline-none focus:border-nebula-accent/50" />
                        <input value={editDesc} onChange={e => setEditDesc(e.target.value)}
                          className="w-full px-3 py-2 bg-nebula-surface border border-nebula-border rounded-lg text-sm text-nebula-text focus:outline-none focus:border-nebula-accent/50" />
                        <textarea value={editContent} onChange={e => setEditContent(e.target.value)} rows={10}
                          className="w-full px-3 py-2 bg-nebula-surface border border-nebula-border rounded-lg text-sm text-nebula-text font-mono focus:outline-none focus:border-nebula-accent/50 resize-y" spellCheck={false} />
                        <div className="flex justify-end gap-2">
                          <button onClick={() => setEditing(false)} className="px-3 py-1.5 text-xs text-nebula-muted hover:text-nebula-text">Cancel</button>
                          <button onClick={handleSave} disabled={saving} className="px-3 py-1.5 text-xs bg-nebula-accent text-nebula-bg rounded-lg hover:brightness-110 disabled:opacity-50 font-medium">
                            {saving ? 'Saving...' : 'Save'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-xs text-nebula-muted">{expandedMemory.description}</p>
                          <button onClick={handleEdit} className="text-xs text-nebula-accent hover:underline">Edit</button>
                        </div>
                        <pre className="text-xs text-nebula-text whitespace-pre-wrap font-mono bg-nebula-surface rounded-lg p-3 max-h-80 overflow-y-auto">{expandedMemory.content}</pre>
                        <p className="text-[10px] text-nebula-muted mt-2">
                          Created {new Date(expandedMemory.created_at + 'Z').toLocaleDateString()} · Updated {new Date(expandedMemory.updated_at + 'Z').toLocaleDateString()}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
