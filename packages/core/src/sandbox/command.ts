/**
 * Command canonicalization and the fail-closed denylist.
 *
 * The old check regex-matched the raw command string, which any shell quoting
 * defeats: `$'r'm -rf /`, `"rm" -rf /`, and `r\m -rf /` all run `rm -rf /` and
 * none of them contain the literal text `rm -rf`. Worse, a match only *flagged*
 * the command for approval, so in a headless run it went straight through.
 *
 * So: unwrap the shell's quoting and escaping first, match against every form
 * the command could take, and — the part that matters — **fail closed**. If a
 * command cannot be parsed confidently, it is treated as unclassifiable and
 * refused rather than assumed safe. A blocked command is reported as a dead end
 * the agent should route around, not as a prompt the user can wave through,
 * because these are the commands where "are you sure?" is the wrong question.
 */

export type CommandVerdict =
  /** Nothing matched; the command may run (subject to approval policy). */
  | { kind: "allow" }
  /** Matched a denylist rule, or could not be parsed. Never runs. */
  | { kind: "deny"; reason: string; rule?: string }
  /** Recognized as destructive but not categorically banned: ask the user. */
  | { kind: "confirm"; reason: string; rule?: string };

/**
 * Commands that are never worth running from an agent loop. Each entry is a
 * regex tested against the canonicalized command, and each is here because the
 * blast radius is unrecoverable (wiping a filesystem, overwriting a raw device,
 * exfiltrating credentials, halting the machine) rather than merely risky.
 */
const DENY_RULES: { name: string; pattern: RegExp; reason: string }[] = [
  {
    name: "recursive-delete-of-root",
    // rm -rf / , rm -rf /* , rm -fr ~ , rm -rf $HOME, rm -rf .
    pattern: /\brm\s+(?:-[a-z]*\s+)*-?[a-z]*[rf][a-z]*\s+(?:[^\s]*\s+)*?(?:\/|\/\*|~|\$HOME|\.)\s*$/i,
    reason: "it would recursively delete the filesystem root, your home directory, or the whole working tree",
  },
  {
    name: "raw-device-write",
    pattern: /(?:>|of=)\s*\/dev\/(?:sd|nvme|disk|hd|rdisk)/i,
    reason: "it would write directly to a block device and destroy the partition table",
  },
  {
    name: "filesystem-format",
    pattern: /\b(?:mkfs(?:\.\w+)?|diskpart|format\s+[a-z]:)\b/i,
    reason: "it would format a filesystem",
  },
  {
    name: "fork-bomb",
    pattern: /:\s*\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}\s*;?\s*:/,
    reason: "it is a fork bomb",
  },
  {
    name: "shutdown",
    pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i,
    reason: "it would shut down or restart the machine",
  },
  {
    name: "pipe-remote-to-shell",
    // curl … | sh — executes whatever the network happens to serve.
    pattern: /\b(?:curl|wget|iwr|invoke-webrequest)\b[\s\S]*\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b/i,
    reason: "it would execute a script downloaded from the network without review",
  },
  {
    name: "credential-exfiltration",
    pattern: /\b(?:cat|type|copy|cp|curl|scp|Get-Content)\b[^\n]*(?:\.ssh\/id_|\.aws\/credentials|\.git-credentials|\.npmrc)/i,
    reason: "it would read or copy private keys or stored credentials",
  },
  {
    name: "permission-wipe",
    pattern: /\bchmod\s+(?:-R\s+)?(?:777|000)\s+\/(?:\s|$)/i,
    reason: "it would change permissions across the filesystem root",
  },
];

/**
 * Destructive but legitimate: history rewrites and force pushes are real parts
 * of a developer's workflow, so these ask rather than refuse.
 */
const CONFIRM_RULES: { name: string; pattern: RegExp; reason: string }[] = [
  {
    name: "force-push",
    pattern: /\bgit\s+push\b[^\n]*(?:--force(?!-with-lease)|(?:^|\s)-f(?:\s|$))/i,
    reason: "a force push can discard commits on the remote",
  },
  {
    name: "hard-reset",
    pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*[fd])/i,
    reason: "it discards uncommitted work irreversibly",
  },
  {
    name: "recursive-delete",
    pattern: /\brm\s+(?:-[a-z]*\s+)*-?[a-z]*r[a-z]*\b/i,
    reason: "it deletes a directory tree",
  },
  {
    name: "windows-recursive-delete",
    pattern: /\b(?:rmdir\s+\/s|rd\s+\/s|del\s+\/[sq]|Remove-Item\b[^\n]*-Recurse)/i,
    reason: "it deletes a directory tree",
  },
  {
    name: "privilege-escalation",
    pattern: /^\s*(?:sudo|doas|runas)\b/i,
    reason: "it runs with elevated privileges",
  },
  {
    name: "global-install",
    pattern: /\b(?:npm|pnpm|yarn)\s+(?:install|add|i)\b[^\n]*(?:-g\b|--global\b)/i,
    reason: "it modifies the machine's global package state",
  },
];

/** Longer than this and we are not parsing it; the answer is no. */
const MAX_COMMAND_LENGTH = 8000;

/**
 * Unwrap one layer of shell quoting and escaping, producing the string the shell
 * would actually execute.
 *
 * Handles POSIX single quotes (fully literal), double quotes (backslash escapes
 * for a small set of characters), ANSI-C `$'...'` quoting (where `\x41`, `\101`,
 * `\u0041` and friends decode to characters), and bare backslash escapes.
 * Returns `undefined` when the input is not consistently quoted, which the
 * caller treats as unparseable — and therefore denied.
 */
export function canonicalizeCommand(command: string): string | undefined {
  if (command.length > MAX_COMMAND_LENGTH) return undefined;
  let out = "";
  let i = 0;

  const readEscape = (source: string, at: number, ansiC: boolean): { text: string; next: number } | undefined => {
    const c = source[at];
    if (c === undefined) return undefined; // trailing backslash: unparseable
    if (!ansiC) return { text: c, next: at + 1 };
    switch (c) {
      case "n":
        return { text: "\n", next: at + 1 };
      case "t":
        return { text: "\t", next: at + 1 };
      case "r":
        return { text: "\r", next: at + 1 };
      case "0":
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7": {
        const m = /^[0-7]{1,3}/.exec(source.slice(at));
        if (!m) return { text: c, next: at + 1 };
        return { text: String.fromCharCode(Number.parseInt(m[0], 8)), next: at + m[0].length };
      }
      case "x": {
        const m = /^[0-9a-fA-F]{1,2}/.exec(source.slice(at + 1));
        if (!m) return { text: "x", next: at + 1 };
        return { text: String.fromCharCode(Number.parseInt(m[0], 16)), next: at + 1 + m[0].length };
      }
      case "u":
      case "U": {
        const width = c === "u" ? 4 : 8;
        const m = new RegExp(`^[0-9a-fA-F]{1,${width}}`).exec(source.slice(at + 1));
        if (!m) return { text: c, next: at + 1 };
        return {
          text: String.fromCodePoint(Number.parseInt(m[0], 16)),
          next: at + 1 + m[0].length,
        };
      }
      default:
        return { text: c, next: at + 1 };
    }
  };

  while (i < command.length) {
    const c = command[i]!;

    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return undefined; // unterminated quote
      out += command.slice(i + 1, close);
      i = close + 1;
      continue;
    }

    if (c === "$" && command[i + 1] === "'") {
      // ANSI-C quoting: escapes inside decode to real characters.
      i += 2;
      let closed = false;
      while (i < command.length) {
        const ch = command[i]!;
        if (ch === "\\") {
          const esc = readEscape(command, i + 1, true);
          if (!esc) return undefined;
          out += esc.text;
          i = esc.next;
          continue;
        }
        if (ch === "'") {
          i += 1;
          closed = true;
          break;
        }
        out += ch;
        i += 1;
      }
      if (!closed) return undefined;
      continue;
    }

    if (c === '"') {
      i += 1;
      let closed = false;
      while (i < command.length) {
        const ch = command[i]!;
        if (ch === "\\") {
          const next = command[i + 1];
          if (next === undefined) return undefined;
          // Inside double quotes a backslash is literal except before these.
          if ('"\\$`\n'.includes(next)) {
            out += next;
            i += 2;
          } else {
            out += ch;
            i += 1;
          }
          continue;
        }
        if (ch === '"') {
          i += 1;
          closed = true;
          break;
        }
        out += ch;
        i += 1;
      }
      if (!closed) return undefined;
      continue;
    }

    if (c === "\\") {
      const esc = readEscape(command, i + 1, false);
      if (!esc) return undefined;
      out += esc.text;
      i = esc.next;
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}

/** Collapse runs of whitespace so `rm   -rf  /` matches `rm -rf /`. */
function normalizeWhitespace(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

/**
 * Every form a command could be read as. A rule matching *any* of them is a
 * match, so quoting cannot be used to slip a pattern past the check while
 * still hitting a command that is only dangerous in its raw form.
 */
export function commandForms(command: string): { forms: string[]; parsed: boolean } {
  const raw = command;
  const normalized = normalizeWhitespace(raw);
  const canonical = canonicalizeCommand(raw);
  if (canonical === undefined) return { forms: [raw, normalized], parsed: false };
  const forms = new Set([raw, normalized, canonical, normalizeWhitespace(canonical)]);
  return { forms: [...forms], parsed: true };
}

/**
 * Classify a command. Order matters: an outright denial wins over a confirmation
 * prompt, and an unparseable command is denied rather than guessed at.
 */
export function classifyCommand(command: string): CommandVerdict {
  const trimmed = command.trim();
  if (!trimmed) return { kind: "allow" };

  const { forms, parsed } = commandForms(trimmed);

  for (const rule of DENY_RULES) {
    if (forms.some((form) => rule.pattern.test(form))) {
      return { kind: "deny", rule: rule.name, reason: rule.reason };
    }
  }

  if (!parsed) {
    return {
      kind: "deny",
      rule: "unparseable",
      reason:
        "its shell quoting could not be parsed, so it cannot be checked for safety " +
        "(unterminated quote, trailing backslash, or an over-long command line)",
    };
  }

  for (const rule of CONFIRM_RULES) {
    if (forms.some((form) => rule.pattern.test(form))) {
      return { kind: "confirm", rule: rule.name, reason: rule.reason };
    }
  }

  return { kind: "allow" };
}

/**
 * The message handed back for a denied command. Framed as a dead end rather than
 * a request, because there is no approval that would make these safe to run —
 * and telling the agent to keep working stops it retrying variations.
 */
export function denialMessage(command: string, verdict: CommandVerdict & { kind: "deny" }): string {
  return (
    `Refusing to run this command: ${verdict.reason}.\n` +
    `Command: ${command}\n` +
    `This cannot be approved from this conversation. Do not retry it or a variation of ` +
    `it — find another way to accomplish the task, or ask the user to run it themselves ` +
    `if it is genuinely what they want.`
  );
}
