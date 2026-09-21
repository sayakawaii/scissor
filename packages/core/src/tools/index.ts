import type { Tool } from "../types.js";
import {
  askUserTool,
  presentPlanTool,
  restartSelfTool,
  spawnSubagentTool,
  spawnSubagentsTool,
  todoWriteTool,
  updateScratchpadTool,
} from "./control.js";
import { diagnosticsTool } from "./diagnostics.js";
import { readFileTool } from "./read-file.js";
import { rememberTool } from "./remember.js";
import { retrieveTool } from "./retrieve.js";
import { globTool, grepTool } from "./search.js";
import { awaitShellTool, runShellTool } from "./shell.js";
import { webSearchTool } from "./web-search.js";
import { editFileTool, writeFileTool } from "./write-file.js";

export { diagnosticsTool } from "./diagnostics.js";
export { readFileTool } from "./read-file.js";
export { rememberTool, appendUnderLearned } from "./remember.js";
export { retrieveTool } from "./retrieve.js";
export { globTool, grepTool } from "./search.js";
export {
  runShellTool,
  awaitShellTool,
  isDangerous,
  readPermissions,
  DEFAULT_BLOCK_UNTIL_MS,
  SHELL_PERMISSIONS,
} from "./shell.js";
export type { ShellPermission } from "./shell.js";
export { webSearchTool, formatTavilyResponse, TAVILY_SEARCH_ENDPOINT } from "./web-search.js";
export type { TavilySearchResponse, TavilySearchResult } from "./web-search.js";
export { editFileTool, writeFileTool } from "./write-file.js";
export {
  askUserTool,
  presentPlanTool,
  restartSelfTool,
  updateScratchpadTool,
  todoWriteTool,
  spawnSubagentTool,
  spawnSubagentsTool,
  CONTROL_TOOL_NAMES,
} from "./control.js";
export { resolveInWorkspace, displayPath, isProtected, checkMutation } from "./paths.js";
export {
  coerceArray,
  coerceBoolean,
  coerceEnum,
  coerceNumber,
  coerceStringArray,
} from "./coerce.js";
export type { CoerceArrayOptions } from "./coerce.js";
export {
  suggestedToolTimeoutMs,
  toolTimeoutMessage,
  formatTimeout,
  TIMEOUT_TIERS,
  TIMEOUT_GRACE_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  SUBAGENT_TOOL_TIMEOUT_MS,
} from "./timeouts.js";

export interface ToolSetOptions {
  /** Include the restart_self tool (only when running under the supervisor). */
  selfEdit?: boolean;
}

/** The default tool set exposed to the agent (coding capabilities). */
export function defaultTools(opts: ToolSetOptions = {}): Tool[] {
  const tools: Tool[] = [
    readFileTool,
    retrieveTool,
    globTool,
    grepTool,
    webSearchTool,
    writeFileTool,
    editFileTool,
    runShellTool,
    awaitShellTool,
    diagnosticsTool,
    rememberTool,
    updateScratchpadTool,
    todoWriteTool,
    spawnSubagentTool,
    spawnSubagentsTool,
    askUserTool,
    presentPlanTool,
  ];
  if (opts.selfEdit) tools.push(restartSelfTool);
  return tools;
}

/** Chat-only tool set: no file mutation or command execution. */
export function chatTools(): Tool[] {
  return [readFileTool, retrieveTool, globTool, grepTool, webSearchTool, askUserTool];
}
