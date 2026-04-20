import { useEffect, useRef, useCallback, useState } from 'react';

export interface WSMessage {
  type: 'new_message' | 'agent_typing' | 'unread_update' | 'agent_error' | 'task_fired' | 'remote_agent_status' | 'runtime_auth_error';
  agent_id?: string;
  conversation_id?: string;
  message?: any;
  active?: boolean;
  counts?: Record<string, number>;
  projectCounts?: Record<string, number>;
  error?: string;
  task_name?: string;
  conversation_owner?: string;
  project_id?: string;
}

type Listener = (msg: WSMessage) => void;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef<Set<Listener>>(new Set());
  const [connected, setConnected] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const isReconnect = useRef(false);
  // Set on unmount so any in-flight onclose callback skips scheduling a new
  // reconnect. Without this, closing the socket during cleanup fires onclose
  // which schedules a fresh setTimeout after the timer was already cleared.
  const cancelledRef = useRef(false);
  const reconnectAttempts = useRef(0);

  const connect = useCallback(async () => {
    if (cancelledRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    // Only refresh token on reconnect — first connect has a fresh token from login
    if (isReconnect.current) {
      try {
        await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          credentials: 'same-origin',
        });
      } catch { /* ignore — WS will fail and retry */ }
    }
    isReconnect.current = true;

    if (cancelledRef.current) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      reconnectAttempts.current = 0;
      setConnected(true);
      // Emit synthetic event so listeners can clear stale state BEFORE snapshot messages arrive
      for (const listener of listenersRef.current) {
        listener({ type: 'ws_connected' } as any);
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WSMessage;
        for (const listener of listenersRef.current) {
          listener(msg);
        }
      } catch { /* ignore */ }
    };

    ws.onclose = () => {
      setConnected(false);
      if (cancelledRef.current) return;
      // Exponential backoff with jitter — caps at 30s. Jitter prevents every
      // tab in a restarting browser from reconnecting in lockstep.
      const attempt = ++reconnectAttempts.current;
      const base = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
      const delay = Math.round(base * (0.5 + Math.random() * 0.5));
      reconnectTimer.current = setTimeout(connect, delay);
    };

    ws.onerror = () => ws.close();

    wsRef.current = ws;
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    connect();
    return () => {
      cancelledRef.current = true;
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  const subscribe = useCallback((listener: Listener) => {
    listenersRef.current.add(listener);
    return () => { listenersRef.current.delete(listener); };
  }, []);

  const send = useCallback((data: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  return { connected, subscribe, send };
}
