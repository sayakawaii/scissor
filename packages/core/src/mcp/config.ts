import { promises as fs } from "node:fs";
import path from "node:path";
import { getConfigDir } from "../config.js";

/**
 * Configuration for a single MCP server. Mirrors the Cursor/Claude Desktop
 * `mcp.json` shape: either a local stdio process (command/args) or a remote
 * Streamable HTTP endpoint (url).
 */
export interface McpServerConfig {
  /** Executable for a local stdio server (e.g. "npx"). */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** URL for a remote Streamable HTTP server. */
  url?: string;
  /** Defaults to true; set false to keep the entry but not connect. */
  enabled?: boolean;
  /**
   * Tool names (unqualified) that may run without an approval prompt. Anything
   * not listed is treated as requiring approval (external tools can be
   * destructive, e.g. desktop control).
   */
  autoApprove?: string[];
}

export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

const EMPTY: McpConfigFile = { mcpServers: {} };

/** Path to mcp.json: SCISSOR_MCP_CONFIG override, else <configDir>/mcp.json. */
export function getMcpConfigPath(): string {
  const override = process.env.SCISSOR_MCP_CONFIG;
  if (override && override.trim().length > 0) return path.resolve(override);
  return path.join(getConfigDir(), "mcp.json");
}

export async function loadMcpConfig(): Promise<McpConfigFile> {
  const file = getMcpConfigPath();
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<McpConfigFile>;
    const servers = parsed.mcpServers;
    if (!servers || typeof servers !== "object") return { mcpServers: {} };
    return { mcpServers: servers };
  } catch (err: unknown) {
    if (isNotFound(err)) return { ...EMPTY, mcpServers: {} };
    throw new Error(
      `Failed to read MCP config at ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function saveMcpConfig(config: McpConfigFile): Promise<void> {
  const file = getMcpConfigPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/** Count servers that will actually be connected (enabled !== false). */
export function enabledServerNames(config: McpConfigFile): string[] {
  return Object.entries(config.mcpServers)
    .filter(([, sc]) => sc.enabled !== false)
    .map(([name]) => name);
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
