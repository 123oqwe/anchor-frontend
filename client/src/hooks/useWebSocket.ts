/**
 * WebSocket hook — connects to server, dispatches events to zustand store.
 */
import { useEffect, useRef } from "react";
import { useAnchorStore } from "../lib/store";

export function useWebSocket() {
  const addWsEvent = useAnchorStore(s => s.addWsEvent);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    // In dev, backend is on port 3001; in prod, same origin
    const port = window.location.port === "5173" || window.location.port === "5174" ? "3001" : window.location.port;
    const url = `${protocol}//${window.location.hostname}:${port}/ws`;

    function connect() {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          addWsEvent(data.type, data.payload);
        } catch {}
      };

      ws.onclose = () => {
        // Reconnect after 3s
        setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      wsRef.current?.close();
    };
  }, [addWsEvent]);
}
