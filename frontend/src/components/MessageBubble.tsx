import { Agent, Message } from '../api/client';
import MarkdownRenderer from './MarkdownRenderer';
import StatusBadge from './StatusBadge';
import ToolHistory from './ToolHistory';

function bubbleStyle({ isInterAgent, alignRight, isError, hasAgent }: { isInterAgent: boolean; alignRight: boolean; isError: boolean; hasAgent: boolean }) {
  if (isInterAgent) return 'bg-nebula-surface border border-nebula-accent/15 text-nebula-text';
  if (alignRight) return 'bg-nebula-accent/10 border border-nebula-accent/15 text-nebula-text';
  if (isError) return 'bg-nebula-red/5 border border-nebula-red/15 text-nebula-red/90';
  if (hasAgent) return 'bg-nebula-surface border border-nebula-accent/15 text-nebula-text';
  return 'bg-nebula-surface border border-nebula-border text-nebula-text';
}

interface Props {
  message: Message;
  ownerAgentId?: string;
  agents?: Agent[];
  highlight?: string;
  onReply?: (message: Message) => void;
  onScrollToMessage?: (messageId: string) => void;
}

export default function MessageBubble({ message, ownerAgentId, agents, highlight, onReply, onScrollToMessage }: Props) {
  const isUser = message.role === 'user';
  const isError = message.message_type === 'error';
  const isSystem = message.message_type === 'system';
  const isInterAgent = message.message_type === 'agent' && isUser;

  // Resolve agent info for all assistant messages (shows who's talking)
  const respondingAgent = !isUser && message.agent_id && agents ? agents.find(a => a.id === message.agent_id) : null;
  const isGuestAgent = respondingAgent && ownerAgentId && message.agent_id !== ownerAgentId;

  const time = new Date(message.created_at + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  let meta: { duration_ms?: number; total_cost_usd?: number; from_agent_name?: string; from_agent_emoji?: string; images?: { id: string; filename: string }[]; tool_history?: { name: string; input: Record<string, any>; output?: string; error?: boolean }[] } | null = null;
  if (message.metadata) {
    try { meta = JSON.parse(message.metadata); } catch {}
  }

  // Resolve quoted message agent name
  const replyTo = message.reply_to;
  let replyAgentLabel = 'You';
  if (replyTo && replyTo.role === 'assistant' && replyTo.agent_id && agents) {
    const a = agents.find(x => x.id === replyTo.agent_id);
    if (a) replyAgentLabel = `${a.emoji} ${a.name}`;
  }

  if (isSystem) {
    return (
      <div className="flex justify-center my-3">
        <span className="text-[11px] text-nebula-muted bg-nebula-surface px-3 py-1 rounded-full border border-nebula-border">
          {message.content}
        </span>
      </div>
    );
  }

  // Inter-agent messages render left-aligned with source agent badge
  const alignRight = isUser && !isInterAgent;

  return (
    <div className={`group flex mb-4 ${alignRight ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] sm:max-w-[75%] ${alignRight ? 'order-1' : ''} relative`}>
        {/* Action buttons — appear on hover */}
        {!isSystem && (
          <div className={`absolute -top-3 ${alignRight ? 'left-1' : 'right-1'} opacity-0 group-hover:opacity-100 transition-opacity flex gap-0.5 z-10`}>
            <button
              onClick={() => {
                if (navigator.clipboard?.writeText) {
                  navigator.clipboard.writeText(message.content).catch(e => console.warn('[clipboard] copy failed:', e));
                } else {
                  // Fallback for non-secure contexts (HTTP on LAN)
                  const ta = document.createElement('textarea');
                  ta.value = message.content;
                  ta.style.position = 'fixed';
                  ta.style.opacity = '0';
                  document.body.appendChild(ta);
                  ta.select();
                  document.execCommand('copy');
                  document.body.removeChild(ta);
                }
              }}
              className="bg-nebula-surface border border-nebula-border rounded-md px-1.5 py-0.5 text-[11px] text-nebula-text/70 hover:text-nebula-accent hover:border-nebula-accent/30"
              title="Copy"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            </button>
            {onReply && <button
              onClick={() => onReply(message)}
              className="bg-nebula-surface border border-nebula-border rounded-md px-1.5 py-0.5 text-[11px] text-nebula-text/70 hover:text-nebula-accent hover:border-nebula-accent/30"
              title="Reply"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/></svg>
            </button>}
          </div>
        )}
        <div className={`flex items-center gap-2 mb-1 ${alignRight ? 'justify-end' : ''}`}>
          {isInterAgent && meta?.from_agent_name && (
            <span className="text-[10px] text-nebula-accent font-medium">
              {meta.from_agent_emoji} {meta.from_agent_name}
            </span>
          )}
          {respondingAgent && (
            <span className="text-[10px] text-nebula-accent font-medium">
              {respondingAgent.emoji} {respondingAgent.name}
            </span>
          )}
          <StatusBadge type={message.message_type as any} taskName={message.task_name || undefined} />
          <span className="text-[10px] text-nebula-muted/70">{time}</span>
          {meta?.duration_ms && (
            <span className="text-[10px] text-nebula-muted/50">{(meta.duration_ms / 1000).toFixed(1)}s</span>
          )}
          {meta?.total_cost_usd !== undefined && (
            <span className="text-[10px] text-nebula-accent/50">${meta.total_cost_usd.toFixed(4)}</span>
          )}
        </div>
        <div className={`rounded-xl px-4 py-3 ${bubbleStyle({ isInterAgent, alignRight, isError, hasAgent: !!respondingAgent })}`}>
          {/* Quote block for replied message */}
          {replyTo && (
            <button
              onClick={() => onScrollToMessage?.(replyTo.id)}
              className="w-full text-left mb-2 pl-2 border-l-2 border-nebula-accent/40 rounded-sm hover:bg-nebula-accent/5 transition-colors cursor-pointer"
            >
              <span className="text-[10px] font-medium text-nebula-accent/70">{replyAgentLabel}</span>
              <p className="text-[11px] text-nebula-muted line-clamp-2">{replyTo.content}</p>
            </button>
          )}
          {meta?.images && meta.images.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {meta.images.map((img: { id: string; filename: string }) => (
                <a key={img.id} href={`/api/agents/${message.agent_id}/uploads/${img.filename}`} target="_blank" rel="noopener">
                  <img
                    src={`/api/agents/${message.agent_id}/uploads/${img.filename}`}
                    alt=""
                    className="max-w-[240px] max-h-[200px] rounded-lg border border-nebula-border object-contain cursor-pointer hover:brightness-110 transition"
                    loading="lazy"
                  />
                </a>
              ))}
            </div>
          )}
          <div className={`text-[13px] ${!isUser ? 'font-mono' : ''}`}>
            <MarkdownRenderer content={message.content} highlight={highlight} />
          </div>
          {meta?.tool_history && meta.tool_history.length > 0 && (
            <ToolHistory tools={meta.tool_history} />
          )}
        </div>
      </div>
    </div>
  );
}
