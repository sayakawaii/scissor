import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool, ToolParametersSchema } from "../types.js";
import type { McpConfigFile, McpServerConfig } from "./config.js";

const CLIENT_INFO = { name: "scissor", version: "0.2.0" };
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** Status of one configured server after a connect attempt. */
export interface McpServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

/**
 * Owns the live connections to configured MCP servers, exposes their tools as
 * scissor `Tool`s, and tears the child processes down on dispose().
 */
export class McpManager {
  readonly tools: Tool[] = [];
  readonly statuses: McpServerStatus[] = [];
  private clients: Client[] = [];

  private constructor() {}

  static async connect(opts: {
    config: McpConfigFile;
    workspaceRoot: string;
    timeoutMs?: number;
    onLog?: (line: string) => void;
  }): Promise<McpManager> {
    const mgr = new McpManager();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const imagesDir = path.join(opts.workspaceRoot, ".scissor", "mcp-images");

    for (const [name, sc] of Object.entries(opts.config.mcpServers)) {
      if (sc.enabled === false) continue;
      try {
        const client = await connectServer(name, sc, timeoutMs);
        const { tools } = await client.listTools();
        const autoApprove = new Set(sc.autoApprove ?? []);
        for (const remote of tools) {
          mgr.tools.push(wrapTool(name, client, remote, autoApprove, imagesDir));
        }
        mgr.clients.push(client);
        mgr.statuses.push({ name, connected: true, toolCount: tools.length });
        opts.onLog?.(`mcp: connected "${name}" (${tools.length} tools)`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        mgr.statuses.push({ name, connected: false, toolCount: 0, error: message });
        opts.onLog?.(`mcp: failed "${name}": ${message}`);
      }
    }
    return mgr;
  }

  async dispose(): Promise<void> {
    await Promise.all(
      this.clients.map((c) => c.close().catch(() => {})),
    );
    this.clients = [];
  }
}

async function connectServer(
  name: string,
  sc: McpServerConfig,
  timeoutMs: number,
): Promise<Client> {
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  let transport;
  if (sc.url) {
    transport = new StreamableHTTPClientTransport(new URL(sc.url));
  } else if (sc.command) {
    transport = new StdioClientTransport({
      command: resolveCommand(sc.command),
      args: sc.args ?? [],
      env: cleanEnv(sc.env),
      cwd: sc.cwd,
      stderr: "ignore",
    });
  } else {
    throw new Error(`server "${name}" has neither "command" nor "url"`);
  }
  await withTimeout(client.connect(transport), timeoutMs, `connect "${name}"`);
  return client;
}

/** On Windows, npm-published bins need the .cmd shim for a shell-less spawn. */
function resolveCommand(command: string): string {
  if (process.platform !== "win32") return command;
  const needsCmd = new Set(["npx", "npm", "pnpm", "yarn", "uvx", "bunx"]);
  return needsCmd.has(command) ? `${command}.cmd` : command;
}

/** Merge the parent env with per-server overrides, dropping undefined values. */
function cleanEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  if (extra) for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Namespaced, provider-safe tool name: mcp_<server>_<tool>. */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

interface RemoteTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}

function toParametersSchema(input?: RemoteTool["inputSchema"]): ToolParametersSchema {
  if (input && input.type === "object" && input.properties) {
    return { type: "object", properties: input.properties, required: input.required };
  }
  return { type: "object", properties: {} };
}

function wrapTool(
  server: string,
  client: Client,
  remote: RemoteTool,
  autoApprove: Set<string>,
  imagesDir: string,
): Tool {
  const localName = sanitize(`mcp_${server}_${remote.name}`);
  const dangerous = !autoApprove.has(remote.name) && !autoApprove.has("*");
  return {
    name: localName,
    description: `[mcp:${server}] ${remote.description ?? remote.name}`,
    parameters: toParametersSchema(remote.inputSchema),
    mutating: true,
    async preview(args) {
      return {
        summary: `mcp ${server}/${remote.name}`,
        detail: safeJson(args).slice(0, 2000),
        dangerous,
      };
    },
    async run(args) {
      try {
        const result = (await client.callTool({
          name: remote.name,
          arguments: args as Record<string, unknown>,
        })) as CallToolResultLike;
        const text = await renderResult(result, server, remote.name, imagesDir);
        return { content: text, isError: result.isError === true };
      } catch (err) {
        return {
          content: `MCP call failed (${server}/${remote.name}): ${(err as Error).message}`,
          isError: true,
        };
      }
    },
  };
}

interface ContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: unknown;
}
interface CallToolResultLike {
  content?: ContentItem[];
  isError?: boolean;
  structuredContent?: unknown;
}

async function renderResult(
  result: CallToolResultLike,
  server: string,
  tool: string,
  imagesDir: string,
): Promise<string> {
  const parts: string[] = [];
  for (const item of result.content ?? []) {
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item.type === "image" && typeof item.data === "string") {
      const saved = await saveImage(item.data, item.mimeType, server, tool, imagesDir);
      parts.push(`[image saved to ${saved} (${item.mimeType ?? "image"})]`);
    } else if (item.type === "resource") {
      parts.push(safeJson(item.resource));
    } else {
      parts.push(safeJson(item));
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(safeJson(result.structuredContent));
  }
  return parts.join("\n").trim() || "(no content)";
}

async function saveImage(
  base64: string,
  mimeType: string | undefined,
  server: string,
  tool: string,
  imagesDir: string,
): Promise<string> {
  await fs.mkdir(imagesDir, { recursive: true });
  const ext = mimeToExt(mimeType);
  const file = path.join(imagesDir, `${sanitize(server)}-${sanitize(tool)}-${Date.now()}.${ext}`);
  await fs.writeFile(file, Buffer.from(base64, "base64"));
  return file;
}

function mimeToExt(mimeType?: string): string {
  if (!mimeType) return "png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  return "png";
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
