import { useState, useEffect, useRef } from 'react';
import { Agent, Project, SearchResult, searchMessages } from '../api/client';
import OrgSwitcher from './OrgSwitcher';
import FeedbackModal from './FeedbackModal';
import { useAuth } from '../contexts/AuthContext';

function agentColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const hue = 30 + (Math.abs(hash) % 40);
  return `hsl(${hue}, 55%, 58%)`;
}

interface Props {
  agents: Agent[];
  projects: Project[];
  selectedAgentId: string | null;
  selectedProjectId: string | null;
  typingAgents: Map<string, { conversationId: string; projectId?: string }>;
  onSelectAgent: (id: string) => void;
  onSelectProject: (id: string) => void;
  onNavigate: (target: { agentId?: string; conversationId?: string; projectId?: string; messageId?: string }) => void;
  onNewAgent: () => void;
  onNewProject: () => void;
  onSettings: () => void;
  onCalendar: () => void;
  connected: boolean;
  mobileOpen: boolean;
  onMobileClose: () => void;
}

export default function Sidebar({ agents, projects, selectedAgentId, selectedProjectId, typingAgents, onSelectAgent, onSelectProject, onNavigate, onNewAgent, onNewProject, onSettings, onCalendar, connected, mobileOpen, onMobileClose }: Props) {
  const [search, setSearch] = useState('');
  const { user, platformUrl, license, logout } = useAuth();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const lcSearch = search.toLowerCase();
  const filtered = agents.filter(a =>
    a.name.toLowerCase().includes(lcSearch) ||
    a.role.toLowerCase().includes(lcSearch)
  );
  const filteredProjects = search
    ? projects.filter(p => p.name.toLowerCase().includes(lcSearch))
    : projects;

  // Debounced message search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (search.trim().length < 3) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      searchMessages(search.trim(), 20)
        .then(setSearchResults)
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search]);

  const handleSelect = (id: string) => {
    onSelectAgent(id);
    onMobileClose();
  };

  return (
    <>
      {mobileOpen && (
        <div className="fixed inset-0 bg-black/60 z-40 md:hidden" onClick={onMobileClose} />
      )}

      <aside className={`
        fixed md:relative z-50 md:z-auto
        w-[280px] md:w-[260px] flex-shrink-0
        bg-nebula-surface border-r border-nebula-border
        flex flex-col h-full
        transition-transform duration-200 ease-out
        ${mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}>
        {/* Header */}
        <div className="p-4 pb-3">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-nebula-accent to-nebula-gold-dim flex items-center justify-center">
                <span className="text-xs font-bold text-nebula-bg">N</span>
              </div>
              <h1 className="text-[15px] font-semibold tracking-tight text-nebula-text">Nebula</h1>
            </div>
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-nebula-green' : 'bg-nebula-red'}`} title={connected ? 'Connected' : 'Disconnected'} />
              <button onClick={onMobileClose} className="md:hidden p-1 text-nebula-muted hover:text-nebula-text">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
          </div>

          {/* Org Switcher */}
          <OrgSwitcher />

          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full px-3 py-2 mt-2 text-[13px] bg-nebula-bg border border-nebula-border rounded-lg focus:outline-none focus:border-nebula-accent/50 text-nebula-text placeholder:text-nebula-muted/60 transition-colors"
          />
        </div>

        {/* Projects section */}
        {filteredProjects.length > 0 && (
          <div className="px-2 py-1">
            <p className="text-[10px] uppercase tracking-wider text-nebula-muted/60 font-semibold px-3 mb-1">Projects</p>
            {filteredProjects.map(proj => {
              const isSelected = proj.id === selectedProjectId;
              const progress = (proj.deliverable_count && proj.deliverables_done != null)
                ? Math.round((proj.deliverables_done / proj.deliverable_count) * 100)
                : 0;
              return (
                <button
                  key={proj.id}
                  onClick={() => { onSelectProject(proj.id); onMobileClose(); }}
                  className={`w-full text-left px-3 py-2 flex items-center gap-3 rounded-lg mb-0.5 transition-all duration-150 ${
                    isSelected
                      ? 'bg-nebula-accent-glow border border-nebula-accent/20'
                      : 'hover:bg-nebula-hover border border-transparent'
                  }`}
                >
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 text-[11px] font-bold ${
                    isSelected ? 'bg-nebula-accent/15 text-nebula-accent' : 'bg-nebula-surface-2 text-nebula-muted'
                  }`}>
                    P
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-[13px] truncate ${isSelected ? 'font-semibold text-nebula-accent' : 'font-medium text-nebula-text/90'}`}>
                        {proj.name}
                      </span>
                      {(proj.unread_count || 0) > 0 && (
                        <span className="bg-nebula-accent text-nebula-bg text-[9px] font-bold px-1 py-0 rounded-full min-w-[14px] text-center flex-shrink-0">
                          {proj.unread_count}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      {proj.deliverable_count ? (
                        <>
                          <div className="flex-1 bg-nebula-bg rounded-full h-1 max-w-[60px]">
                            <div className="bg-nebula-accent rounded-full h-1 transition-all" style={{ width: `${progress}%` }} />
                          </div>
                          <span className="text-[10px] text-nebula-muted">{progress}%</span>
                        </>
                      ) : (
                        <span className="text-[10px] text-nebula-muted">{proj.status}</span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
            <div className="border-b border-nebula-border/50 my-2 mx-3" />
          </div>
        )}

        {/* Agent list */}
        <p className="text-[10px] uppercase tracking-wider text-nebula-muted/60 font-semibold px-5 mb-1">Agents</p>
        <div className="flex-1 overflow-y-auto px-2 py-1">
          {filtered.map(agent => {
            const isSelected = agent.id === selectedAgentId;
            const typingInfo = typingAgents.get(agent.id);
            const isTyping = !!typingInfo && !typingInfo.projectId;
            const unread = agent.unread_count || 0;
            const color = agentColor(agent.name);

            return (
              <button
                key={agent.id}
                onClick={() => handleSelect(agent.id)}
                className={`w-full text-left px-3 py-2.5 flex items-center gap-3 rounded-lg mb-0.5 transition-all duration-150 ${
                  isSelected
                    ? 'bg-nebula-accent-glow border border-nebula-accent/20'
                    : 'hover:bg-nebula-hover border border-transparent'
                } ${!agent.enabled ? 'opacity-40' : ''}`}
              >
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 text-base ${
                  isSelected ? 'shadow-glow' : ''
                }`} style={{ background: isSelected ? `${color}15` : '#1a1a1f' }}>
                  {agent.emoji}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-[13px] truncate ${isSelected ? 'font-semibold' : 'font-medium'}`} style={{ color: isSelected ? color : '#c8c5be' }}>
                      {agent.name}
                    </span>
                    {agent.execution_mode === 'remote' && (
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${(agent as any).remote_connected ? 'bg-nebula-green' : 'bg-nebula-muted/40'}`}
                        title={(agent as any).remote_device_info?.hostname || 'Remote'} />
                    )}
                    {isTyping && (
                      <span className="text-[10px] text-nebula-accent animate-pulse font-medium">typing</span>
                    )}
                  </div>
                  <p className="text-[11px] text-nebula-muted truncate mt-0.5">
                    {(agent as any).last_message
                      ? (agent as any).last_message.slice(0, 80)
                      : agent.role || 'No messages yet'}
                  </p>
                </div>
                {unread > 0 && (
                  <span className="bg-nebula-accent text-nebula-bg text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
                    {unread}
                  </span>
                )}
              </button>
            );
          })}
          {filtered.length === 0 && !search && (
            <p className="text-center text-nebula-muted text-sm py-12">No agents yet</p>
          )}
          {search && filtered.length === 0 && filteredProjects.length === 0 && searchResults.length === 0 && !searching && (
            <p className="text-center text-nebula-muted text-sm py-12">No results</p>
          )}

          {/* Message search results */}
          {search.trim().length >= 3 && (searchResults.length > 0 || searching) && (
            <div className="mt-2 pt-2 border-t border-nebula-border/50">
              <p className="text-[10px] uppercase tracking-wider text-nebula-muted/60 font-semibold px-3 mb-1">
                {searching ? 'Searching...' : `Messages (${searchResults.length})`}
              </p>
              {searchResults.map(r => (
                <button
                  key={r.id}
                  onClick={() => {
                    if (r.project_id) {
                      onNavigate({ projectId: r.project_id, messageId: r.id });
                    } else {
                      onNavigate({ agentId: r.agent_id, conversationId: r.conversation_id, messageId: r.id });
                    }
                    onMobileClose();
                  }}
                  className="w-full text-left px-3 py-2 rounded-lg mb-0.5 hover:bg-nebula-hover border border-transparent transition-colors"
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-[11px]">{r.project_id ? 'P' : (r.agent_emoji || '')}</span>
                    <span className="text-[11px] font-medium text-nebula-text truncate">
                      {r.project_id ? r.project_name : r.agent_name}
                    </span>
                    <span className="text-[10px] text-nebula-muted ml-auto flex-shrink-0">
                      {new Date(r.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                  <p className="text-[11px] text-nebula-muted line-clamp-2 break-words">{r.snippet}</p>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* License badge */}
        {license?.plan_name && (
          <div className="px-4 py-2 border-t border-nebula-border/50">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-nebula-accent/10 border border-nebula-accent/20 rounded-full text-[10px] font-semibold text-nebula-accent uppercase tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-nebula-accent" />
              {license.plan_name}
            </span>
          </div>
        )}

        {/* Footer */}
        <div className="p-3 border-t border-nebula-border flex items-center gap-1.5">
          {/* New button with dropdown */}
          <div className="relative flex-1">
            <button
              onClick={() => setShowNewMenu(!showNewMenu)}
              className="w-full py-2 text-[13px] bg-nebula-accent text-nebula-bg rounded-lg hover:brightness-110 font-semibold transition-all shadow-glow flex items-center justify-center gap-1.5"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14"/></svg>
              New
            </button>
            {showNewMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowNewMenu(false)} />
                <div className="absolute bottom-full left-0 mb-2 w-full bg-nebula-surface-2 border border-nebula-border rounded-lg shadow-lg z-50 py-1">
                  <button
                    onClick={() => { setShowNewMenu(false); onNewAgent(); }}
                    className="w-full text-left px-3 py-2 text-[12px] text-nebula-text hover:bg-nebula-hover transition-colors flex items-center gap-2"
                  >
                    <span className="text-nebula-accent">+</span> Agent
                  </button>
                  <button
                    onClick={() => { setShowNewMenu(false); onNewProject(); }}
                    className="w-full text-left px-3 py-2 text-[12px] text-nebula-text hover:bg-nebula-hover transition-colors flex items-center gap-2"
                  >
                    <span className="text-nebula-accent">+</span> Project
                  </button>
                </div>
              </>
            )}
          </div>
          <button
            onClick={onCalendar}
            className="p-2 bg-nebula-surface-2 border border-nebula-border rounded-lg hover:bg-nebula-hover hover:border-nebula-border-light transition-colors text-nebula-muted"
            title="Task Calendar"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
          </button>
          <button
            onClick={onSettings}
            className="p-2 bg-nebula-surface-2 border border-nebula-border rounded-lg hover:bg-nebula-hover hover:border-nebula-border-light transition-colors text-nebula-muted"
            title="Settings"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          {/* User avatar */}
          <div className="relative">
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="w-9 h-9 rounded-lg bg-nebula-bg border border-nebula-border flex items-center justify-center text-[11px] font-bold text-nebula-muted hover:text-nebula-text hover:border-nebula-border-light transition-colors"
              title={user?.email}
            >
              {user?.name?.charAt(0)?.toUpperCase() || '?'}
            </button>
            {showUserMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowUserMenu(false)} />
                <div className="absolute bottom-full right-0 mb-2 w-40 bg-nebula-surface-2 border border-nebula-border rounded-lg shadow-lg z-50 py-1">
                  <div className="px-3 py-2 border-b border-nebula-border">
                    <p className="text-[11px] text-nebula-text font-medium truncate">{user?.name}</p>
                    <p className="text-[10px] text-nebula-muted truncate">{user?.email}</p>
                  </div>
                  {platformUrl && (
                    <>
                      <a
                        href={`${platformUrl}/account`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => setShowUserMenu(false)}
                        className="block w-full text-left px-3 py-2 text-[12px] text-nebula-text hover:bg-nebula-hover transition-colors"
                      >
                        Account Settings
                      </a>
                      <a
                        href={`${platformUrl}/pricing`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => setShowUserMenu(false)}
                        className="block w-full text-left px-3 py-2 text-[12px] text-nebula-accent hover:bg-nebula-hover transition-colors"
                      >
                        Upgrade Plan
                      </a>
                    </>
                  )}
                  <button
                    onClick={() => { setShowUserMenu(false); setShowFeedback(true); }}
                    className="w-full text-left px-3 py-2 text-[12px] text-nebula-text hover:bg-nebula-hover transition-colors"
                  >
                    Send Feedback
                  </button>
                  <button
                    onClick={() => { setShowUserMenu(false); logout(); }}
                    className="w-full text-left px-3 py-2 text-[12px] text-red-400 hover:bg-nebula-hover transition-colors"
                  >
                    Sign Out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </aside>
      {showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} />}
    </>
  );
}
