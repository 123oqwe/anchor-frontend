/**
 * WebSocket hook — connects to server, dispatches events to zustand store.
 * Shows toast notifications for NOTIFICATION events with action buttons.
 */
import { useEffect, useRef } from "react";
import { useAnchorStore } from "../lib/store";
import { toast } from "sonner";

export function useWebSocket() {
  const addWsEvent = useAnchorStore(s => s.addWsEvent);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const port = window.location.port === "5173" || window.location.port === "5174" ? "3001" : window.location.port;
    const url = `${protocol}//${window.location.hostname}:${port}/ws`;

    function connect() {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          addWsEvent(data.type, data.payload);

          // Show toast for notifications and key events
          if (data.type === "NOTIFICATION") {
            const p = data.payload;
            if (p.action) {
              toast(p.title, {
                description: p.body,
                duration: 10000,
                action: { label: p.action.label, onClick: () => {
                  if (p.action.type === "navigate") window.location.href = p.action.payload.path;
                }},
              });
            } else {
              toast(p.title, { description: p.body, duration: 6000 });
            }
          } else if (data.type === "EXECUTION_DONE") {
            const steps = data.payload?.steps_result ?? [];
            const ok = steps.filter((s: any) => s.status === "done").length;
            toast.success(`Execution complete: ${ok}/${steps.length} steps done`);
          } else if (data.type === "TWIN_UPDATED") {
            toast("Twin learned something new", { description: data.payload?.insight?.slice(0, 80), duration: 4000 });
          } else if (data.type === "PROPOSAL_PENDING") {
            const p = data.payload;
            toast("File change proposed — review required", {
              description: `${p.agentName ?? "An agent"} wants to write ${p.path ?? "(unknown)"} (${p.deltaLines >= 0 ? "+" : ""}${p.deltaLines} lines)`,
              duration: 15000,
              action: { label: "Review", onClick: () => { window.location.href = "/agents"; } },
            });
          }
        } catch {}
      };

      ws.onclose = () => { setTimeout(connect, 3000); };
      ws.onerror = () => { ws.close(); };
    }

    connect();
    return () => { wsRef.current?.close(); };
  }, [addWsEvent]);
}
