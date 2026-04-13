const BASE = "";

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.json();
}

export const api = {
  // User
  getProfile: () => req<any>("GET", "/api/user/profile"),
  updateProfile: (data: any) => req("PUT", "/api/user/profile", data),
  getState: () => req<any>("GET", "/api/user/state"),
  updateState: (data: any) => req("PUT", "/api/user/state", data),
  getSettings: () => req<any>("GET", "/api/user/settings"),
  updateSettings: (section: string, data: any) => req("PUT", `/api/user/settings/${section}`, data),

  // Graph
  getGraph: () => req<any>("GET", "/api/graph"),
  getDecisionToday: () => req<any>("GET", "/api/graph/decision-today"),
  createNode: (data: any) => req("POST", "/api/graph/nodes", data),
  updateNode: (id: string, data: any) => req("PUT", `/api/graph/nodes/${id}`, data),
  deleteNode: (id: string) => req("DELETE", `/api/graph/nodes/${id}`),

  // Memory
  getMemories: (params?: { type?: string; q?: string }) => {
    const qs = new URLSearchParams(params as any).toString();
    return req<any[]>("GET", `/api/memory${qs ? "?" + qs : ""}`);
  },
  getMemoryStats: () => req<any>("GET", "/api/memory/stats"),
  createMemory: (data: any) => req("POST", "/api/memory", data),
  updateMemory: (id: string, data: any) => req("PUT", `/api/memory/${id}`, data),
  deleteMemory: (id: string) => req("DELETE", `/api/memory/${id}`),

  // Workspace
  getProjects: () => req<any[]>("GET", "/api/workspace/projects"),
  getProject: (id: string) => req<any>("GET", `/api/workspace/projects/${id}`),
  createProject: (data: any) => req<any>("POST", "/api/workspace/projects", data),
  updateProject: (id: string, data: any) => req("PUT", `/api/workspace/projects/${id}`, data),
  deleteProject: (id: string) => req("DELETE", `/api/workspace/projects/${id}`),
  createTask: (projectId: string, data: any) => req<any>("POST", `/api/workspace/projects/${projectId}/tasks`, data),
  updateTask: (id: string, data: any) => req("PUT", `/api/workspace/tasks/${id}`, data),
  patchTaskStatus: (id: string, status: string) => req("PATCH", `/api/workspace/tasks/${id}/status`, { status }),
  deleteTask: (id: string) => req("DELETE", `/api/workspace/tasks/${id}`),
  mergeProjects: (data: any) => req<any>("POST", "/api/workspace/projects/merge", data),

  // Twin
  getTwinEvolution: () => req<any>("GET", "/api/twin/evolution"),
  getTwinInsights: () => req<any[]>("GET", "/api/twin/insights"),
  completeQuest: (id: string) => req("POST", `/api/twin/quests/${id}/complete`, {}),
  addXP: (amount: number) => req("POST", "/api/twin/xp", { amount }),

  // Agents
  getAgentStatus: () => req<any[]>("GET", "/api/agents/status"),
  getExecutions: () => req<any[]>("GET", "/api/agents/executions"),

  // Advisor
  getChatHistory: (mode: string) => req<any[]>("GET", `/api/advisor/history/${mode}`),
  sendPersonal: (message: string) => req<any>("POST", "/api/advisor/personal", { message }),
  sendGeneral: (message: string) => req<any>("POST", "/api/advisor/general", { message }),
  sendAgent: (message: string) => req<any>("POST", "/api/advisor/agent", { message }),
  approveDraft: (id: string) => req("POST", `/api/advisor/drafts/${id}/approve`, {}),
  rejectDraft: (id: string) => req("POST", `/api/advisor/drafts/${id}/reject`, {}),
  scanOnboarding: () => req<any>("POST", "/api/advisor/onboarding/scan", {}),
};
