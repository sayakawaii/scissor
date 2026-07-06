import { spawn } from "node:child_process";
import { loadSession, saveSession, type Message } from "@scissor/core";
import { theme } from "../ui/render.js";
import { createCheckpoint, getHead, rollbackTo } from "./checkpoint.js";
import { RESTART_EXIT_CODE } from "./repo.js";
import { verifyBuild, verifySelfUpdate, type VerifyResult } from "./verify.js";

export interface ChildRunInfo {
  generation: number;
  sessionPath: string;
}

export interface SupervisorOptions {
  repo: string;
  sessionPath: string;
  /** Injectable child runner (defaults to spawning a real agent process). */
  runChild?: (info: ChildRunInfo) => Promise<number>;
  /** Injectable verifier (defaults to type-check + build + eval suite). */
  verify?: (repo: string) => Promise<VerifyResult>;
  log?: (msg: string) => void;
  maxRestarts?: number;
}

/**
 * Supervise a self-editing scissor agent. Spawns the agent child; when the
 * child requests a restart (exit code 75), checkpoints the changes, verifies
 * the new build, and either reloads into it or rolls back to the last good
 * version — then respawns so the conversation continues.
 */
export async function runSupervisor(opts: SupervisorOptions): Promise<number> {
  const log = opts.log ?? ((m: string) => process.stdout.write(m + "\n"));
  const repo = opts.repo;
  const maxRestarts = opts.maxRestarts ?? 50;
  const runChild = opts.runChild ?? defaultRunChild(repo, log);
  const verify = opts.verify ?? verifySelfUpdate;

  let lastGood = await getHead(repo);
  if (!lastGood) {
    log(theme.warn("[supervisor] no git HEAD found; automatic rollback is disabled."));
  }

  let generation = 0;
  for (;;) {
    const code = await runChild({ generation, sessionPath: opts.sessionPath });
    if (code !== RESTART_EXIT_CODE) {
      return code ?? 0;
    }

    generation += 1;
    if (generation > maxRestarts) {
      log(theme.err(`[supervisor] reached max restarts (${maxRestarts}); stopping.`));
      return 1;
    }

    log(theme.info(`\n[supervisor] restart requested (generation ${generation}). Checkpointing changes...`));
    const cp = await createCheckpoint(repo, `scissor self-update (gen ${generation})`);
    if (!cp.ok) log(theme.warn(`[supervisor] checkpoint warning: ${cp.detail}`));

    log(
      theme.info(
        "[supervisor] verifying new version (type-check + build + eval suite; the eval step calls the model and may take ~1 min)...",
      ),
    );
    const v = await verify(repo);

    if (v.ok) {
      lastGood = cp.hash ?? lastGood;
      await patchSession(opts.sessionPath, {
        lastCheckpoint: lastGood ?? undefined,
        generation,
      });
      log(theme.ok(`[supervisor] verification passed. Reloading into new version.`));
    } else {
      log(theme.err(`[supervisor] verification FAILED at "${v.step}". Rolling back.`));
      log(theme.dim(indent(v.detail)));
      if (lastGood) {
        const rb = await rollbackTo(repo, lastGood);
        log(theme.warn(`[supervisor] ${rb.detail}`));
        // Rebuild so dist matches the restored source.
        await verifyBuild(repo).catch(() => undefined);
      }
      await appendSessionNote(
        opts.sessionPath,
        `[system] Your self-update failed verification at the "${v.step}" step and was rolled back to the last working version. Do not assume your change is present. Error tail:\n${v.detail}\nReview the error and try a smaller, corrected change.`,
      );
    }
  }
}

/** Default child runner: spawn the hidden __agent subcommand, inheriting stdio. */
function defaultRunChild(repo: string, log: (m: string) => void) {
  return (info: ChildRunInfo): Promise<number> =>
    new Promise((resolve) => {
      const entry = process.argv[1];
      if (!entry) {
        log(theme.err("[supervisor] cannot determine entry script."));
        resolve(1);
        return;
      }
      const args = [
        ...process.execArgv,
        entry,
        "__agent",
        "--session",
        info.sessionPath,
        "--self-edit",
      ];
      const child = spawn(process.execPath, args, {
        cwd: repo,
        env: process.env,
        stdio: "inherit",
      });
      child.on("exit", (code) => resolve(code ?? 0));
      child.on("error", (err) => {
        log(theme.err(`[supervisor] failed to spawn agent: ${err.message}`));
        resolve(1);
      });
    });
}

async function patchSession(
  sessionPath: string,
  patch: { lastCheckpoint?: string; generation?: number },
): Promise<void> {
  try {
    const data = await loadSession(sessionPath);
    if (patch.lastCheckpoint !== undefined) data.lastCheckpoint = patch.lastCheckpoint;
    if (patch.generation !== undefined) data.generation = patch.generation;
    await saveSession(data);
  } catch {
    /* ignore */
  }
}

async function appendSessionNote(sessionPath: string, note: string): Promise<void> {
  try {
    const data = await loadSession(sessionPath);
    const msg: Message = { role: "user", content: note };
    data.messages.push(msg);
    await saveSession(data);
  } catch {
    /* ignore */
  }
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => "    " + l)
    .join("\n");
}
