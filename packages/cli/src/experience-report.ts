import { promises as fs } from "node:fs";
import path from "node:path";
import {
  aggregateExperience,
  EXPERIENCE_SCHEMA_VERSION,
  type AggregateOptions,
  type ExperienceEvent,
  type ExperienceReport,
  type ExperienceTermination,
  type FinalTaskOutcome,
} from "@scissor/core";
import { readTraceFile } from "./trace-report.js";
import type { TraceEvent } from "./trace.js";

/**
 * Bridge from CLI JSONL traces to the engine's experience layer.
 *
 * The engine defines and aggregates normalized `(state, option, outcome)` events
 * (doc §6); reading the on-disk JSONL trace and mapping it is a CLI concern (the
 * trace format lives here, not in the UI-agnostic core). This module is the only
 * place that knows both shapes.
 *
 * Backward compatibility (doc §5 Phase 1: "旧 trace 可迁移或安全忽略"): traces
 * written before trace normalization lack `state`/`termination`/`errorSignature`.
 * We still map their `tool` events on a best-effort basis (termination derived
 * from the `ok` flag, empty state) so old sessions contribute what they can.
 */

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function asState(v: unknown): Record<string, string | number | boolean> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      out[k] = val;
    }
  }
  return out;
}

function asTermination(v: unknown, ok: unknown): ExperienceTermination {
  if (v === "success" || v === "failure" || v === "cancelled" || v === "budget" || v === "guardrail") {
    return v;
  }
  // Legacy trace: no explicit termination — fall back to the ok flag.
  return ok === false ? "failure" : "success";
}

/** Map one session's trace events into normalized experience events. */
export function toExperienceEvents(events: TraceEvent[]): ExperienceEvent[] {
  const start = events.find((e) => e.type === "session-start");
  const taskId =
    start && typeof start.sessionId === "string" ? start.sessionId : "unknown-session";
  const version = start && typeof start.model === "string" ? start.model : "unknown";
  const state = asState(start?.state);

  // Session-level verification is the closest proxy for whether the whole task
  // ultimately succeeded (doc §7: final utility is judged at the task level, not
  // by a single option's local result). Use the last non-skipped verify event.
  let finalTaskOutcome: FinalTaskOutcome = "unknown";
  let verificationPassed: boolean | undefined;
  for (const e of events) {
    if (e.type === "verify" && e.skipped !== true && typeof e.ok === "boolean") {
      verificationPassed = e.ok;
      finalTaskOutcome = e.ok ? "success" : "failure";
    }
  }

  const out: ExperienceEvent[] = [];
  for (const e of events) {
    if (e.type !== "tool") continue;
    const id = typeof e.name === "string" ? e.name : "unknown";
    const termination = asTermination(e.termination, e.ok);
    const isEdit = id === "write_file" || id === "edit_file";
    out.push({
      schemaVersion: EXPERIENCE_SCHEMA_VERSION,
      taskId,
      option: { id, version },
      state,
      startedAt: typeof e.ts === "string" ? e.ts : new Date(0).toISOString(),
      durationMs: num(e.ms),
      termination,
      evidence: {
        ...(verificationPassed !== undefined ? { verificationPassed } : {}),
        ...(typeof e.errorSignature === "string" ? { errorSignature: e.errorSignature } : {}),
        ...(isEdit && termination === "success" ? { changedFiles: 1 } : {}),
      },
      cost: {},
      finalTaskOutcome,
    });
  }
  return out;
}

/** Read every JSONL trace in `dir` and map them into experience events. */
export async function loadExperienceEvents(dir: string): Promise<ExperienceEvent[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const files = entries.filter((f) => f.endsWith(".jsonl")).sort();
  const all: ExperienceEvent[] = [];
  for (const f of files) {
    try {
      const events = await readTraceFile(path.join(dir, f));
      all.push(...toExperienceEvents(events));
    } catch {
      /* skip unreadable trace file */
    }
  }
  return all;
}

/** Aggregate all traces in a directory into an offline utility report. */
export async function experienceReportFromDir(
  dir: string,
  opts: AggregateOptions = {},
): Promise<ExperienceReport> {
  return aggregateExperience(await loadExperienceEvents(dir), opts);
}

/** Aggregate a single trace file into an offline utility report. */
export async function experienceReportFromFile(
  file: string,
  opts: AggregateOptions = {},
): Promise<ExperienceReport> {
  const events = await readTraceFile(file);
  return aggregateExperience(toExperienceEvents(events), opts);
}
