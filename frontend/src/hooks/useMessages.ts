import { useState, useCallback, useRef } from 'react';
import { getMessages, Message } from '../api/client';

export function useMessages(agentId: string | null, conversationId: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const loadMoreInFlight = useRef(false);

  const loadMessages = useCallback(async (id: string, convId?: string) => {
    setLoading(true);
    try {
      const data = await getMessages(id, 50, undefined, convId);
      setMessages(data);
      setHasMore(data.length >= 50);
    } catch (err) {
      console.error('Failed to load messages:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!agentId || messages.length === 0 || !hasMore || loadMoreInFlight.current) return;
    loadMoreInFlight.current = true;
    try {
      const firstId = messages[0].id;
      const data = await getMessages(agentId, 50, firstId, conversationId || undefined);
      if (data.length === 0) {
        setHasMore(false);
        return;
      }
      setMessages(prev => {
        const existingIds = new Set(prev.map(m => m.id));
        const deduped = data.filter(m => !existingIds.has(m.id));
        return [...deduped, ...prev];
      });
      setHasMore(data.length >= 50);
    } catch (err) {
      console.error('Failed to load more messages:', err);
    } finally {
      loadMoreInFlight.current = false;
    }
  }, [agentId, conversationId, messages, hasMore]);

  const addMessage = useCallback((msg: Message) => {
    setMessages(prev => {
      // Avoid duplicates
      if (prev.some(m => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
  }, []);

  const clear = useCallback(() => {
    setMessages([]);
    setHasMore(true);
  }, []);

  return { messages, loading, hasMore, loadMessages, loadMore, addMessage, clear };
}
