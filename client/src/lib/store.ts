/**
 * Global state store — zustand.
 * Shared across pages to avoid duplicate API calls.
 */
import { create } from "zustand";
import { api } from "./api";

interface AgentInfo {
  name: string;
  successes: number;
  failures: number;
}

interface AnchorStore {
  // Agent status (shared across 6+ pages)
  agentStatus: AgentInfo[];
  agentStatusLoaded: boolean;
  fetchAgentStatus: () => Promise<void>;

  // User state (shared across Dashboard + Settings)
  userState: { energy: number; focus: number; stress: number } | null;
  fetchUserState: () => Promise<void>;

  // WebSocket events
  wsEvents: { type: string; payload: any; timestamp: number }[];
  addWsEvent: (type: string, payload: any) => void;
}

export const useAnchorStore = create<AnchorStore>((set, get) => ({
  // Agent status
  agentStatus: [],
  agentStatusLoaded: false,
  fetchAgentStatus: async () => {
    // Stale-while-revalidate: skip if loaded in last 5 min
    if (get().agentStatusLoaded) return;
    try {
      const status = await api.getAgentStatus();
      set({ agentStatus: status, agentStatusLoaded: true });
      // Expire after 5 minutes
      setTimeout(() => set({ agentStatusLoaded: false }), 5 * 60 * 1000);
    } catch {}
  },

  // User state
  userState: null,
  fetchUserState: async () => {
    if (get().userState) return;
    try {
      const state = await api.getState();
      set({ userState: state });
    } catch {}
  },

  // WebSocket events — keep last 50
  wsEvents: [],
  addWsEvent: (type, payload) => {
    set(s => ({
      wsEvents: [...s.wsEvents.slice(-49), { type, payload, timestamp: Date.now() }],
    }));
    // Refresh agent status on relevant events
    if (["EXECUTION_DONE", "TWIN_UPDATED", "TASK_COMPLETED"].includes(type)) {
      set({ agentStatusLoaded: false });
    }
  },
}));
