import type { ProviderRun, TaskResult } from "./runner.js";
import { theme } from "../ui/render.js";

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function fmtTask(r: TaskResult): string {
  const mark = r.pass ? theme.ok("\u2713") : theme.err("\u2717");
  const timing = theme.dim(`${r.turns}t ${(r.elapsedMs / 1000).toFixed(1)}s`);
  const detail = r.pass ? theme.dim(r.detail) : theme.warn(r.detail + (r.error ? ` (${r.error})` : ""));
  return `  ${mark} ${pad(r.taskId, 18)} ${pad(timing, 12)} ${detail}`;
}

/** Human-readable report for the terminal. */
export function formatReport(runs: ProviderRun[]): string {
  const lines: string[] = [];
  for (const run of runs) {
    const rate = run.total > 0 ? Math.round((run.passed / run.total) * 100) : 0;
    lines.push(
      theme.bold(`\n${run.provider ?? "default"}`) +
        theme.dim(run.model ? ` (${run.model})` : ""),
    );
    for (const r of run.results) lines.push(fmtTask(r));
    const summary = `${run.passed}/${run.total} passed (${rate}%)`;
    lines.push("  " + (run.passed === run.total ? theme.ok(summary) : theme.warn(summary)));
  }
  if (runs.length > 1) {
    const passed = runs.reduce((n, r) => n + r.passed, 0);
    const total = runs.reduce((n, r) => n + r.total, 0);
    lines.push(theme.bold(`\noverall: ${passed}/${total}`));
  }
  return lines.join("\n") + "\n";
}

/** Machine-readable results for tracking over time. */
export function toResultJson(runs: ProviderRun[]): string {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      runs: runs.map((run) => ({
        provider: run.provider ?? null,
        model: run.model,
        passed: run.passed,
        total: run.total,
        results: run.results,
      })),
    },
    null,
    2,
  );
}
