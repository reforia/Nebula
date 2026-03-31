import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { createOrg } from '../api/client';

export default function OrgSwitcher() {
  const { orgs, currentOrg, switchOrg, refresh } = useAuth();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const handleSwitch = async (orgId: string) => {
    if (orgId === currentOrg?.id) {
      setOpen(false);
      return;
    }
    await switchOrg(orgId);
    setOpen(false);
    // Force page reload to reset all state
    window.location.reload();
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      const org = await createOrg(newName.trim());
      setNewName('');
      setCreating(false);
      await refresh();
      await handleSwitch(org.id);
    } catch (err: any) {
      console.error('Failed to create org:', err);
    }
  };

  if (orgs.length <= 1 && !open) {
    // Single org — show name but still clickable to create new
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full px-3 py-1.5 text-left text-[11px] text-nebula-muted hover:text-nebula-text transition-colors truncate"
        title={currentOrg?.name}
      >
        {currentOrg?.name || 'Organization'}
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-3 py-1.5 text-left text-[11px] text-nebula-muted hover:text-nebula-text transition-colors truncate flex items-center gap-1"
      >
        <span className="truncate">{currentOrg?.name || 'Organization'}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => { setOpen(false); setCreating(false); }} />
          <div className="absolute left-2 right-2 top-full mt-1 bg-nebula-surface-2 border border-nebula-border rounded-lg shadow-lg z-50 py-1 max-h-64 overflow-y-auto">
            {orgs.map(org => (
              <button
                key={org.id}
                onClick={() => handleSwitch(org.id)}
                className={`w-full text-left px-3 py-2 text-[12px] hover:bg-nebula-hover transition-colors ${
                  org.id === currentOrg?.id ? 'text-nebula-accent font-medium' : 'text-nebula-text'
                }`}
              >
                {org.name}
              </button>
            ))}

            <div className="border-t border-nebula-border mt-1 pt-1">
              {creating ? (
                <form onSubmit={handleCreate} className="px-3 py-2">
                  <input
                    type="text"
                    placeholder="Organization name"
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    className="w-full px-2 py-1.5 text-[12px] bg-nebula-bg border border-nebula-border rounded text-nebula-text focus:outline-none focus:border-nebula-accent/50"
                    autoFocus
                  />
                  <div className="flex gap-1 mt-2">
                    <button type="submit" className="flex-1 py-1 text-[11px] bg-nebula-accent text-nebula-bg rounded font-medium">Create</button>
                    <button type="button" onClick={() => setCreating(false)} className="flex-1 py-1 text-[11px] text-nebula-muted hover:text-nebula-text rounded">Cancel</button>
                  </div>
                </form>
              ) : (
                <button
                  onClick={() => setCreating(true)}
                  className="w-full text-left px-3 py-2 text-[12px] text-nebula-muted hover:text-nebula-accent hover:bg-nebula-hover transition-colors"
                >
                  + New Organization
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
