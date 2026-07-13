import type { Tool } from "../types.js";

/**
 * Control tools are intercepted by the Agent loop and handled via UI callbacks
 * rather than executed directly. Their run() is a safety fallback only.
 */

export const CONTROL_TOOL_NAMES = [
  "ask_user",
  "present_plan",
  "restart_self",
  "update_scratchpad",
] as const;

export const askUserTool: Tool = {
  name: "ask_user",
  description:
    "Ask the user a clarifying question when the request is ambiguous or you need a decision only they can make. Provide options when the answer is a choice. Prefer this over guessing.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to ask the user." },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of suggested answers to choose from.",
      },
    },
    required: ["question"],
  },
  async run() {
    return {
      content: "ask_user was not intercepted by the UI layer.",
      isError: true,
    };
  },
};

export const restartSelfTool: Tool = {
  name: "restart_self",
  description:
    "Only available when running under the scissor supervisor. Call this after you have modified scissor's OWN source code and want the changes to take effect. The supervisor will verify the new build (type-check + build); if it passes, scissor restarts into the new version and this same conversation continues. If it fails, your changes are rolled back automatically. Do not call this for changes to an unrelated user project.",
  parameters: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Short description of what you changed and why you are restarting.",
      },
    },
    required: ["reason"],
  },
  async run() {
    return {
      content:
        "restart_self is only available under the scissor supervisor (run `scissor supervise`).",
      isError: true,
    };
  },
};

export const updateScratchpadTool: Tool = {
  name: "update_scratchpad",
  description:
    "Update your working-memory scratchpad: the current goal, next step, last error, and files in play. The scratchpad is pinned into the system prompt, so it survives context compaction and restarts even when older messages are dropped. Keep it current during multi-step tasks so you never lose track of what you were doing. Only the fields you pass are changed; pass an empty string to clear a field.",
  parameters: {
    type: "object",
    properties: {
      goal: { type: "string", description: "The task you are working toward (replaces the current goal)." },
      next_step: { type: "string", description: "The next concrete step (replaces the current one)." },
      last_error: {
        type: "string",
        description: "The most recent unresolved error (replaces; pass empty string once resolved).",
      },
      files: {
        type: "array",
        items: { type: "string" },
        description: "Workspace-relative files currently in play (replaces the list).",
      },
      note: { type: "string", description: "Append a single freeform working note." },
      clear_notes: { type: "boolean", description: "Clear all working notes." },
    },
  },
  async run() {
    return {
      content: "update_scratchpad was not intercepted by the agent loop.",
      isError: true,
    };
  },
};

export const presentPlanTool: Tool = {
  name: "present_plan",
  description:
    "Before doing multi-step work that changes files or runs commands, present a concise numbered plan and wait for the user to approve it. If the user requests changes, revise and present again. Skip for trivial single-step requests.",
  parameters: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "One or two sentence summary of the goal.",
      },
      steps: {
        type: "array",
        items: { type: "string" },
        description: "Ordered list of concrete, actionable steps.",
      },
    },
    required: ["steps"],
  },
  async run() {
    return {
      content: "present_plan was not intercepted by the UI layer.",
      isError: true,
    };
  },
};
