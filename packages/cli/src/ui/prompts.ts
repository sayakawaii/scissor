import { confirm, input, select } from "@inquirer/prompts";
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

/** Handle the ask_user control tool. */
export async function promptAskUser(
  question: string,
  options?: string[],
): Promise<string> {
  process.stdout.write("\n" + theme.info("? ") + theme.bold(question) + "\n");
  if (options && options.length > 0) {
    const choice = await select<string>({
      message: "Choose an answer",
      choices: [
        ...options.map((o) => ({ name: o, value: o })),
        { name: "Other (type my own)", value: "__other__" },
      ],
    });
    if (choice !== "__other__") return choice;
  }
  return await input({ message: "Your answer" });
}

/** Handle the present_plan control tool. */
export async function promptPlan(
  summary: string,
  steps: string[],
): Promise<PlanDecision> {
  process.stdout.write("\n" + theme.brand.bold("Plan") + "\n");
  if (summary) process.stdout.write(theme.dim(summary) + "\n");
  steps.forEach((step, i) => {
    process.stdout.write(`  ${theme.info(String(i + 1) + ".")} ${step}\n`);
  });
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
