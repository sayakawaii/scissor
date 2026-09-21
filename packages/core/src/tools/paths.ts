import path from "node:path";
import { checkWrite } from "../sandbox/policy.js";
import type { ToolContext } from "../types.js";

/**
 * Resolve a user/model-supplied path against the workspace root and ensure it
 * stays inside it. Throws on traversal outside the workspace.
 */
export function resolveInWorkspace(workspaceRoot: string, target: string): string {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, target);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Path "${target}" is outside the workspace (${root}). Refusing for safety.`,
    );
  }
  return resolved;
}

/** Human-friendly relative display path. */
export function displayPath(workspaceRoot: string, absolute: string): string {
  const rel = path.relative(path.resolve(workspaceRoot), absolute);
  return rel === "" ? "." : rel.split(path.sep).join("/");
}

/**
 * Minimal glob matcher supporting `*`, `**`, and `?`. Enough for protected-path
 * checks like "packages/cli/src/self/**".
 */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c as string)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** True when the workspace-relative path matches any protected glob. */
export function isProtected(
  workspaceRoot: string,
  absolute: string,
  protectedPaths: string[] | undefined,
): boolean {
  if (!protectedPaths || protectedPaths.length === 0) return false;
  const rel = displayPath(workspaceRoot, absolute);
  return protectedPaths.some((p) => globToRegExp(p).test(rel));
}

/**
 * The single gate every file-mutating tool goes through. Returns an error
 * message to hand back to the model, or undefined when the write is permitted.
 *
 * Two independent checks live here so no tool can accidentally implement only
 * one: the opt-in `protectedPaths` globs (self-edit mode guarding scissor's own
 * safety machinery) and the always-on sandbox write-protection denylist.
 */
export function checkMutation(
  ctx: ToolContext,
  absolute: string,
  target: string,
): string | undefined {
  if (isProtected(ctx.workspaceRoot, absolute, ctx.protectedPaths)) {
    return `Error: "${target}" is a protected path and cannot be modified.`;
  }
  if (ctx.sandbox) {
    const verdict = checkWrite(ctx.sandbox, absolute);
    if (!verdict.allowed) {
      return `Error: refusing to write "${target}" — ${verdict.reason}`;
    }
  }
  return undefined;
}
