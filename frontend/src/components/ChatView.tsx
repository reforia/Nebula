import { useRef, useEffect, useState, useMemo } from 'react';
import { Agent, Message, Conversation, updateConversation, deleteConversation } from '../api/client';
import ChatPanel from './ChatPanel';

function agentColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const hue = 30 + (Math.abs(hash) % 40);
  return `hsl(${hue}, 55%, 58%)`;
}

interface Props {
  agent: Agent;
  agents: Agent[];
  messages: Message[];
  loading: boolean;
  hasMore: boolean;
  typingAgents: Map<string, { conversationId: string; projectId?: string }>;
  selectedConversationId: string | null;
  onSendMessage: (content: string, images?: File[], replyToId?: string) => void;
  onLoadMore: () => void;
  onOpenSettings: () => void;
  onOpenSidebar: () => void;
  conversations: Conversation[];
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onConversationsChanged: () => void;
  connected?: boolean;
  draft?: string;
  onDraftChange?: (value: string) => void;
  scrollToMessageId?: string | null;
  onScrollToComplete?: () => void;
}

export default function ChatView({
  agent, agents, messages, loading, hasMore, typingAgents, selectedConversationId, onSendMessage, onLoadMore, onOpenSettings, onOpenSidebar,
  conversations, onSelectConversation, onNewConversation, onConversationsChanged, connected, draft, onDraftChange,
  scrollToMessageId, onScrollToComplete,
}: Props) {
  const [convDropdownOpen, setConvDropdownOpen] = useState(false);
  const [editingConvId, setEditingConvId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const convDropdownRef = useRef<HTMLDivElement>(null);

  // Compute which agents are typing in the current conversation
  const typingInConversation = useMemo(() => {
    const names: string[] = [];
    for (const [agentId, info] of typingAgents) {
      if (info.conversationId === selectedConversationId && !info.projectId) {
        const a = agents.find(x => x.id === agentId);
        if (a) names.push(`${a.emoji} ${a.name}`);
      }
    }
    return names;
  }, [typingAgents, selectedConversationId, agents]);

  // Reset dropdown when switching agents
  useEffect(() => {
    setConvDropdownOpen(false);
  }, [agent.id]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!convDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (convDropdownRef.current && !convDropdownRef.current.contains(e.target as Node)) {
        setConvDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [convDropdownOpen]);

  const handleRenameConversation = async (convId: string) => {
    if (!editingTitle.trim()) return;
    try {
      await updateConversation(convId, editingTitle.trim());
      setEditingConvId(null);
      onConversationsChanged();
    } catch (err) {
      console.error('Failed to rename conversation:', err);
    }
  };

  const handleDeleteConversation = async (convId: string) => {
    if (!confirm('Delete this conversation and all its messages?')) return;
    try {
      await deleteConversation(convId);
      onConversationsChanged();
      if (convId === selectedConversationId) {
        const remaining = conversations.filter(c => c.id !== convId);
        if (remaining.length > 0) onSelectConversation(remaining[0].id);
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const selectedConv = conversations.find(c => c.id === selectedConversationId);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center justify-between px-3 sm:px-5 py-2.5 border-b border-nebula-border bg-nebula-surface/80 backdrop-blur-sm">
        <div className="flex items-center gap-2.5 min-w-0">
          <button onClick={onOpenSidebar} className="md:hidden p-1.5 -ml-1 text-nebula-muted hover:text-nebula-text rounded-lg hover:bg-nebula-hover">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
          </button>
          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${agentColor(agent.name)}15` }}>
            <span className="text-base">{agent.emoji}</span>
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold truncate" style={{ color: agentColor(agent.name) }}>{agent.name}</h2>
            <div className="flex items-center gap-2">
              {agent.role && <p className="text-[11px] text-nebula-muted truncate">{agent.role}</p>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-[10px] text-nebula-muted font-mono hidden sm:block">{agent.model}</span>
          {!agent.initialized && agent.enabled && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-nebula-accent/10 text-nebula-accent border border-nebula-accent/20">
              setup needed
            </span>
          )}
          {!agent.enabled && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-nebula-red/10 text-nebula-red border border-nebula-red/20">off</span>
          )}

          {/* Conversation dropdown */}
          <div className="relative" ref={convDropdownRef}>
            <button
              onClick={() => setConvDropdownOpen(!convDropdownOpen)}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[12px] border transition-colors ${
                convDropdownOpen
                  ? 'bg-nebula-accent-glow border-nebula-accent/20 text-nebula-text'
                  : 'bg-nebula-bg border-nebula-border text-nebula-muted hover:text-nebula-text hover:border-nebula-border-light'
              }`}
              title="Conversations"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              <span className="max-w-[100px] truncate hidden sm:inline">{selectedConv?.title || 'Chat'}</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
            </button>

            {convDropdownOpen && (
              <div className="absolute right-0 top-full mt-1 w-72 bg-nebula-surface border border-nebula-border rounded-xl shadow-lg z-50 overflow-hidden">
                <button
                  onClick={() => { onNewConversation(); setConvDropdownOpen(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-[12px] text-nebula-accent hover:bg-nebula-hover border-b border-nebula-border transition-colors"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
                  New conversation
                </button>
                <div className="max-h-64 overflow-y-auto">
                  {conversations.map(conv => {
                    const isActive = conv.id === selectedConversationId;
                    const isEditing = editingConvId === conv.id;
                    return (
                      <div
                        key={conv.id}
                        className={`group flex items-center gap-2 px-3 py-2 text-[12px] transition-colors cursor-pointer ${
                          isActive ? 'bg-nebula-accent-glow' : 'hover:bg-nebula-hover'
                        }`}
                        onClick={() => { if (!isEditing) { onSelectConversation(conv.id); setConvDropdownOpen(false); } }}
                      >
                        <div className="flex-1 min-w-0">
                          {isEditing ? (
                            <input
                              value={editingTitle}
                              onChange={e => setEditingTitle(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') handleRenameConversation(conv.id);
                                if (e.key === 'Escape') setEditingConvId(null);
                              }}
                              onBlur={() => handleRenameConversation(conv.id)}
                              autoFocus
                              className="w-full px-1.5 py-0.5 bg-nebula-bg border border-nebula-accent/30 rounded text-[12px] text-nebula-text focus:outline-none"
                              onClick={e => e.stopPropagation()}
                            />
                          ) : (
                            <>
                              <div className="flex items-center gap-1.5">
                                <span className={`truncate ${isActive ? 'text-nebula-text font-medium' : 'text-nebula-muted'}`}>
                                  {conv.title}
                                </span>
                                {(conv.unread_count || 0) > 0 && (
                                  <span className="bg-nebula-accent text-nebula-bg text-[9px] font-bold px-1 py-0 rounded-full min-w-[14px] text-center">
                                    {conv.unread_count}
                                  </span>
                                )}
                              </div>
                              {conv.last_message && (
                                <p className="text-[10px] text-nebula-muted/60 truncate mt-0.5">{conv.last_message.slice(0, 60)}</p>
                              )}
                            </>
                          )}
                        </div>
                        {!isEditing && (
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                            <button
                              onClick={(e) => { e.stopPropagation(); setEditingConvId(conv.id); setEditingTitle(conv.title); }}
                              className="p-1 rounded hover:bg-nebula-surface-2 text-nebula-muted hover:text-nebula-text"
                              title="Rename"
                            >
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                            </button>
                            {conversations.length > 1 && (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDeleteConversation(conv.id); }}
                                className="p-1 rounded hover:bg-nebula-red/10 text-nebula-muted hover:text-nebula-red"
                                title="Delete"
                              >
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <button
            onClick={onOpenSettings}
            className="p-1.5 text-nebula-muted hover:text-nebula-text rounded-lg hover:bg-nebula-hover transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
          </button>
        </div>
      </header>

      <ChatPanel
        messages={messages}
        agents={agents}
        ownerAgentId={agent.id}
        typingNames={typingInConversation}
        loading={loading}
        hasMore={hasMore}
        onLoadMore={onLoadMore}
        onSend={onSendMessage}
        cancelAgentId={agent.id}
        disabled={!agent.enabled || connected === false}
        disconnected={connected === false}
        draft={draft}
        onDraftChange={onDraftChange}
        resetKey={`${agent.id}:${selectedConversationId}`}
        scrollToMessageId={scrollToMessageId}
        onScrollToComplete={onScrollToComplete}
      />
    </div>
  );
}
