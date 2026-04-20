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

export const ALL_CAPABILITIES: CapabilityDef[] = [
  emailSend,
  browserNavigate,
  browserSession,
  devDelegate,
];
