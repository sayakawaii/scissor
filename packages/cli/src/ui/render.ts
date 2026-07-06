import chalk from "chalk";
import type { ToolCall, ToolPreview, ToolResult } from "@scissor/core";

export const theme = {
  brand: chalk.hex("#e05a2b"),
  dim: chalk.dim,
  bold: chalk.bold,
  user: chalk.cyan.bold,
  assistant: chalk.white,
  tool: chalk.yellow,
  ok: chalk.green,
  err: chalk.red,
  warn: chalk.hex("#e0a12b"),
  info: chalk.blue,
};

export function banner(): string {
  return theme.brand.bold("scissor") + theme.dim(" — personal terminal coding agent");
}

/** Render a unified diff with colored +/- lines. */
export function renderDiff(diff: string): string {
  const lines = diff.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      out.push(theme.dim(line));
    } else if (line.startsWith("@@")) {
      out.push(theme.info(line));
    } else if (line.startsWith("+")) {
      out.push(chalk.green(line));
    } else if (line.startsWith("-")) {
      out.push(chalk.red(line));
    } else if (line.startsWith("\\")) {
      out.push(theme.dim(line));
    } else {
      out.push(chalk.dim(line));
    }
  }
  return out.join("\n");
}

export function formatToolCallHeader(call: ToolCall, preview?: ToolPreview): string {
  const label = preview?.summary ?? summarizeArgs(call);
  const danger = preview?.dangerous ? theme.err(" [dangerous]") : "";
  return theme.tool(`\u2699  ${call.name}`) + theme.dim(` ${label}`) + danger;
}

export function formatToolResult(result: ToolResult): string {
  const prefix = result.isError ? theme.err("  \u2717 ") : theme.ok("  \u2713 ");
  const firstLine = result.content.split("\n")[0] ?? "";
  const extra = result.content.includes("\n") ? theme.dim(" ...") : "";
  return prefix + theme.dim(truncate(firstLine, 200)) + extra;
}

function summarizeArgs(call: ToolCall): string {
  const entries = Object.entries(call.arguments);
  if (entries.length === 0) return "";
  const first = entries[0];
  if (!first) return "";
  const [k, v] = first;
  const val = typeof v === "string" ? v : JSON.stringify(v);
  return `${k}=${truncate(val, 80)}`;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}
