/**
 * Capability catalog — every user-facing action the Hand layer exposes.
 *
 * Each capability has an L6 ActionClass (coarse permission bucket). Providers
 * are registered under capabilities via registerProvider().
 */
import type { CapabilityDef } from "../types.js";

export const emailSend: CapabilityDef = {
  name: "email.send",
  description: "Send an email. Dispatches to Gmail REST (cloud) or Apple Mail via Shortcuts (macOS).",
  actionClass: "send_external",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient email" },
      subject: { type: "string" },
      body: { type: "string" },
      cc: { type: "string" },
      bcc: { type: "string" },
    },
    required: ["to", "subject", "body"],
  },
};

export const calendarCreateEvent: CapabilityDef = {
  name: "calendar.create_event",
  description: "Create a calendar event. Dispatches to Google Calendar REST or Apple Calendar via Shortcuts.",
  actionClass: "modify_calendar",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      date: { type: "string", description: "YYYY-MM-DD" },
      time: { type: "string", description: "HH:MM 24h (default 09:00)" },
      durationMinutes: { type: "number", description: "default 60" },
      description: { type: "string" },
      location: { type: "string" },
      attendees: { type: "array", items: { type: "string" } },
    },
    required: ["title", "date"],
  },
};

export const browserNavigate: CapabilityDef = {
  name: "browser.navigate",
  description: "Navigate to a URL and extract text (stateless, CLI-optimized).",
  actionClass: "browser_action",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string" },
      selector: { type: "string", description: "Optional CSS selector to extract" },
      screenshot: { type: "boolean", description: "Include base64 screenshot" },
      maxChars: { type: "number", description: "Max chars of text to return" },
    },
    required: ["url"],
  },
};

export const browserSession: CapabilityDef = {
  name: "browser.session",
  description: "Multi-step browser interaction with persistent session (login, click, fill, extract). Uses MCP for stateful transport.",
  actionClass: "browser_action",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["navigate", "click", "fill", "extract", "screenshot"] },
      url: { type: "string" },
      selector: { type: "string" },
      text: { type: "string" },
      toolName: { type: "string", description: "Override: name of MCP tool to call" },
      arguments: { type: "object", description: "Override: raw arguments to pass to MCP tool" },
    },
    required: ["action"],
  },
};

export const devDelegate: CapabilityDef = {
  name: "dev.delegate",
  description: "Delegate a coding task to Claude Code. Use when Anchor needs real code editing, refactoring, or debugging.",
  actionClass: "delegate_agent",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "Describe the task in plain English" },
      workingDir: { type: "string", description: "Project directory (default: cwd)" },
      effort: { type: "string", enum: ["low", "medium", "high"] },
      maxBudgetUsd: { type: "number" },
      allowedTools: { type: "array", items: { type: "string" } },
      toolName: { type: "string", description: "MCP-only: override tool name" },
    },
    required: ["task"],
  },
};

export const desktopAutomate: CapabilityDef = {
  name: "desktop.automate",
  description: "Automate any desktop app via vision: screenshot → VLM decides action → OS executes click/type. Tier 3 fallback when no API or script exists.",
  actionClass: "browser_action",   // reusing — Desktop automation is a privileged action; extend L6 later
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "Natural language instruction (e.g. 'Open Slack and click the first DM from Foo')" },
      app: { type: "string", description: "Optional: app name to activate first (e.g. 'Slack', 'Mail')" },
      confirmBeforeClick: { type: "boolean", description: "If true, pause for user approval before clicking" },
    },
    required: ["task"],
  },
};

export const ALL_CAPABILITIES: CapabilityDef[] = [
  emailSend,
  calendarCreateEvent,
  browserNavigate,
  browserSession,
  devDelegate,
  desktopAutomate,
];
