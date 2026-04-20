import { useState, useEffect, useCallback } from 'react';
import { useWebSocket, WSMessage } from '../hooks/useWebSocket';
import { useAgents } from '../hooks/useAgents';
import { useProjects } from '../hooks/useProjects';
import { useMessages } from '../hooks/useMessages';
import { markRead, sendMessage as apiSendMessage, uploadImage, logout, getConversations, createConversation, Conversation } from '../api/client';
import Sidebar from '../components/Sidebar';
import ChatView from '../components/ChatView';
import AgentForm from '../components/AgentForm';
import AgentSettings from '../components/AgentSettings';
import GlobalSettings from '../components/GlobalSettings';
import TaskCalendar from '../components/TaskCalendar';
import ProjectWizard from '../components/ProjectWizard';
import ProjectView from '../components/ProjectView';
import { ErrorBoundary } from '../components/ErrorBoundary';

export default function AppShell({ onLogout }: { onLogout: () => void }) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [typingAgents, setTypingAgents] = useState<Map<string, { conversationId: string; projectId?: string }>>(new Map());
  const [showAgentForm, setShowAgentForm] = useState(false);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [showAgentSettings, setShowAgentSettings] = useState(false);
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [authError, setAuthError] = useState<string | null>(null);
  const [pendingConversationId, setPendingConversationId] = useState<string | null>(null);

  const { connected, subscribe, send } = useWebSocket();
  const { agents, loading: agentsLoading, refresh: refreshAgents, updateUnreadCounts, updateLastMessage } = useAgents();
  const { projects, refresh: refreshProjects, updateProjectUnreadCounts } = useProjects();
  const { messages, loading: msgsLoading, loadMessages, loadMore, hasMore, addMessage, clear } = useMessages(selectedAgentId, selectedConversationId);

  const selectedAgent = agents.find(a => a.id === selectedAgentId) || null;

  // Note: stale typing indicators are cleared via 'ws_connected' event in the subscribe handler below

  const loadConversations = useCallback(async (agentId: string) => {
    try {
      const convs = await getConversations(agentId);
      setConversations(convs);
      return convs;
    } catch (err) {
      console.error('Failed to load conversations:', err);
      return [];
    }
  }, []);

  const clearConversationUnread = useCallback((convId: string) => {
    setConversations(prev => prev.map(c =>
      c.id === convId ? { ...c, unread_count: 0 } : c
    ));
  }, []);

  // When agent changes: load conversations, select the most recent, load its messages
  useEffect(() => {
    if (selectedAgentId) {
      clear();
      setSelectedConversationId(null);
      loadConversations(selectedAgentId).then((convs) => {
        if (pendingConversationId && convs.some(c => c.id === pendingConversationId)) {
          setSelectedConversationId(pendingConversationId);
          loadMessages(selectedAgentId, pendingConversationId);
          markRead(selectedAgentId, pendingConversationId).catch(() => {});
          clearConversationUnread(pendingConversationId);
          send({ type: 'mark_read', agent_id: selectedAgentId });
          setPendingConversationId(null);
        } else if (convs.length > 0) {
          setPendingConversationId(null);
          const latest = convs[0];
          setSelectedConversationId(latest.id);
          loadMessages(selectedAgentId, latest.id);
          markRead(selectedAgentId, latest.id).catch(() => {});
          clearConversationUnread(latest.id);
          send({ type: 'mark_read', agent_id: selectedAgentId });
        }
      });
    } else {
      setConversations([]);
      setSelectedConversationId(null);
      setPendingConversationId(null);
    }
  }, [selectedAgentId, loadConversations, loadMessages, clear, send, pendingConversationId, clearConversationUnread]);

  // When conversation changes (within same agent): load messages
  const handleSelectConversation = useCallback((convId: string) => {
    if (convId === selectedConversationId || !selectedAgentId) return;
    clear();
    setSelectedConversationId(convId);
    loadMessages(selectedAgentId, convId);
    markRead(selectedAgentId, convId).catch(() => {});
    clearConversationUnread(convId);
    send({ type: 'mark_read', agent_id: selectedAgentId });
  }, [selectedAgentId, selectedConversationId, clear, loadMessages, send]);

  const handleNewConversation = useCallback(async () => {
    if (!selectedAgentId) return;
    try {
      const conv = await createConversation(selectedAgentId);
      setConversations(prev => [conv, ...prev]);
      clear();
      setSelectedConversationId(conv.id);
      // No messages to load — it's empty
    } catch (err: any) {
      console.error('Failed to create conversation:', err);
    }
  }, [selectedAgentId, clear]);

  const refreshConversations = useCallback(() => {
    if (selectedAgentId) loadConversations(selectedAgentId);
  }, [selectedAgentId, loadConversations]);

  useEffect(() => {
    return subscribe((msg: WSMessage) => {
      switch (msg.type) {
        case 'ws_connected' as any:
          // Clear stale typing state before server sends snapshot
          setTypingAgents(new Map());
          // Re-mark current conversation as read so badges clear after reconnect
          if (selectedAgentId) {
            markRead(selectedAgentId, selectedConversationId || undefined).catch(() => {});
            if (selectedConversationId) clearConversationUnread(selectedConversationId);
            send({ type: 'mark_read', agent_id: selectedAgentId });
          }
          break;
        case 'new_message':
          if (msg.message && msg.agent_id) {
            // Only update sidebar preview if the message is in the agent's own conversation.
            // @mention responses (agent B responding in A's conversation) have
            // conversation_owner set so we can distinguish.
            if (!msg.conversation_owner || msg.conversation_owner === msg.agent_id) {
              updateLastMessage(msg.agent_id, msg.message.content);
            }
            // Update conversation last_message in local state
            if (msg.message.conversation_id) {
              setConversations(prev => prev.map(c =>
                c.id === msg.message!.conversation_id
                  ? { ...c, last_message: msg.message!.content, last_message_at: msg.message!.created_at }
                  : c
              ));
            }
            // Add to chat view if the message is in the active conversation
            // (supports @mention responses from other agents in the same conversation)
            if (msg.message.conversation_id === selectedConversationId ||
                (msg.agent_id === selectedAgentId && !msg.message.conversation_id)) {
              addMessage(msg.message);
              if (selectedAgentId) {
                markRead(selectedAgentId, selectedConversationId || undefined).catch(() => {});
                if (selectedConversationId) clearConversationUnread(selectedConversationId);
                send({ type: 'mark_read', agent_id: selectedAgentId });
              }
            }
          }
          break;
        case 'agent_typing':
          if (msg.agent_id) {
            setTypingAgents(prev => {
              const next = new Map(prev);
              if (msg.active && msg.conversation_id) {
                next.set(msg.agent_id!, { conversationId: msg.conversation_id, projectId: msg.project_id });
              } else {
                next.delete(msg.agent_id!);
              }
              return next;
            });
          }
          break;
        case 'unread_update':
          if (msg.counts) updateUnreadCounts(msg.counts);
          if (msg.projectCounts) updateProjectUnreadCounts(msg.projectCounts);
          break;
        case 'remote_agent_status':
          refreshAgents();
          break;
        case 'runtime_auth_error':
          setAuthError((msg as any).message || 'CLI runtime auth expired');
          break;
      }
    });
  }, [subscribe, selectedAgentId, selectedConversationId, addMessage, updateUnreadCounts, updateProjectUnreadCounts, updateLastMessage, send]);

  const handleSendMessage = useCallback(async (content: string, images: File[] = [], replyToId?: string) => {
    if (!selectedAgentId) return;
    let imageIds: string[] = [];
    if (images.length > 0) {
      const uploads = await Promise.all(images.map(f => uploadImage(selectedAgentId, f)));
      imageIds = uploads.map(u => u.id);
    }
    const msg = await apiSendMessage(selectedAgentId, content, selectedConversationId || undefined, imageIds.length > 0 ? imageIds : undefined, replyToId);
    addMessage(msg);
    setDrafts(prev => ({ ...prev, [selectedAgentId]: '' }));
  }, [selectedAgentId, selectedConversationId, addMessage]);

  // Pending scroll-to target after navigation completes
  const [scrollToMessageId, setScrollToMessageId] = useState<string | null>(null);

  const handleNavigate = useCallback(({ agentId, conversationId, projectId, messageId }: { agentId?: string; conversationId?: string; projectId?: string; messageId?: string }) => {
    if (projectId) {
      setSelectedProjectId(projectId);
      setSelectedAgentId(null);
      setShowCalendar(false);
      if (messageId) setScrollToMessageId(messageId);
    } else if (agentId) {
      setShowCalendar(false);
      setSelectedProjectId(null);
      if (agentId === selectedAgentId && conversationId && conversationId !== selectedConversationId) {
        clear();
        setSelectedConversationId(conversationId);
        loadMessages(agentId, conversationId);
        if (messageId) setScrollToMessageId(messageId);
      } else if (agentId !== selectedAgentId) {
        setSelectedAgentId(agentId);
        if (conversationId) {
          setPendingConversationId(conversationId);
          if (messageId) setScrollToMessageId(messageId);
        }
      } else {
        if (messageId) setScrollToMessageId(messageId);
      }
    }
  }, [selectedAgentId, selectedConversationId, clear, loadMessages]);

  const handleLogout = async () => {
    await logout();
    onLogout();
  };

  return (
    <ErrorBoundary>
    <div className="flex h-[100dvh] bg-nebula-bg overflow-hidden">
      <Sidebar
        agents={agents}
        projects={projects}
        selectedAgentId={selectedAgentId}
        selectedProjectId={selectedProjectId}
        typingAgents={typingAgents}
        onSelectAgent={(id) => { setSelectedAgentId(id); setSelectedProjectId(null); setShowCalendar(false); }}
        onSelectProject={(id) => { setSelectedProjectId(id); setSelectedAgentId(null); setShowCalendar(false); }}
        onNavigate={handleNavigate}
        onNewAgent={() => setShowAgentForm(true)}
        onNewProject={() => setShowProjectForm(true)}
        onSettings={() => setShowGlobalSettings(true)}
        onCalendar={() => { setShowCalendar(true); setSelectedAgentId(null); setSelectedProjectId(null); }}
        connected={connected}
        mobileOpen={mobileSidebarOpen}
        onMobileClose={() => setMobileSidebarOpen(false)}
      />

      <main className="flex-1 flex flex-col min-w-0">
        {authError && (
          <div className="bg-red-900/80 border-b border-red-700 px-4 py-2 flex items-center justify-between text-sm">
            <span className="text-red-200">{authError}</span>
            <button onClick={() => setAuthError(null)} className="text-red-400 hover:text-red-200 ml-4 shrink-0">&times;</button>
          </div>
        )}
        {showCalendar ? (
          <TaskCalendar onClose={() => setShowCalendar(false)} />
        ) : selectedProjectId ? (
          <ProjectView projectId={selectedProjectId} agents={agents} typingAgents={typingAgents} subscribe={subscribe} connected={connected} onProjectDeleted={() => { setSelectedProjectId(null); refreshProjects(); }} onRead={refreshProjects} onOpenSidebar={() => setMobileSidebarOpen(true)} scrollToMessageId={scrollToMessageId} onScrollToComplete={() => setScrollToMessageId(null)} />
        ) : selectedAgent ? (
          <ChatView
            agent={selectedAgent}
            agents={agents}
            messages={messages}
            loading={msgsLoading}
            hasMore={hasMore}
            typingAgents={typingAgents}
            selectedConversationId={selectedConversationId}
            onSendMessage={handleSendMessage}
            onLoadMore={loadMore}
            onOpenSettings={() => setShowAgentSettings(true)}
            onOpenSidebar={() => setMobileSidebarOpen(true)}
            conversations={conversations}
            onSelectConversation={handleSelectConversation}
            onNewConversation={handleNewConversation}
            onConversationsChanged={refreshConversations}
            connected={connected}
            draft={selectedAgentId ? drafts[selectedAgentId] || '' : ''}
            onDraftChange={(v) => selectedAgentId && setDrafts(prev => ({ ...prev, [selectedAgentId]: v }))}
            scrollToMessageId={scrollToMessageId}
            onScrollToComplete={() => setScrollToMessageId(null)}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center px-4">
            <button
              onClick={() => setMobileSidebarOpen(true)}
              className="md:hidden mb-6 px-4 py-2 text-sm bg-nebula-surface border border-nebula-border rounded-lg text-nebula-muted"
            >
              Open sidebar
            </button>
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-nebula-accent to-nebula-gold-dim flex items-center justify-center mb-5 shadow-glow-lg">
              <span className="text-xl font-bold text-nebula-bg">N</span>
            </div>
            <p className="text-nebula-muted text-[15px]">Select an agent or project</p>
            <p className="text-nebula-muted/50 text-sm mt-1">or create a new one</p>
          </div>
        )}
      </main>

      {showProjectForm && (
        <ProjectWizard
          agents={agents}
          onClose={() => setShowProjectForm(false)}
          onCreated={() => { refreshProjects(); }}
        />
      )}

      {showAgentForm && (
        <AgentForm
          onClose={() => setShowAgentForm(false)}
          onCreated={(agent) => {
            refreshAgents();
            setSelectedAgentId(agent.id);
            setShowAgentForm(false);
          }}
        />
      )}

      {showAgentSettings && selectedAgent && (
        <AgentSettings
          agent={selectedAgent}
          conversationId={selectedConversationId}
          onClose={() => setShowAgentSettings(false)}
          onUpdated={() => refreshAgents()}
          onDeleted={() => {
            setSelectedAgentId(null);
            setShowAgentSettings(false);
            refreshAgents();
          }}
        />
      )}

      {showGlobalSettings && (
        <GlobalSettings
          onClose={() => setShowGlobalSettings(false)}
          onLogout={handleLogout}
          onRefresh={() => { refreshAgents(); refreshProjects(); }}
        />
      )}
    </div>
    </ErrorBoundary>
  );
}
