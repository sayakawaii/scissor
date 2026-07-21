import { checkbox, confirm, input, select } from "@inquirer/prompts";
import type {
  ApprovalDecision,
  PlanDecision,
  ToolCall,
  ToolPreview,
} from "@scissor/core";
import { renderDiff, theme } from "./render.js";

/** Prompt the user to approve/reject a mutating tool call. */
export async function promptApproval(
  _call: ToolCall,
  preview: ToolPreview,
): Promise<ApprovalDecision> {
  process.stdout.write("\n");
  process.stdout.write(theme.warn("Approval required: ") + preview.summary + "\n");
  if (preview.detail) {
    const body = preview.detail.includes("@@")
      ? renderDiff(preview.detail)
      : theme.dim(preview.detail);
    process.stdout.write(body + "\n");
  }
  if (preview.dangerous) {
    process.stdout.write(theme.err("This action looks destructive.\n"));
  }
  const choice = await select<ApprovalDecision>({
    message: "Proceed?",
    choices: [
      { name: "Yes, run it", value: "approve" },
      { name: "Always allow this tool this session", value: "always" },
      { name: "No, skip it", value: "reject" },
    ],
  });
  return choice;
}

/**
 * Non-interactive approval handler (used under --auto or when there is no TTY):
 * show the request for visibility, then decide without blocking so headless /
 * piped runs never hang on a prompt that can't be answered. Ordinary mutating
 * calls are approved so work proceeds; genuinely destructive actions are
 * rejected rather than silently run — the rejection is fed back to the agent as
 * a non-error so it can choose another approach.
 */
export async function autoApprove(
  _call: ToolCall,
  preview: ToolPreview,
): Promise<ApprovalDecision> {
  process.stdout.write("\n");
  process.stdout.write(theme.warn("Approval required: ") + preview.summary + "\n");
  if (preview.dangerous) {
    process.stdout.write(
      theme.err("This action looks destructive.") +
        theme.dim(" (no interactive user — skipping; agent should try another way)\n"),
    );
    return "reject";
  }
  process.stdout.write(theme.dim("  (auto-approved)\n"));
  return "approve";
}

const OTHER = "__other__";

/** Handle the ask_user control tool (interactive: keyboard select / checkbox). */
export async function promptAskUser(
  question: string,
  options?: string[],
  allowMultiple?: boolean,
): Promise<string> {
  process.stdout.write("\n" + theme.info("? ") + theme.bold(question) + "\n");

  if (options && options.length > 0) {
    if (allowMultiple) {
      // Space to toggle, enter to submit. "Other" lets the user add free text.
      const picked = await checkbox<string>({
        message: "Select one or more (space to toggle, enter to confirm)",
        choices: [
          ...options.map((o) => ({ name: o, value: o })),
          { name: "Other (type my own)", value: OTHER },
        ],
      });
      const chosen = picked.filter((p) => p !== OTHER);
      if (picked.includes(OTHER)) {
        const extra = await input({ message: "Your answer" });
        if (extra.trim()) chosen.push(extra.trim());
      }
      if (chosen.length > 0) return chosen.join(", ");
      // Nothing selected — fall back to free text so we never return empty.
      return await input({ message: "Your answer" });
    }

    const choice = await select<string>({
      message: "Choose an answer",
      choices: [
        ...options.map((o) => ({ name: o, value: o })),
        { name: "Other (type my own)", value: OTHER },
      ],
    });
    if (choice !== OTHER) return choice;
  }
  return await input({ message: "Your answer" });
}

/**
 * Non-interactive ask_user handler (used under --auto or when there is no TTY):
 * show the question for visibility, then return without blocking so headless /
 * piped runs don't hang. It hands the decision back to the agent rather than
 * silently committing to an arbitrary option.
 */
export async function autoAnswerAsk(
  question: string,
  options?: string[],
): Promise<string> {
  process.stdout.write("\n" + theme.info("? ") + theme.bold(question) + "\n");
  if (options && options.length > 0) {
    process.stdout.write(theme.dim(`  options: ${options.join(" | ")}\n`));
  }
  process.stdout.write(theme.dim("  (no interactive user — proceeding automatically)\n"));
  return options && options.length > 0
    ? `No interactive user is available. Suggested options were: ${options.join(" | ")}. Proceed using your best judgment.`
    : "No interactive user is available. Proceed using your best judgment.";
}

function renderPlan(summary: string, steps: string[]): void {
  process.stdout.write("\n" + theme.brand.bold("Plan") + "\n");
  if (summary) process.stdout.write(theme.dim(summary) + "\n");
  steps.forEach((step, i) => {
    process.stdout.write(`  ${theme.info(String(i + 1) + ".")} ${step}\n`);
  });
}

/**
 * Non-interactive plan handler for `--auto`: show the plan for visibility, then
 * approve without blocking on a prompt. A plan is not a mutating/dangerous
 * action, so under `--auto` it should not stop the run (important for one-shot
 * and piped invocations, where an interactive prompt would hang forever).
 */
export async function autoApprovePlan(
  summary: string,
  steps: string[],
): Promise<PlanDecision> {
  renderPlan(summary, steps);
  process.stdout.write(theme.dim("  (auto-approved)\n"));
  return { action: "approve" };
}

/** Handle the present_plan control tool. */
export async function promptPlan(
  summary: string,
  steps: string[],
): Promise<PlanDecision> {
  renderPlan(summary, steps);
  const decision = await select<"approve" | "revise" | "reject">({
    message: "Approve this plan?",
    choices: [
      { name: "Approve and execute", value: "approve" },
      { name: "Request changes", value: "revise" },
      { name: "Reject", value: "reject" },
    ],
  });
  if (decision === "revise") {
    const feedback = await input({ message: "What should change?" });
    return { action: "revise", feedback };
  }
  return { action: decision };
}

export { confirm };
