import { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { Agent, Message, cancelAgent } from '../api/client';
import MessageList from './MessageList';
import MessageInput from './MessageInput';

interface Props {
  messages: Message[];
  agents: Agent[];
  ownerAgentId?: string;
  typingNames?: string[];
  loading?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  onSend: (content: string, images?: File[], replyToId?: string) => void;
  /** Agent ID for cancel button — if set, shows cancel when typing */
  cancelAgentId?: string;
  disabled?: boolean;
  /** Show disconnected banner and block input */
  disconnected?: boolean;
  draft?: string;
  onDraftChange?: (value: string) => void;
  /** Reset search when this key changes (e.g. agent.id or project.id) */
  resetKey?: string;
  /** Hide @notify command in input (for project conversations) */
  hideNotify?: boolean;
  /** Scroll to and highlight a specific message (from global search) */
  scrollToMessageId?: string | null;
  /** Called after scroll-to completes so parent can clear the target */
  onScrollToComplete?: () => void;
}

export default function ChatPanel({
  messages, agents, ownerAgentId, typingNames = [],
  loading, hasMore, onLoadMore, onSend,
  cancelAgentId, disabled, disconnected, draft, onDraftChange, resetKey, hideNotify,
  scrollToMessageId, onScrollToComplete,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);

  const isTyping = typingNames.length > 0;
  const initialScroll = useRef(true);

  // Reset search and reply on context change
  useEffect(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setReplyTo(null);
    initialScroll.current = true;
  }, [resetKey]);

  // Auto-scroll: instant on conversation load, smooth on new messages
  useEffect(() => {
    if (messages.length === 0) return;
    const el = containerRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      if (initialScroll.current) {
        el.scrollTop = el.scrollHeight;
        initialScroll.current = false;
      } else {
        // Auto-scroll if user is near the bottom or sent the latest message
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 400;
        const lastMsg = messages[messages.length - 1];
        const userJustSent = lastMsg?.role === 'user';
        if (nearBottom || userJustSent || isTyping) {
          el.scrollTop = el.scrollHeight;
        }
      }
    });
  }, [messages.length, isTyping]);

  // Focus search input when opened
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // Keyboard shortcut: Ctrl/Cmd+F to search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setSearchOpen(prev => !prev);
      }
      if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false);
        setSearchQuery('');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [searchOpen]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (el && el.scrollTop === 0 && hasMore && !loading && onLoadMore) {
      onLoadMore();
    }
  };

  const handleSend = useCallback(async (content: string, images?: File[]) => {
    const replyId = replyTo?.id;
    setReplyTo(null);
    await onSend(content, images, replyId);
  }, [onSend, replyTo]);

  const scrollToMessage = useCallback((messageId: string) => {
    const el = containerRef.current?.querySelector(`[data-msg-id="${messageId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-nebula-accent/40', 'rounded-xl');
      setTimeout(() => el.classList.remove('ring-2', 'ring-nebula-accent/40', 'rounded-xl'), 1500);
    }
  }, []);

  // External scroll-to (from global search)
  useEffect(() => {
    if (!scrollToMessageId || messages.length === 0) return;
    // Small delay to ensure DOM is rendered after messages load
    const timer = setTimeout(() => {
      scrollToMessage(scrollToMessageId);
      onScrollToComplete?.();
    }, 200);
    return () => clearTimeout(timer);
  }, [scrollToMessageId, messages.length]);

  // Filter + highlight
  const query = searchQuery.toLowerCase().trim();
  const matchList = useMemo(() => {
    if (!query) return [];
    return messages.filter(m => m.content.toLowerCase().includes(query)).map(m => m.id);
  }, [messages, query]);
  const matchingIds = useMemo(() => matchList.length > 0 ? new Set(matchList) : undefined, [matchList]);
  const matchCount = matchList.length;
  const [currentMatch, setCurrentMatch] = useState(0);

  // Reset match index when query or matches change
  useEffect(() => { setCurrentMatch(0); }, [matchList.length, query]);

  const scrollToMatch = (index: number) => {
    if (matchList.length === 0) return;
    const wrappedIndex = ((index % matchList.length) + matchList.length) % matchList.length;
    setCurrentMatch(wrappedIndex);
    const msgId = matchList[wrappedIndex];
    const el = containerRef.current?.querySelector(`[data-msg-id="${msgId}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Search toggle + bar */}
      {!searchOpen && (
        <div className="flex justify-end px-3 sm:px-5 pt-1.5">
          <button
            onClick={() => setSearchOpen(true)}
            className="p-1.5 rounded-lg text-nebula-muted/40 hover:text-nebula-muted hover:bg-nebula-hover transition-colors"
            title="Search (Ctrl+F)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          </button>
        </div>
      )}
      {searchOpen && (
        <div className="flex items-center gap-2 px-3 sm:px-5 py-2 border-b border-nebula-border bg-nebula-surface/60">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-nebula-muted flex-shrink-0"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && matchCount > 0) {
                e.preventDefault();
                scrollToMatch(e.shiftKey ? currentMatch - 1 : currentMatch + 1);
              }
            }}
            placeholder="Search messages..."
            className="flex-1 bg-transparent text-[13px] text-nebula-text placeholder:text-nebula-muted/50 focus:outline-none"
          />
          {query && matchCount > 0 && (
            <div className="flex items-center gap-1 flex-shrink-0">
              <span className="text-[11px] text-nebula-muted">{currentMatch + 1}/{matchCount}</span>
              <button onClick={() => scrollToMatch(currentMatch - 1)} className="p-0.5 text-nebula-muted hover:text-nebula-text" title="Previous (Shift+Enter)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m18 15-6-6-6 6"/></svg>
              </button>
              <button onClick={() => scrollToMatch(currentMatch + 1)} className="p-0.5 text-nebula-muted hover:text-nebula-text" title="Next (Enter)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
              </button>
            </div>
          )}
          {query && matchCount === 0 && (
            <span className="text-[11px] text-nebula-muted/50 flex-shrink-0">No matches</span>
          )}
          <button onClick={() => { setSearchOpen(false); setSearchQuery(''); setCurrentMatch(0); }} className="p-1 text-nebula-muted hover:text-nebula-text">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
      )}

      {/* Messages */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 sm:px-5 py-4"
      >
        {loading && messages.length === 0 && (
          <div className="text-center text-nebula-muted py-8 text-sm">Loading...</div>
        )}
        <MessageList
          messages={messages}
          agents={agents}
          ownerAgentId={ownerAgentId}
          typingNames={typingNames}
          highlight={query}
          matchingIds={matchingIds}
          bottomRef={bottomRef}
          resetKey={resetKey}
          onReply={setReplyTo}
          onScrollToMessage={scrollToMessage}
        >
          {hasMore && messages.length > 0 && (
            <button
              onClick={onLoadMore}
              className="block mx-auto mb-4 text-xs text-nebula-muted hover:text-nebula-accent transition-colors"
            >
              Load older messages
            </button>
          )}
        </MessageList>
      </div>

      {disconnected && (
        <div className="px-3 sm:px-5 py-2 bg-nebula-red/5 border-t border-nebula-red/15 text-center">
          <span className="text-[12px] text-nebula-red">Disconnected from server — messages cannot be sent</span>
        </div>
      )}
      <MessageInput
        onSend={handleSend}
        onCancel={cancelAgentId ? () => cancelAgent(cancelAgentId).catch(() => {}) : undefined}
        disabled={disabled || disconnected}
        isTyping={isTyping}
        agents={agents}
        currentAgentId={ownerAgentId}
        draft={draft}
        onDraftChange={onDraftChange}
        hideNotify={hideNotify}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
      />
    </div>
  );
}
