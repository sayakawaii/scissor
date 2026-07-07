import { Command } from "commander";
import {
  loadMcpConfig,
  McpManager,
  saveMcpConfig,
  type McpServerConfig,
} from "@scissor/core";
import { theme } from "../ui/render.js";

/** Built-in presets so common servers are one command to add. */
const PRESETS: Record<string, McpServerConfig> = {
  browser: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
  desktop: { command: "npx", args: ["-y", "terminator-mcp-agent"] },
};

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseEnv(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const p of pairs) {
    const eq = p.indexOf("=");
    if (eq > 0) env[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return env;
}

function describe(name: string, sc: McpServerConfig): string {
  const target = sc.url ? sc.url : `${sc.command ?? "?"} ${(sc.args ?? []).join(" ")}`.trim();
  const state = sc.enabled === false ? theme.warn("[disabled]") : theme.ok("[enabled]");
  const auto = sc.autoApprove?.length ? theme.dim(` auto-approve: ${sc.autoApprove.join(", ")}`) : "";
  return `  ${theme.brand(name)} ${state}  ${theme.dim(target)}${auto}`;
}

async function listServers(): Promise<number> {
  const config = await loadMcpConfig();
  const names = Object.keys(config.mcpServers);
  if (names.length === 0) {
    process.stdout.write(
      theme.dim("No MCP servers configured. Add one, e.g.:\n  scissor mcp add browser\n"),
    );
    return 0;
  }
  process.stdout.write(theme.bold("Configured MCP servers:\n"));
  for (const name of names) process.stdout.write(describe(name, config.mcpServers[name]!) + "\n");
  return 0;
}

interface AddOpts {
  command?: string;
  arg: string[];
  url?: string;
  env: string[];
  autoApprove: string[];
}

async function addServer(name: string, opts: AddOpts): Promise<number> {
  const config = await loadMcpConfig();
  let entry: McpServerConfig;
  if (opts.url) {
    entry = { url: opts.url };
  } else if (opts.command) {
    entry = { command: opts.command, args: opts.arg };
  } else if (PRESETS[name]) {
    entry = { ...PRESETS[name] };
  } else {
    process.stderr.write(
      theme.err(
        `Provide --command <cmd> [--arg ...] or --url <url>, or use a known preset (${Object.keys(PRESETS).join(", ")}).\n`,
      ),
    );
    return 2;
  }
  if (opts.env.length) entry.env = parseEnv(opts.env);
  if (opts.autoApprove.length) entry.autoApprove = opts.autoApprove;
  config.mcpServers[name] = entry;
  await saveMcpConfig(config);
  process.stdout.write(theme.ok(`Added MCP server "${name}".\n`));
  process.stdout.write(describe(name, entry) + "\n");
  process.stdout.write(theme.dim(`Test it with: scissor mcp test ${name}\n`));
  return 0;
}

async function removeServer(name: string): Promise<number> {
  const config = await loadMcpConfig();
  if (!config.mcpServers[name]) {
    process.stderr.write(theme.err(`No MCP server named "${name}".\n`));
    return 1;
  }
  delete config.mcpServers[name];
  await saveMcpConfig(config);
  process.stdout.write(theme.ok(`Removed MCP server "${name}".\n`));
  return 0;
}

async function setEnabled(name: string, enabled: boolean): Promise<number> {
  const config = await loadMcpConfig();
  const sc = config.mcpServers[name];
  if (!sc) {
    process.stderr.write(theme.err(`No MCP server named "${name}".\n`));
    return 1;
  }
  sc.enabled = enabled;
  await saveMcpConfig(config);
  process.stdout.write(theme.ok(`${enabled ? "Enabled" : "Disabled"} "${name}".\n`));
  return 0;
}

async function testServers(name?: string): Promise<number> {
  const full = await loadMcpConfig();
  const config = name
    ? { mcpServers: full.mcpServers[name] ? { [name]: full.mcpServers[name]! } : {} }
    : full;
  if (Object.keys(config.mcpServers).length === 0) {
    process.stderr.write(theme.err(name ? `No MCP server named "${name}".\n` : "No servers.\n"));
    return 1;
  }
  process.stdout.write(theme.dim("Connecting (npx servers may download on first run)...\n"));
  const mgr = await McpManager.connect({
    config,
    workspaceRoot: process.cwd(),
    onLog: (line) => process.stdout.write(theme.dim(`  ${line}\n`)),
  });
  let anyFail = false;
  for (const s of mgr.statuses) {
    if (s.connected) {
      const tools = mgr.tools
        .filter((t) => t.name.startsWith(`mcp_${s.name.replace(/[^a-zA-Z0-9_-]/g, "_")}_`))
        .map((t) => t.name);
      process.stdout.write(
        theme.ok(`  \u2713 ${s.name}: ${s.toolCount} tools`) +
          (tools.length ? theme.dim(`  (${tools.join(", ")})`) : "") +
          "\n",
      );
    } else {
      anyFail = true;
      process.stdout.write(theme.err(`  \u2717 ${s.name}: ${s.error ?? "failed"}\n`));
    }
  }
  await mgr.dispose();
  return anyFail ? 1 : 0;
}

/** Build the `scissor mcp` command tree. */
export function buildMcpCommand(): Command {
  const mcp = new Command("mcp").description("manage MCP servers (external tools for the agent)");

  mcp.command("list").description("list configured MCP servers").action(async () => {
    process.exit(await listServers());
  });

  mcp
    .command("add <name>")
    .description("add or update a server (presets: browser, desktop)")
    .option("--command <cmd>", "executable for a local stdio server")
    .option("--arg <arg>", "argument for the command (repeatable)", collect, [])
    .option("--url <url>", "URL for a remote Streamable HTTP server")
    .option("--env <k=v>", "environment variable (repeatable)", collect, [])
    .option("--auto-approve <tool>", "tool name to run without approval (repeatable)", collect, [])
    .action(async (name: string, opts: AddOpts) => {
      process.exit(await addServer(name, opts));
    });

  mcp.command("remove <name>").description("remove a server").action(async (name: string) => {
    process.exit(await removeServer(name));
  });
  mcp.command("enable <name>").description("enable a server").action(async (name: string) => {
    process.exit(await setEnabled(name, true));
  });
  mcp.command("disable <name>").description("disable a server").action(async (name: string) => {
    process.exit(await setEnabled(name, false));
  });
  mcp
    .command("test [name]")
    .description("connect and list tools (diagnostic)")
    .action(async (name?: string) => {
      process.exit(await testServers(name));
    });

  return mcp;
}
