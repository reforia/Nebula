import { useEffect, useRef } from 'react';
import { Agent, Message } from '../api/client'
import MessageBubble from './MessageBubble';

interface Props {
  messages: Message[];
  agents: Agent[];
  ownerAgentId?: string;
  typingNames?: string[];
  highlight?: string;
  matchingIds?: Set<string>;
  emptyText?: string;
  children?: React.ReactNode;
  bottomRef?: React.RefObject<HTMLDivElement>;
  /** Changes when conversation switches — resets scroll behavior to instant */
  resetKey?: string;
  onReply?: (message: Message) => void;
  onScrollToMessage?: (messageId: string) => void;
}

export default function MessageList({
  messages, agents, ownerAgentId, typingNames = [], highlight, matchingIds,
  emptyText = 'No messages yet. Start the conversation.', children, bottomRef: externalBottomRef, resetKey,
  onReply, onScrollToMessage,
}: Props) {
  const internalRef = useRef<HTMLDivElement>(null);
  const bottomRef = externalBottomRef || internalRef;
  const isTyping = typingNames.length > 0;

  const query = highlight && matchingIds ? highlight : undefined;

  return (
    <>
      {messages.length === 0 && !children && (
        <div className="text-center text-nebula-muted/50 py-12 text-sm">
          {emptyText}
        </div>
      )}
      {children}
      {messages.map(msg => {
        const isMatch = matchingIds?.has(msg.id) ?? false;
        const dimmed = query && !isMatch;
        return (
          <div key={msg.id} data-msg-id={msg.id} className={dimmed ? 'opacity-20 transition-opacity' : 'transition-opacity'}>
            <MessageBubble message={msg} ownerAgentId={ownerAgentId} agents={agents} highlight={query && isMatch ? query : undefined} onReply={onReply} onScrollToMessage={onScrollToMessage} />
          </div>
        );
      })}
      {isTyping && (
        <div className="flex justify-start mb-3">
          <div className="bg-nebula-surface border border-nebula-border rounded-xl px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-nebula-muted">{typingNames.join(', ')}</span>
              <div className="flex gap-1.5">
                <span className="w-1.5 h-1.5 bg-nebula-accent/60 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 bg-nebula-accent/60 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 bg-nebula-accent/60 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        </div>
      )}
      <div ref={internalRef} />
    </>
  );
}
