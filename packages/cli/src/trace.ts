import fs from "node:fs";
import path from "node:path";

/**
 * Structured per-session tracing: appends one JSON object per line (JSONL) to a
 * trace file so a run's turns, tool timings, routing decisions, token usage, and
 * verification/compaction/sub-agent events can be inspected after the fact.
 * Opt-in (see --trace / SCISSOR_TRACE); writes are best-effort and never throw.
 */
/** A single trace record: a timestamp, an event type, and arbitrary payload. */
export interface TraceEvent {
  ts: string;
  type: string;
  [key: string]: unknown;
}

export interface Tracer {
  readonly filePath: string;
  /** Append an event of the given type with an optional payload. */
  record(type: string, data?: Record<string, unknown>): void;
  /** Mark the start time of a tool call (keyed by call id) for duration. */
  toolStart(id: string): void;
  /** Elapsed ms since toolStart(id), or undefined if not started. */
  toolMs(id: string): number | undefined;
  /** Write a final session-end event and stop accepting further writes. */
  close(): void;
}

export function createTracer(filePath: string): Tracer {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    /* ignore */
  }
  const starts = new Map<string, number>();
  let closed = false;

  const write = (type: string, data: Record<string, unknown>): void => {
    if (closed) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + "\n";
    try {
      fs.appendFileSync(filePath, line);
    } catch {
      /* best-effort: never break a run because tracing failed */
    }
  };

  return {
    filePath,
    record: (type, data) => write(type, data ?? {}),
    toolStart: (id) => {
      starts.set(id, Date.now());
    },
    toolMs: (id) => {
      const t = starts.get(id);
      return typeof t === "number" ? Date.now() - t : undefined;
    },
    close: () => {
      if (closed) return;
      write("session-end", {});
      closed = true;
    },
  };
}
