'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { API_BASE } from '../../../lib/api';

type LiveState = 'connecting' | 'live' | 'reconnecting' | 'offline';

function toWsBaseUrl(apiBase: string) {
  const trimmed = apiBase.trim();
  if (trimmed.startsWith('https://')) return `wss://${trimmed.slice('https://'.length)}`;
  if (trimmed.startsWith('http://')) return `ws://${trimmed.slice('http://'.length)}`;
  return trimmed;
}

export default function LiveRefresher({ workOrderId }: { workOrderId: string }) {
  const router = useRouter();
  const [state, setState] = useState<LiveState>('connecting');
  const refreshScheduled = useRef(false);
  const reconnectAttempt = useRef(0);
  const closing = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const didInitialConnect = useRef(false);

  useEffect(() => {
    closing.current = false;
    reconnectAttempt.current = 0;
    didInitialConnect.current = false;

    const wsBase = toWsBaseUrl(API_BASE);
    const wsUrl = `${wsBase}/work-orders/${workOrderId}/ws`;

    function scheduleRefresh() {
      if (refreshScheduled.current) return;
      refreshScheduled.current = true;
      window.setTimeout(() => {
        refreshScheduled.current = false;
        router.refresh();
      }, 250);
    }

    function connect() {
      if (closing.current) return;
      setState((prev) => (prev === 'connecting' ? 'connecting' : 'reconnecting'));

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttempt.current = 0;
        setState('live');
        // Avoid a refresh loop if the page is re-rendered from `router.refresh()`.
        // Only refresh on reconnects.
        if (didInitialConnect.current) scheduleRefresh();
        didInitialConnect.current = true;
      };
      ws.onmessage = () => scheduleRefresh();
      ws.onerror = () => {
        // Most errors are followed by an onclose; avoid double-handling.
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (closing.current) {
          setState('offline');
          return;
        }

        setState('reconnecting');
        const attempt = reconnectAttempt.current++;
        const delayMs = Math.min(5000, 250 * 2 ** attempt);
        window.setTimeout(connect, delayMs);
      };
    }

    connect();

    return () => {
      closing.current = true;
      wsRef.current?.close();
      wsRef.current = null;
      setState('offline');
    };
  }, [router, workOrderId]);

  return (
    <span className="badge" title="Auto-refreshes on API websocket events">
      Live: {state}
    </span>
  );
}
