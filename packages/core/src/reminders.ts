import type { TodoItem } from "./types.js";

/**
 * System reminders: short, situational nudges appended to the last tool result
 * of a turn.
 *
 * Some failure modes are invisible from inside a single tool call. An agent that
 * has failed the same operation four different ways cannot see the pattern; one
 * that has edited nine files without running a check does not notice; one that
 * built a task list and then stopped touching it has quietly lost the thread.
 * Each of those is obvious from a handful of per-run counters.
 *
 * They ride along on the last tool result rather than arriving as a new message:
 * that keeps the transcript's tool_call/tool_result pairing valid, costs no
 * extra round trip, and lands the nudge exactly where the model is already
 * reading.
 */

export interface ReminderContext {
  /** Name of the tool whose result the reminders will be attached to. */
  tool: string;
  /** Whether that call failed. */
  failed: boolean;
  /** Total tool calls so far this run. */
  totalCalls: number;
  /** Calls per tool name so far this run. */
  toolCounts: ReadonlyMap<string, number>;
  /**
   * Consecutive failed calls of `tool`, counting the one that just finished. A
   * success resets it, so this measures a live streak rather than a total.
   */
  consecutiveFailures: number;
  /** Current task list. */
  todos: readonly TodoItem[];
  /** Tool calls since the task list was last written. */
  callsSinceTodoWrite: number;
  /** Files edited since verification last ran. */
  unverifiedEdits: number;
}

export interface Reminder {
  name: string;
  /** Cheap gate so `generate` only runs when the situation applies. */
  shouldTrigger(ctx: ReminderContext): boolean;
  generate(ctx: ReminderContext): string | undefined;
}

/** Failed attempts at one tool before we suggest changing approach. */
const FAILURE_STREAK = 3;

/** Tool calls with an untouched task list before we mention it. */
const STALE_TODO_CALLS = 15;

/** Unverified edits before we suggest running the project's checks. */
const UNVERIFIED_EDITS = 5;

/**
 * Repeated failures of the same tool, however the arguments differ. This is the
 * complement to the oscillation guard, which only blocks byte-identical repeats
 * and so never sees an agent failing the same operation four different ways.
 */
const consecutiveFailuresReminder: Reminder = {
  name: "consecutive-failures",
  shouldTrigger(ctx) {
    return ctx.failed && ctx.consecutiveFailures >= FAILURE_STREAK;
  },
  generate(ctx) {
    return (
      `${ctx.consecutiveFailures} consecutive ${ctx.tool} calls have failed. ` +
      `Stop varying the arguments and change approach: re-read the error text, ` +
      `verify your assumptions about the file or command, or use a different tool. ` +
      `If you are stuck, say so and ask rather than continuing to retry.`
    );
  },
};

/** A task list with pending work but nothing marked as being worked on. */
const idleTodoReminder: Reminder = {
  name: "todo-idle",
  shouldTrigger(ctx) {
    return (
      ctx.todos.some((t) => t.status === "pending") &&
      !ctx.todos.some((t) => t.status === "in_progress")
    );
  },
  generate(ctx) {
    const pending = ctx.todos.filter((t) => t.status === "pending").length;
    return (
      `Your task list has ${pending} pending task(s) and none in progress. ` +
      `Mark the one you are working on as in_progress with todo_write.`
    );
  },
};

/** Unfinished tasks that have not been updated in a long while. */
const staleTodoReminder: Reminder = {
  name: "todo-stale",
  shouldTrigger(ctx) {
    return (
      ctx.callsSinceTodoWrite >= STALE_TODO_CALLS &&
      ctx.todos.some((t) => t.status === "pending" || t.status === "in_progress")
    );
  },
  generate(ctx) {
    return (
      `You have not updated your task list in ${ctx.callsSinceTodoWrite} tool calls, ` +
      `and tasks remain unfinished. Mark what you have completed and set the current ` +
      `task in_progress so the list reflects reality.`
    );
  },
};

/** Edits piling up without the project's own checks having run. */
const unverifiedEditsReminder: Reminder = {
  name: "unverified-edits",
  shouldTrigger(ctx) {
    return ctx.unverifiedEdits >= UNVERIFIED_EDITS;
  },
  generate(ctx) {
    return (
      `You have edited ${ctx.unverifiedEdits} file(s) without verifying them. ` +
      `Run the project's checks now (the diagnostics tool, or its test command via ` +
      `run_shell) instead of stacking more edits on unverified ones.`
    );
  },
};

/** The reminders enabled by default, in the order they are reported. */
export function defaultReminders(): Reminder[] {
  return [
    consecutiveFailuresReminder,
    idleTodoReminder,
    staleTodoReminder,
    unverifiedEditsReminder,
  ];
}

/**
 * Evaluate reminders and render the ones that fire as a single block, or an
 * empty string when none apply. A misbehaving reminder is skipped rather than
 * allowed to break the turn.
 */
export function renderReminders(reminders: readonly Reminder[], ctx: ReminderContext): string {
  const fired: string[] = [];
  for (const reminder of reminders) {
    try {
      if (!reminder.shouldTrigger(ctx)) continue;
      const text = reminder.generate(ctx);
      if (text?.trim()) fired.push(text.trim());
    } catch {
      /* a reminder is advisory; never let it break the run */
    }
  }
  if (fired.length === 0) return "";
  const body = fired.map((t) => `- ${t}`).join("\n");
  return `\n\n[system-reminder]\n${body}`;
}

/** Per-run counters the reminder context is built from. */
export class ReminderTracker {
  private readonly counts = new Map<string, number>();
  private readonly streaks = new Map<string, number>();
  private total = 0;
  private sinceTodoWrite = 0;
  private unverified = 0;

  /** Record a finished tool call. */
  record(tool: string, failed: boolean): void {
    this.total += 1;
    this.sinceTodoWrite += 1;
    this.counts.set(tool, (this.counts.get(tool) ?? 0) + 1);
    this.streaks.set(tool, failed ? (this.streaks.get(tool) ?? 0) + 1 : 0);
  }

  /** The task list was written, so the staleness clock restarts. */
  noteTodoWrite(): void {
    this.sinceTodoWrite = 0;
  }

  noteEdit(): void {
    this.unverified += 1;
  }

  noteVerified(): void {
    this.unverified = 0;
  }

  context(tool: string, failed: boolean, todos: readonly TodoItem[]): ReminderContext {
    return {
      tool,
      failed,
      totalCalls: this.total,
      toolCounts: this.counts,
      consecutiveFailures: this.streaks.get(tool) ?? 0,
      todos,
      callsSinceTodoWrite: this.sinceTodoWrite,
      unverifiedEdits: this.unverified,
    };
  }

  reset(): void {
    this.counts.clear();
    this.streaks.clear();
    this.total = 0;
    this.sinceTodoWrite = 0;
    this.unverified = 0;
  }
}
