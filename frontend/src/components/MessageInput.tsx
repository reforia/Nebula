import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Agent, Message } from '../api/client';

function agentColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const hue = 30 + (Math.abs(hash) % 40);
  return `hsl(${hue}, 55%, 58%)`;
}

interface Props {
  onSend: (content: string, images: File[]) => Promise<void> | void;
  onCancel?: () => void;
  disabled?: boolean;
  isTyping?: boolean;
  agents?: Agent[];
  currentAgentId?: string;
  draft?: string;
  onDraftChange?: (value: string) => void;
  /** Hide @notify command (e.g. in project conversations where all mentions must return) */
  hideNotify?: boolean;
  replyTo?: Message | null;
  onClearReply?: () => void;
}

export default function MessageInput({ onSend, onCancel, disabled, isTyping, agents, currentAgentId, draft, onDraftChange, hideNotify, replyTo, onClearReply }: Props) {
  const [localValue, setLocalValue] = useState('');
  const value = draft !== undefined ? draft : localValue;
  const setValue = (v: string) => { onDraftChange ? onDraftChange(v) : setLocalValue(v); };
  const [pendingImages, setPendingImages] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Mention autocomplete state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState(0); // cursor index of the @
  const [mentionMode, setMentionMode] = useState<'mention' | 'command' | 'notify'>('mention');
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Reset autocomplete when switching agents/conversations
  useEffect(() => { setMentionQuery(null); setSelectedIndex(0); }, [currentAgentId]);

  const peerAgents = useMemo(
    () => (agents || []).filter(a => a.id !== currentAgentId && a.enabled),
    [agents, currentAgentId]
  );

  // Commands that appear in the @ autocomplete
  const commands = useMemo(() => hideNotify ? [] : [
    { name: 'notify', description: 'Send a task to an agent (fire-and-forget)', emoji: '📢' },
  ], [hideNotify]);

  const filteredItems = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    if (mentionMode === 'notify') {
      // After @notify, show agents only
      return peerAgents.filter(a => a.name.toLowerCase().includes(q)).map(a => ({ type: 'agent' as const, agent: a }));
    }
    // Default: show matching commands + agents
    const matchedCommands = commands.filter(c => c.name.toLowerCase().includes(q)).map(c => ({ type: 'command' as const, command: c }));
    const matchedAgents = peerAgents.filter(a => a.name.toLowerCase().includes(q)).map(a => ({ type: 'agent' as const, agent: a }));
    return [...matchedCommands, ...matchedAgents];
  }, [mentionQuery, mentionMode, peerAgents, commands]);

  const showMenu = mentionQuery !== null && filteredItems.length > 0;

  // Reset selected index when filtered list changes
  useEffect(() => { setSelectedIndex(0); }, [filteredItems.length]);

  const insertMention = useCallback((text: string, keepAutocomplete?: boolean) => {
    const before = value.slice(0, mentionStart);
    const queryLen = mentionMode === 'notify'
      ? 'notify '.length + (mentionQuery?.length || 0)
      : (mentionQuery?.length || 0);
    const after = value.slice(mentionStart + 1 + queryLen);
    const newValue = `${before}@${text} ${after}`;
    setValue(newValue);

    if (!keepAutocomplete) {
      setMentionQuery(null);
      setMentionMode('mention');
    }

    // Restore focus and cursor position
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        const pos = before.length + text.length + 2; // @text + space
        el.setSelectionRange(pos, pos);
        // If keeping autocomplete (command selected), trigger change detection
        if (keepAutocomplete) {
          setMentionMode('notify');
          setMentionStart(before.length);
          setMentionQuery('');
        }
      }
    });
  }, [value, mentionStart, mentionQuery, mentionMode]);

  const handleSubmit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed && pendingImages.length === 0) return;
    if (disabled || sending) return;

    const savedValue = value;
    const savedImages = [...pendingImages];
    setValue('');
    setPendingImages([]);
    setMentionQuery(null);
    setSendError(null);
    setSending(true);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    try {
      await onSend(trimmed, savedImages);
    } catch (err: any) {
      // Restore input so user doesn't lose their message
      setValue(savedValue);
      setPendingImages(savedImages);
      setSendError(err.message || 'Failed to send message');
      textareaRef.current?.focus();
    } finally {
      setSending(false);
    }
  }, [value, disabled, sending, onSend, pendingImages]);

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageFiles = items
      .filter(item => item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter(Boolean) as File[];
    if (imageFiles.length > 0) {
      e.preventDefault();
      setPendingImages(prev => [...prev, ...imageFiles].slice(0, 5));
    }
  };

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    setPendingImages(prev => [...prev, ...files].slice(0, 5));
    e.target.value = '';
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle menu navigation when autocomplete is open
    if (showMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(i => (i + 1) % filteredItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(i => (i - 1 + filteredItems.length) % filteredItems.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        const item = filteredItems[selectedIndex];
        if (item.type === 'command') {
          insertMention(item.command.name, true);
        } else {
          const prefix = mentionMode === 'notify' ? `notify ${item.agent.name}` : item.agent.name;
          insertMention(prefix);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionQuery(null);
        setMentionMode('mention');
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setValue(newValue);
    if (sendError) setSendError(null);

    // Check for @ mention trigger
    const cursorPos = e.target.selectionStart || 0;
    const textBeforeCursor = newValue.slice(0, cursorPos);

    // Check for @notify <partial> pattern first (disabled in project conversations)
    const notifyMatch = !hideNotify && textBeforeCursor.match(/@notify\s+(.{0,30})$/i);
    if (notifyMatch && peerAgents.length > 0) {
      setMentionStart(cursorPos - notifyMatch[0].length);
      setMentionMode('notify');
      setMentionQuery(notifyMatch[1]);
    } else {
      // Find the last @ — allow spaces for multi-word agent names (e.g. "BM Pacman")
      // Match up to 30 chars after @ to keep it bounded
      const atMatch = textBeforeCursor.match(/@([^@]{0,30})$/);
      if (atMatch && peerAgents.length > 0) {
        // Only show autocomplete if the query could match an agent name
        const query = atMatch[1];
        const hasMatch = peerAgents.some(a => a.name.toLowerCase().startsWith(query.toLowerCase()));
        if (hasMatch || query.length === 0) {
          setMentionStart(cursorPos - atMatch[0].length);
          setMentionMode('mention');
          setMentionQuery(query);
        } else {
          setMentionQuery(null);
          setMentionMode('mention');
        }
      } else {
        setMentionQuery(null);
        setMentionMode('mention');
      }
    }
  };

  const syncHeight = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 160) + 'px';
    }
  }, []);

  // Reset height when value changes externally (e.g. agent switch clears draft)
  useEffect(() => { syncHeight(); }, [value, syncHeight]);

  return (
    <div className="relative flex flex-col border-t border-nebula-border bg-nebula-surface/80 backdrop-blur-sm">
      {/* Send error */}
      {sendError && (
        <div className="flex items-center gap-2 px-3 sm:px-4 pt-2">
          <p className="text-[12px] text-nebula-red flex-1">{sendError}</p>
          <button onClick={() => setSendError(null)} className="text-nebula-muted hover:text-nebula-text text-xs">&times;</button>
        </div>
      )}

      {/* Reply preview bar */}
      {replyTo && (
        <div className="flex items-center gap-2 px-3 sm:px-4 pt-2">
          <div className="flex-1 min-w-0 pl-2 border-l-2 border-nebula-accent/50">
            <span className="text-[10px] font-medium text-nebula-accent/70">
              {replyTo.role === 'user' ? 'You' : (() => {
                const a = agents?.find(x => x.id === replyTo.agent_id);
                return a ? `${a.emoji} ${a.name}` : 'Assistant';
              })()}
            </span>
            <p className="text-[11px] text-nebula-muted truncate">{replyTo.content?.slice(0, 100)}{(replyTo.content?.length || 0) > 100 ? '...' : ''}</p>
          </div>
          <button
            onClick={onClearReply}
            className="text-nebula-muted hover:text-nebula-text text-sm flex-shrink-0 px-1"
            title="Cancel reply"
          >
            &times;
          </button>
        </div>
      )}

      {/* Image preview strip */}
      {pendingImages.length > 0 && (
        <div className="flex gap-2 px-3 sm:px-4 pt-2 overflow-x-auto">
          {pendingImages.map((file, i) => (
            <div key={i} className="relative flex-shrink-0">
              <img
                src={URL.createObjectURL(file)}
                alt={file.name}
                className="h-16 w-16 object-cover rounded-lg border border-nebula-border"
              />
              <button
                onClick={() => setPendingImages(prev => prev.filter((_, j) => j !== i))}
                className="absolute -top-1 -right-1 w-4 h-4 bg-nebula-red text-white rounded-full text-[10px] flex items-center justify-center leading-none"
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Mention autocomplete menu */}
      {showMenu && (
        <div
          ref={menuRef}
          className="absolute bottom-full left-3 sm:left-4 mb-1 w-64 bg-nebula-surface-2 border border-nebula-border rounded-lg shadow-lg z-50 py-1 max-h-48 overflow-y-auto"
        >
          {filteredItems.map((item, i) => item.type === 'command' ? (
            <button
              key={item.command.name}
              onClick={() => insertMention(item.command.name, true)}
              className={`w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors ${
                i === selectedIndex ? 'bg-nebula-accent-glow' : 'hover:bg-nebula-hover'
              }`}
            >
              <span className="text-base">{item.command.emoji}</span>
              <div className="flex-1 min-w-0">
                <span className="text-[13px] font-medium text-nebula-accent">@{item.command.name}</span>
                <p className="text-[11px] text-nebula-muted truncate">{item.command.description}</p>
              </div>
            </button>
          ) : (
            <button
              key={item.agent.id}
              onClick={() => {
                const prefix = mentionMode === 'notify' ? `notify ${item.agent.name}` : item.agent.name;
                insertMention(prefix);
              }}
              className={`w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors ${
                i === selectedIndex ? 'bg-nebula-accent-glow' : 'hover:bg-nebula-hover'
              }`}
            >
              <span className="text-base">{item.agent.emoji}</span>
              <div className="flex-1 min-w-0">
                <span className="text-[13px] font-medium" style={{ color: agentColor(item.agent.name) }}>{item.agent.name}</span>
                {item.agent.role && <p className="text-[11px] text-nebula-muted truncate">{item.agent.role}</p>}
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2 p-3 sm:p-4">
      <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFilePick} />
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled}
        className="self-end p-2.5 text-nebula-muted hover:text-nebula-text disabled:opacity-20 transition-colors"
        title="Attach image"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
      </button>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={e => { handleChange(e); syncHeight(); }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder="Message..."
        disabled={disabled}
        rows={1}
        className="flex-1 resize-none bg-nebula-bg border border-nebula-border rounded-xl px-4 py-2.5 text-[13px] text-nebula-text placeholder:text-nebula-muted/50 focus:outline-none focus:border-nebula-accent/40 disabled:opacity-40 transition-colors"
      />
      {isTyping ? (
        <button
          onClick={onCancel}
          className="px-4 sm:px-5 py-2.5 bg-nebula-red text-white rounded-xl font-semibold text-[13px] hover:brightness-110 transition-all self-end"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="sm:hidden"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
          <span className="hidden sm:inline">Stop</span>
        </button>
      ) : (
        <button
          onClick={handleSubmit}
          disabled={disabled || sending || (!value.trim() && pendingImages.length === 0)}
          className="px-4 sm:px-5 py-2.5 bg-nebula-accent text-nebula-bg rounded-xl font-semibold text-[13px] hover:brightness-110 disabled:opacity-20 transition-all self-end shadow-glow"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="sm:hidden"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
          <span className="hidden sm:inline">Send</span>
        </button>
      )}
      </div>
    </div>
  );
}
