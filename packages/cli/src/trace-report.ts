import { promises as fs } from "node:fs";
import path from "node:path";
import type { TraceEvent } from "./trace.js";

/**
 * Aggregate a session's JSONL trace into a token/cost report. The trace records
 * `usage` events (prompt/completion tokens) and, when the router is on, `route`
 * events naming which model tier served a turn. We attribute each usage event to
 * the most recent model (session default, or the last routed model) and price it
 * with an approximate table so a session's spend can be estimated after the run.
 */

/** Approximate USD prices per 1M tokens. Estimates only; providers change these. */
export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  // DeepSeek (cache-miss list price, approximate).
  "deepseek-chat": { inputPer1M: 0.27, outputPer1M: 1.1 },
  "deepseek-reasoner": { inputPer1M: 0.55, outputPer1M: 2.19 },
  // Anthropic Claude.
  "claude-sonnet-4-20250514": { inputPer1M: 3, outputPer1M: 15 },
  // OpenAI.
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  // Zhipu GLM (approximate USD-equivalent).
  "glm-4-plus": { inputPer1M: 7, outputPer1M: 7 },
};

/** Resolve a price for a model name, tolerating exact or prefix matches. */
export function priceFor(model: string | undefined): ModelPrice | undefined {
  if (!model) return undefined;
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  const key = Object.keys(MODEL_PRICES).find((k) => model.startsWith(k) || k.startsWith(model));
  return key ? MODEL_PRICES[key] : undefined;
}

export interface ModelTokens {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Estimated USD cost, or undefined when the model has no price entry. */
  costUsd?: number;
}

export interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  totalMs: number;
}

export interface TraceReport {
  sessionId?: string;
  provider?: string;
  model?: string;
  workspaceRoot?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  turns: number;
  /** Per-model token totals (keyed order matches first appearance). */
  perModel: ModelTokens[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Total estimated USD cost across models with known prices. */
  costUsd: number;
  /** True when at least one model lacked a price entry (cost is a lower bound). */
  costPartial: boolean;
  tools: ToolStat[];
  toolCalls: number;
  toolErrors: number;
  routes: { cheap: number; strong: number };
  verifyRuns: number;
  verifyFailures: number;
  compactions: number;
  subagents: number;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function aggregateTrace(events: TraceEvent[]): TraceReport {
  const perModelMap = new Map<string, ModelTokens>();
  const toolMap = new Map<string, ToolStat>();
  const report: TraceReport = {
    turns: 0,
    perModel: [],
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    costPartial: false,
    tools: [],
    toolCalls: 0,
    toolErrors: 0,
    routes: { cheap: 0, strong: 0 },
    verifyRuns: 0,
    verifyFailures: 0,
    compactions: 0,
    subagents: 0,
  };

  let currentModel: string | undefined;

  for (const e of events) {
    switch (e.type) {
      case "session-start": {
        report.sessionId = typeof e.sessionId === "string" ? e.sessionId : undefined;
        report.provider = typeof e.provider === "string" ? e.provider : undefined;
        report.model = typeof e.model === "string" ? e.model : undefined;
        report.workspaceRoot =
          typeof e.workspaceRoot === "string" ? e.workspaceRoot : undefined;
        report.startedAt = e.ts;
        currentModel = report.model;
        break;
      }
      case "session-end":
        report.endedAt = e.ts;
        break;
      case "turn":
        report.turns++;
        break;
      case "route": {
        if (e.tier === "cheap") report.routes.cheap++;
        else if (e.tier === "strong") report.routes.strong++;
        if (typeof e.model === "string") currentModel = e.model;
        break;
      }
      case "usage": {
        const prompt = num(e.promptTokens);
        const completion = num(e.completionTokens);
        const total = num(e.totalTokens) || prompt + completion;
        report.promptTokens += prompt;
        report.completionTokens += completion;
        report.totalTokens += total;
        const model = currentModel ?? report.model ?? "unknown";
        let mt = perModelMap.get(model);
        if (!mt) {
          mt = { model, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
          perModelMap.set(model, mt);
        }
        mt.promptTokens += prompt;
        mt.completionTokens += completion;
        mt.totalTokens += total;
        break;
      }
      case "tool": {
        const name = typeof e.name === "string" ? e.name : "unknown";
        let ts = toolMap.get(name);
        if (!ts) {
          ts = { name, calls: 0, errors: 0, totalMs: 0 };
          toolMap.set(name, ts);
        }
        ts.calls++;
        if (e.ok === false) ts.errors++;
        ts.totalMs += num(e.ms);
        report.toolCalls++;
        if (e.ok === false) report.toolErrors++;
        break;
      }
      case "verify":
        report.verifyRuns++;
        if (e.ok === false && e.skipped !== true) report.verifyFailures++;
        break;
      case "compact":
        report.compactions++;
        break;
      case "subagent":
        if (e.phase === "start") report.subagents++;
        break;
    }
  }

  if (report.startedAt && report.endedAt) {
    report.durationMs = Math.max(0, Date.parse(report.endedAt) - Date.parse(report.startedAt));
  }

  for (const mt of perModelMap.values()) {
    const price = priceFor(mt.model);
    if (price) {
      mt.costUsd =
        (mt.promptTokens / 1e6) * price.inputPer1M +
        (mt.completionTokens / 1e6) * price.outputPer1M;
      report.costUsd += mt.costUsd;
    } else {
      report.costPartial = true;
    }
    report.perModel.push(mt);
  }
  report.tools = [...toolMap.values()].sort((a, b) => b.calls - a.calls);

  return report;
}

/** Parse a JSONL trace file into events (skips blank / malformed lines). */
export async function readTraceFile(filePath: string): Promise<TraceEvent[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const events: TraceEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && typeof obj.type === "string") events.push(obj);
    } catch {
      /* skip malformed line */
    }
  }
  return events;
}

/** Find the most recently modified trace file in a directory, if any. */
export async function latestTraceFile(dir: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return undefined;
  }
  const jsonl = entries.filter((f) => f.endsWith(".jsonl"));
  if (jsonl.length === 0) return undefined;
  const withMtime = await Promise.all(
    jsonl.map(async (f) => {
      const full = path.join(dir, f);
      const stat = await fs.stat(full).catch(() => undefined);
      return { full, mtime: stat ? stat.mtimeMs : 0 };
    }),
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime[0]?.full;
}

function fmtUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtDuration(ms?: number): string {
  if (!ms) return "n/a";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

/** Render a human-readable report. `c` is an optional color palette. */
export function formatTraceReport(
  report: TraceReport,
  c: {
    bold?: (s: string) => string;
    dim?: (s: string) => string;
    ok?: (s: string) => string;
    warn?: (s: string) => string;
  } = {},
): string {
  const bold = c.bold ?? ((s: string) => s);
  const dim = c.dim ?? ((s: string) => s);
  const warn = c.warn ?? ((s: string) => s);
  const lines: string[] = [];

  lines.push(bold(`Session ${report.sessionId ?? "(unknown)"}`));
  const head: string[] = [];
  if (report.provider || report.model)
    head.push(`${report.provider ?? "?"} (${report.model ?? "?"})`);
  head.push(`${report.turns} turns`);
  head.push(fmtDuration(report.durationMs));
  lines.push(dim("  " + head.join("  \u00b7  ")));

  lines.push("");
  lines.push(bold("Tokens & estimated cost"));
  lines.push(
    dim(
      `  prompt ${report.promptTokens}  completion ${report.completionTokens}  total ${report.totalTokens}`,
    ),
  );
  for (const mt of report.perModel) {
    const cost = mt.costUsd !== undefined ? fmtUsd(mt.costUsd) : warn("n/a (no price)");
    lines.push(
      `  ${mt.model.padEnd(28)} ${String(mt.totalTokens).padStart(8)} tok   ${cost}`,
    );
  }
  const totalCost = report.costPartial
    ? `${fmtUsd(report.costUsd)} ${warn("(partial: some models unpriced)")}`
    : fmtUsd(report.costUsd);
  lines.push(bold(`  total est. cost: ${totalCost}`));

  if (report.routes.cheap + report.routes.strong > 0) {
    lines.push("");
    lines.push(bold("Routing"));
    lines.push(dim(`  cheap ${report.routes.cheap}  \u00b7  strong ${report.routes.strong}`));
  }

  lines.push("");
  lines.push(bold(`Tools (${report.toolCalls} calls, ${report.toolErrors} errors)`));
  for (const t of report.tools) {
    const err = t.errors ? warn(`  ${t.errors} err`) : "";
    lines.push(`  ${t.name.padEnd(18)} ${String(t.calls).padStart(4)}x   ${t.totalMs}ms${err}`);
  }

  const extras: string[] = [];
  if (report.verifyRuns)
    extras.push(`verify ${report.verifyRuns} (${report.verifyFailures} failed)`);
  if (report.compactions) extras.push(`compactions ${report.compactions}`);
  if (report.subagents) extras.push(`sub-agents ${report.subagents}`);
  if (extras.length) {
    lines.push("");
    lines.push(dim("  " + extras.join("  \u00b7  ")));
  }

  return lines.join("\n");
}
