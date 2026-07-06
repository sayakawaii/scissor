import path from "node:path";

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
