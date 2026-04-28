const BASE = "";

/**
 * 401 fan-out: any API call that comes back unauthenticated dispatches this
 * event. The auth provider listens, clears its cached user, and the router
 * re-renders into the Login page. Centralizing it here means callers don't
 * have to special-case session-expired anywhere.
 */
export const UNAUTHENTICATED_EVENT = "anchor:unauthenticated";

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
    throw new Error("Unauthenticated");
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.json();
}

/**
 * Streaming fetch — sends POST, reads SSE chunks, calls onChunk for each.
 * Returns the full accumulated text when done.
 */
async function streamReq(
  path: string,
  body: unknown,
  onChunk: (text: string) => void
): Promise<{ fullText: string; id?: string }> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
    throw new Error("Unauthenticated");
  }
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let doneId: string | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    // Parse SSE lines
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === "chunk") {
          fullText += data.text;
          onChunk(data.text);
        } else if (data.type === "done") {
          doneId = data.id;
        } else if (data.type === "error") {
          throw new Error(data.error);
        }
      } catch (e: any) {
        if (e.message && !e.message.includes("Unexpected")) throw e;
      }
    }
  }
  return { fullText, id: doneId };
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
  getNodeDetail: (id: string) => req<any>("GET", `/api/graph/nodes/${id}`),
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

  // Decaying relationships
  getDecayingRelationships: () => req<any[]>("GET", "/api/graph/decaying-relationships"),

  // Twin model
  getTwinModel: () => req<any>("GET", "/api/twin/model"),

  // Evolution state
  getEvolutionState: () => req<any[]>("GET", "/api/user/evolution"),

  // Agents
  getAgentStatus: () => req<any[]>("GET", "/api/agents/status"),
  getExecutions: () => req<any[]>("GET", "/api/agents/executions"),
  getRecommendations: () => req<any[]>("GET", "/api/agents/recommendations"),
  getActiveInsight: () => req<any>("GET", "/api/agents/active-insight"),
  acceptRecommendation: (action: any) => req<any>("POST", "/api/agents/recommendations/accept", { action }),

  // Advisor
  getChatHistory: (mode: string) => req<any[]>("GET", `/api/advisor/history/${mode}`),
  sendPersonal: (message: string) => req<any>("POST", "/api/advisor/personal", { message }),
  sendPersonalStream: (message: string, onChunk: (text: string) => void) =>
    streamReq("/api/advisor/personal/stream", { message }, onChunk),
  sendGeneral: (message: string) => req<any>("POST", "/api/advisor/general", { message }),
  sendAgent: (message: string) => req<any>("POST", "/api/advisor/agent", { message }),
  confirmPlan: (original_steps: any[], user_steps: any[]) => req<any>("POST", "/api/advisor/confirm", { original_steps, user_steps }),
  rejectPlan: (messageId: string, steps: any[]) => req("POST", "/api/advisor/reject", { messageId, steps }),
  scanOnboarding: () => req<any>("POST", "/api/advisor/onboarding/scan", {}),
  getFirstInsight: () => req<any>("POST", "/api/advisor/first-insight", {}),
  sendUniversal: (message: string, context?: string) => req<any>("POST", "/api/advisor/universal", { message, context }),
  getDigest: () => req<any>("GET", "/api/advisor/digest"),

  // Cortex
  getCortexStatus: () => req<any>("GET", "/api/user/models"),

  // Admin
  setProviderKey: (id: string, key: string) => req("PUT", `/api/admin/providers/${id}/key`, { key }),
  deleteProviderKey: (id: string) => req("DELETE", `/api/admin/providers/${id}/key`),
  testProvider: (id: string) => req<any>("POST", `/api/admin/providers/${id}/test`, {}),
  getCapabilityRoster: (cap: string) => req<any>("GET", `/api/admin/capability/${cap}`),
  getCosts: (days = 7) => req<any>("GET", `/api/admin/costs?days=${days}`),
  getPerformance: (days = 7) => req<any[]>("GET", `/api/admin/performance?days=${days}`),
  getCalls: (limit = 100) => req<any[]>("GET", `/api/admin/calls?limit=${limit}`),
  getCallDetail: (id: string) => req<any>("GET", `/api/admin/calls/${id}`),
  getDiagnosticReport: () => req<any>("GET", "/api/admin/diagnostic"),
  runDiagnostic: () => req<any>("POST", "/api/admin/diagnostic/run"),
  getSystemHealth: () => req<any>("GET", "/api/admin/health"),
  getRecentRuns: (limit = 30) => req<any[]>("GET", `/api/admin/runs?limit=${limit}`),
  getRunTrace: (runId: string) => req<any>("GET", `/api/admin/runs/${runId}/trace`),
  getOverrides: () => req<Record<string, string>>("GET", "/api/admin/overrides"),
  setOverride: (task: string, modelId: string) => req("PUT", `/api/admin/overrides/${task}`, { modelId }),
  clearOverride: (task: string) => req("DELETE", `/api/admin/overrides/${task}`),

  // Custom Agents
  getCustomAgents: () => req<any[]>("GET", "/api/agents/custom"),
  getAgentTemplates: () => req<any[]>("GET", "/api/agents/custom/templates"),
  createCustomAgent: (data: any) => req<any>("POST", "/api/agents/custom", data),
  updateCustomAgent: (id: string, data: any) => req("PUT", `/api/agents/custom/${id}`, data),
  deleteCustomAgent: (id: string) => req("DELETE", `/api/agents/custom/${id}`),
  installAgentTemplate: (templateIndex: number) => req<any>("POST", "/api/agents/custom/install-template", { templateIndex }),
  runCustomAgent: (id: string, message: string) => req<any>("POST", `/api/agents/custom/${id}/run`, { message }),
  feedbackCustomAgent: (id: string, rating: "good" | "bad", context?: string) => req("POST", `/api/agents/custom/${id}/feedback`, { rating, context }),
  generateAgentFromDescription: (description: string) => req<any>("POST", "/api/agents/custom/from-description", { description }),
  exportCustomAgent: (id: string) => req<any>("GET", `/api/agents/custom/${id}/export`),
  importCustomAgent: (data: any) => req<any>("POST", "/api/agents/custom/import", data),

  // P8 Agent Inspector
  getAgentWorkspaceFiles: (id: string) => req<{ path: string; exists: boolean; files: { name: string; isDir: boolean; size: number; mtime: string }[] }>("GET", `/api/agents/custom/${id}/workspace/files`),
  getAgentWorkspaceFile: (id: string, filePath: string) =>
    req<{ path: string; size: number; mtime: string; content: string }>("GET", `/api/agents/custom/${id}/workspace/file?path=${encodeURIComponent(filePath)}`),
  openAgentWorkspace: (id: string) => req<{ ok: boolean; path: string }>("POST", `/api/agents/custom/${id}/workspace/open`, {}),
  getAgentSkills: (id: string) => req<{ name: string; description: string; lang: string; template: string; successCount: number }[]>("GET", `/api/agents/custom/${id}/skills`),
  getAgentRuns: (id: string, limit = 20) => req<any[]>("GET", `/api/agents/custom/${id}/runs?limit=${limit}`),

  // P9 Jobs Dashboard
  getJobs: (params: { state?: string; source?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.state) q.set("state", params.state);
    if (params.source) q.set("source", params.source);
    if (params.limit) q.set("limit", String(params.limit));
    return req<any[]>("GET", `/api/jobs?${q.toString()}`);
  },
  getJob: (id: string) => req<any>("GET", `/api/jobs/${id}`),
  cancelJob: (id: string) => req<{ ok: boolean }>("POST", `/api/jobs/${id}/cancel`, {}),
  retryJob: (id: string) => req<{ ok: boolean }>("POST", `/api/jobs/${id}/retry`, {}),
  enqueueJob: (data: any) => req<{ id: string }>("POST", "/api/jobs", data),

  // P10 Hooks Editor
  getHooks: () => req<any[]>("GET", "/api/hooks"),
  createHook: (data: any) => req<{ id: string }>("POST", "/api/hooks", data),
  updateHook: (id: string, data: any) => req<{ ok: boolean }>("PUT", `/api/hooks/${id}`, data),
  deleteHook: (id: string) => req("DELETE", `/api/hooks/${id}`),

  // P11 Mission Viewer
  getMissions: (limit = 30) => req<any[]>("GET", `/api/missions?limit=${limit}`),
  getMission: (id: string) => req<any>("GET", `/api/missions/${id}`),

  // Portrait ceremony (A)
  startPortrait: () => req<{ started: boolean }>("POST", "/api/onboarding/portrait", {}),
  getLatestPortrait: () => req<any>("GET", "/api/onboarding/portrait/latest"),
  savePortraitAnswer: (data: { source: string; question: string; answer: string; note?: string }) =>
    req<{ ok: boolean }>("POST", "/api/onboarding/portrait/answer", data),
  getPortraitAnswers: () => req<any[]>("GET", "/api/onboarding/portrait/answers"),

  // P12 agentskills.io
  exportAgentSkill: (agentId: string, skillName: string) =>
    req<{ content: string; filename: string }>("GET", `/api/agents/custom/${agentId}/skills/${encodeURIComponent(skillName)}/export`),
  importAgentSkill: (agentId: string, skillMdContent: string) =>
    req<{ id: string; name: string }>("POST", `/api/agents/custom/${agentId}/skills/import`, { content: skillMdContent }),

  // Dev proposals (agent-proposed file writes awaiting human approval)
  getProposals: () => req<any[]>("GET", "/api/agents/proposals"),
  getProposalDetail: (id: string) => req<any>("GET", `/api/agents/proposals/${id}`),
  approveProposal: (id: string) => req<any>("POST", `/api/agents/proposals/${id}/approve`, {}),
  rejectProposal: (id: string) => req("POST", `/api/agents/proposals/${id}/reject`, {}),

  // L8-Hand Bridge: capabilities + providers + preferences
  getBridgeCapabilities: () => req<any[]>("GET", "/api/bridges/capabilities"),
  getBridgeProviders: () => req<any[]>("GET", "/api/bridges/providers"),
  getBridgePreferences: () => req<Record<string, { order: string[]; disabled: string[] }>>("GET", "/api/bridges/preferences"),
  setBridgePreference: (capability: string, order: string[], disabled: string[] = []) =>
    req("POST", "/api/bridges/preferences", { capability, order, disabled }),
  getBridgeAttempts: (runId?: string) =>
    req<any[]>("GET", runId ? `/api/bridges/attempts?runId=${runId}` : "/api/bridges/attempts"),
  getPipelines: () => req<any[]>("GET", "/api/agents/pipelines"),
  createPipeline: (data: any) => req<any>("POST", "/api/agents/pipelines", data),
  runPipeline: (id: string, input: string) => req<any>("POST", `/api/agents/pipelines/${id}/run`, { input }),
  getPipelineRuns: (id: string) => req<any[]>("GET", `/api/agents/pipelines/${id}/runs`),
  deletePipeline: (id: string) => req("DELETE", `/api/agents/pipelines/${id}`),
  generateCronFromDescription: (description: string) => req<any>("POST", "/api/crons/from-description", { description }),

  // Crons
  getCrons: () => req<any[]>("GET", "/api/crons"),
  createCron: (data: any) => req<any>("POST", "/api/crons", data),
  deleteCron: (id: string) => req("DELETE", `/api/crons/${id}`),
  toggleCron: (id: string) => req("POST", `/api/crons/${id}/toggle`, {}),

  // Skills
  getSkills: () => req<any[]>("GET", "/api/skills"),
  getSkillTemplates: () => req<any[]>("GET", "/api/skills/templates"),
  installSkillTemplate: (index: number) => req<any>("POST", "/api/skills/install-template", { templateIndex: index }),

  // Integrations — Google OAuth
  getIntegrationStatus: () => req<any>("GET", "/api/integrations/status"),
  getGoogleConnectUrl: () => req<any>("GET", "/api/integrations/google/connect"),
  disconnectGoogle: () => req("DELETE", "/api/integrations/google", {}),
  triggerGoogleScan: () => req<any>("POST", "/api/integrations/google/scan", {}),

  // Integrations — Local scan (no OAuth needed)
  getActivitySummary: (hours?: number) => req<any>("GET", `/api/integrations/activity/summary${hours ? `?hours=${hours}` : ""}`),
  getLocalScanStatus: () => req<any>("GET", "/api/integrations/local/status"),
  triggerLocalScan: () => req<any>("POST", "/api/integrations/local/scan", {}),
  triggerBrowserScan: () => req<any>("POST", "/api/integrations/local/scan/browser", {}),
  triggerContactsScan: () => req<any>("POST", "/api/integrations/local/scan/contacts", {}),
  triggerCalendarScan: () => req<any>("POST", "/api/integrations/local/scan/calendar", {}),

  // Sprint B — #4 — Unified Approval Inbox
  listApprovals: (status: string = "pending", source?: string) =>
    req<any[]>("GET", `/api/approvals?status=${status}${source ? `&source=${source}` : ""}`),
  approvalStats: () => req<{ pending: number; pendingByRisk: Record<string, number>; pendingBySource: Record<string, number> }>("GET", "/api/approvals/stats"),
  decideApproval: (id: string, approve: boolean, reason?: string) =>
    req<any>("POST", `/api/approvals/${id}/decide`, { approve, reason }),

  // Phase 1-4 of #2 — Action sessions
  listSessions: (status?: string, limit?: number) =>
    req<any[]>("GET", `/api/sessions${status || limit ? "?" : ""}${status ? `status=${status}` : ""}${status && limit ? "&" : ""}${limit ? `limit=${limit}` : ""}`),
  getSession: (id: string) => req<any>("GET", `/api/sessions/${id}`),
  pauseSession: (id: string) => req<any>("PATCH", `/api/sessions/${id}/pause`, {}),
  resumeSession: (id: string) => req<any>("PATCH", `/api/sessions/${id}/resume`, {}),
  cancelSession: (id: string) => req<any>("PATCH", `/api/sessions/${id}/cancel`, {}),
  takeoverSession: (id: string) => req<any>("POST", `/api/sessions/${id}/takeover`, {}),
  editStep: (sessionId: string, stepId: string, body: any) =>
    req<any>("PATCH", `/api/sessions/${sessionId}/steps/${stepId}`, body),
  insertStep: (sessionId: string, body: any) =>
    req<any>("POST", `/api/sessions/${sessionId}/steps`, body),
  skipStep: (sessionId: string, stepId: string) =>
    req<any>("DELETE", `/api/sessions/${sessionId}/steps/${stepId}`),

  // ── 5 vertical Human Graphs (Relationship / Time / Work / Energy / Finance) ──
  listGraphs: () => req<{ available: Array<{ id: string; name: string; path: string; status: string }> }>("GET", "/api/graphs"),
  getGraphRelationship: () => req<any>("GET", "/api/graphs/relationship"),
  getGraphTime:         () => req<any>("GET", "/api/graphs/time"),
  getGraphWork:         () => req<any>("GET", "/api/graphs/work"),
  getGraphEnergy:       () => req<any>("GET", "/api/graphs/energy"),
  getGraphFinance:      () => req<any>("GET", "/api/graphs/finance"),
  addFinanceTx: (data: { amountCents: number; category: string; merchant?: string; notes?: string; occurredAt?: string }) =>
    req<any>("POST", "/api/graphs/finance/transactions", data),
  deleteFinanceTx: (id: string) => req("DELETE", `/api/graphs/finance/transactions/${id}`),
};
