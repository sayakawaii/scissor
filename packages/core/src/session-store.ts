import { promises as fs } from "node:fs";
import path from "node:path";
import { getConfigDir } from "./config.js";
import type { ApprovalPolicy } from "./agent.js";
import type { Message, ProviderId } from "./types.js";

export const SESSION_FORMAT_VERSION = 1;

/** Persisted agent session for restart/resume continuity. */
export interface SessionData {
  formatVersion: number;
  id: string;
  createdAt: string;
  updatedAt: string;
  provider: ProviderId;
  model: string;
  workspaceRoot: string;
  approvalPolicy: ApprovalPolicy;
  /** The original high-level goal/task, for context after restart. */
  goal?: string;
  /** How many self-update restarts this session has been through. */
  generation: number;
  /** Git commit hash of the last known-good checkpoint. */
  lastCheckpoint?: string;
  /** Conversation transcript, excluding the system prompt. */
  messages: Message[];
}

export function getSessionsDir(): string {
  return path.join(getConfigDir(), "sessions");
}

export function getSessionPath(id: string): string {
  return path.join(getSessionsDir(), `${id}.json`);
}

export function newSessionId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

export async function saveSession(data: SessionData): Promise<string> {
  const dir = getSessionsDir();
  await fs.mkdir(dir, { recursive: true });
  const file = getSessionPath(data.id);
  const payload: SessionData = {
    ...data,
    formatVersion: SESSION_FORMAT_VERSION,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return file;
}

/** Load a session by id or by explicit file path. */
export async function loadSession(idOrPath: string): Promise<SessionData> {
  const file = idOrPath.endsWith(".json") ? idOrPath : getSessionPath(idOrPath);
  const raw = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(raw) as SessionData;
  if (typeof parsed.formatVersion !== "number") {
    throw new Error(`Invalid session file: ${file}`);
  }
  return parsed;
}

/** List saved sessions, newest first. */
export async function listSessions(): Promise<SessionData[]> {
  const dir = getSessionsDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const sessions: SessionData[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      sessions.push(await loadSession(path.join(dir, name)));
    } catch {
      /* skip corrupt files */
    }
  }
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
