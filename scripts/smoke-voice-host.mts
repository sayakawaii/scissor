/**
 * Manual smoke check for the persistent recognition host (OPEN_ITEMS §10 Phase 2a).
 *
 * Starts the host, waits for @@READY@@ (which proves the C# helper compiles, the
 * requested recognizer loads, and the audio device opens), prints anything the
 * engine hears for a few seconds, then shuts it down. Needs a real Windows box
 * with a microphone — it is NOT part of `npm test`.
 *
 * Run: node --import tsx scripts/smoke-voice-host.mts [locale] [seconds]
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLineSplitter, hostScript, parseHostLine } from "../packages/cli/src/voice/win-host.js";

const locale = process.argv[2] ?? "";
const seconds = Number(process.argv[3] ?? 8);

const file = path.join(os.tmpdir(), `scissor-voice-smoke-${Date.now()}.ps1`);
await fs.writeFile(file, hostScript(), "utf8");
console.log(`host script: ${file}\nlocale: ${locale || "(engine default)"}\n`);

const started = Date.now();
const child = spawn(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, locale],
  { windowsHide: true },
);
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");

let ready = false;
child.stdout.on(
  "data",
  createLineSplitter((line) => {
    const ev = parseHostLine(line);
    if (!ev) return line.trim() && console.log("  raw:", line.trim());
    if (ev.kind === "ready") {
      ready = true;
      console.log(`READY in ${Date.now() - started}ms — recognizer culture: ${ev.culture}`);
      console.log(`Speak now; listening ${seconds}s…`);
    } else if (ev.kind === "partial") console.log("  partial:", ev.text);
    else if (ev.kind === "final") console.log("  FINAL  :", ev.text);
    else console.log("  ERROR  :", ev.message);
  }),
);
child.stderr.on("data", (d) => console.log("  stderr:", String(d).trim()));

await new Promise((r) => setTimeout(r, seconds * 1000 + 15_000));
child.stdin.write("QUIT\n");
await new Promise((r) => setTimeout(r, 500));
child.kill();
await fs.rm(file, { force: true }).catch(() => {});
console.log(ready ? "\nhost started OK" : "\nhost never reached READY");
