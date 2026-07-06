import type { Tool } from "../types.js";

/**
 * Control tools are intercepted by the Agent loop and handled via UI callbacks
 * rather than executed directly. Their run() is a safety fallback only.
 */

export const CONTROL_TOOL_NAMES = ["ask_user", "present_plan"] as const;

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
