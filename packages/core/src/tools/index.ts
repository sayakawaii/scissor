import type { Tool } from "../types.js";
import { askUserTool, presentPlanTool, restartSelfTool } from "./control.js";
import { readFileTool } from "./read-file.js";
import { rememberTool } from "./remember.js";
import { retrieveTool } from "./retrieve.js";
import { globTool, grepTool } from "./search.js";
import { runShellTool } from "./shell.js";
import { editFileTool, writeFileTool } from "./write-file.js";

export { readFileTool } from "./read-file.js";
export { rememberTool, appendUnderLearned } from "./remember.js";
export { retrieveTool } from "./retrieve.js";
export { globTool, grepTool } from "./search.js";
export { runShellTool } from "./shell.js";
export { editFileTool, writeFileTool } from "./write-file.js";
export {
  askUserTool,
  presentPlanTool,
  restartSelfTool,
  CONTROL_TOOL_NAMES,
} from "./control.js";
export { resolveInWorkspace, displayPath, isProtected } from "./paths.js";

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
    writeFileTool,
    editFileTool,
    runShellTool,
    rememberTool,
    askUserTool,
    presentPlanTool,
  ];
  if (opts.selfEdit) tools.push(restartSelfTool);
  return tools;
}

/** Chat-only tool set: no file mutation or command execution. */
export function chatTools(): Tool[] {
  return [readFileTool, retrieveTool, globTool, grepTool, askUserTool];
}
