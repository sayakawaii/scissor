/**
 * Persistent Windows recognition host — OPEN_ITEMS §10 Phase 2a.
 *
 * The one-shot provider (win-speech.ts) spawns PowerShell and constructs a
 * SpeechRecognitionEngine for *every* turn, and engine construction alone costs
 * seconds. That startup — not the model — dominates perceived latency. Here we
 * start the engine once and keep it running in continuous dictation mode
 * (`RecognizeAsync(Multiple)`), streaming results back over stdout:
 *
 *   @@READY@@<culture>|<name>   engine is up
 *   @@PARTIAL@@<text>           live hypothesis, still speaking
 *   @@FINAL@@<text>             an utterance completed
 *   @@ERR@@<message>            fatal host error
 *
 * and accepting PAUSE / RESUME / QUIT on stdin (PAUSE is essential: an always-on
 * mic would otherwise transcribe the agent's own TTS back as user input).
 *
 * The host body is C# compiled at startup via Add-Type rather than PowerShell
 * event plumbing, because `Register-ObjectEvent` actions don't fire reliably
 * while the main thread blocks reading stdin — .NET events + a blocking read on
 * the main thread behave correctly.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ListenOptions, SttProvider, SttResult } from "./types.js";
import { parseLocales, recognizersScript, runPowerShellOnce } from "./win-speech.js";

/**
 * The host script: a PowerShell shim that compiles and runs the C# recognizer.
 * Pure, so its shape is unit-testable without spawning PowerShell.
 */
export function hostScript(): string {
  return [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Speech",
    "Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @'",
    "using System;",
    "using System.Globalization;",
    "using System.Speech.Recognition;",
    "public static class ScissorVoiceHost {",
    "  static readonly object Gate = new object();",
    "  static SpeechRecognitionEngine rec;",
    "  static volatile bool paused = false;",
    "  static void Emit(string tag, string payload) {",
    "    lock (Gate) { Console.Out.WriteLine(tag + payload); Console.Out.Flush(); }",
    "  }",
    "  public static void Run(string locale) {",
    "    try {",
    "      if (!string.IsNullOrEmpty(locale)) {",
    "        try { rec = new SpeechRecognitionEngine(new CultureInfo(locale)); } catch { rec = null; }",
    "      }",
    "      if (rec == null) rec = new SpeechRecognitionEngine();",
    "      rec.LoadGrammar(new DictationGrammar());",
    "      rec.SetInputToDefaultAudioDevice();",
    "      rec.SpeechHypothesized += delegate(object s, SpeechHypothesizedEventArgs e) {",
    "        if (!paused && e.Result != null) Emit(\"@@PARTIAL@@\", e.Result.Text);",
    "      };",
    "      rec.SpeechRecognized += delegate(object s, SpeechRecognizedEventArgs e) {",
    "        if (!paused && e.Result != null) Emit(\"@@FINAL@@\", e.Result.Text);",
    "      };",
    "      rec.RecognizeAsync(RecognizeMode.Multiple);",
    "      Emit(\"@@READY@@\", rec.RecognizerInfo.Culture.Name + \"|\" + rec.RecognizerInfo.Name);",
    "      string line;",
    "      while ((line = Console.In.ReadLine()) != null) {",
    "        if (line == \"QUIT\") break;",
    "        if (line == \"PAUSE\") { paused = true; try { rec.RecognizeAsyncCancel(); } catch {} }",
    "        if (line == \"RESUME\") { paused = false; try { rec.RecognizeAsync(RecognizeMode.Multiple); } catch {} }",
    "      }",
    "      try { rec.RecognizeAsyncCancel(); } catch {}",
    "      rec.Dispose();",
    "    } catch (Exception ex) { Emit(\"@@ERR@@\", ex.Message); }",
    "  }",
    "}",
    "'@",
    "[ScissorVoiceHost]::Run($args[0])",
    "",
  ].join("\n");
}

type HostEvent =
  | { kind: "ready"; culture: string }
  | { kind: "partial"; text: string }
  | { kind: "final"; text: string }
  | { kind: "error"; message: string };

/** Parse one host stdout line into an event (exported for tests). */
export function parseHostLine(line: string): HostEvent | undefined {
  const s = line.trimEnd();
  if (s.startsWith("@@READY@@")) {
    return { kind: "ready", culture: (s.slice(9).split("|")[0] ?? "").trim() };
  }
  if (s.startsWith("@@PARTIAL@@")) return { kind: "partial", text: s.slice(11) };
  if (s.startsWith("@@FINAL@@")) return { kind: "final", text: s.slice(9) };
  if (s.startsWith("@@ERR@@")) return { kind: "error", message: s.slice(7) };
  return undefined;
}

/** Splits a byte stream into lines, keeping any partial trailing line. */
export function createLineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buf = "";
  return (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  };
}

/** Long-lived recognizer process. One per locale; restarted when locale changes. */
class RecognitionHost {
  private child?: ChildProcessWithoutNullStreams;
  private scriptPath?: string;
  private readyPromise?: Promise<string>;
  private culture = "";
  private onPartial?: (t: string) => void;
  private finalWaiters: Array<(t: string) => void> = [];
  private pendingFinals: string[] = [];
  private fatal?: string;

  constructor(private readonly locale: string) {}

  get activeCulture(): string {
    return this.culture;
  }

  async start(): Promise<string> {
    if (!this.readyPromise) this.readyPromise = this.spawnHost();
    return this.readyPromise;
  }

  private async spawnHost(): Promise<string> {
    const file = path.join(os.tmpdir(), `scissor-voice-host-${randomBytes(6).toString("hex")}.ps1`);
    await fs.writeFile(file, hostScript(), "utf8");
    this.scriptPath = file;
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, this.locale],
      { windowsHide: true },
    );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    return await new Promise<string>((resolve, reject) => {
      // Compiling the C# host + initializing the audio device takes a few seconds
      // on first start; after that every turn is instant.
      const timer = setTimeout(() => reject(new Error("recognition host did not start in time")), 60_000);
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };
      const feed = createLineSplitter((line) => {
        const ev = parseHostLine(line);
        if (!ev) return;
        switch (ev.kind) {
          case "ready":
            this.culture = ev.culture;
            settle(() => resolve(ev.culture));
            break;
          case "partial":
            this.onPartial?.(ev.text);
            break;
          case "final":
            this.deliverFinal(ev.text);
            break;
          case "error":
            this.fatal = ev.message;
            settle(() => reject(new Error(ev.message)));
            break;
        }
      });
      child.stdout.on("data", feed);
      child.on("error", (e) => settle(() => reject(e)));
      child.on("close", () => {
        this.child = undefined;
        if (!this.culture) settle(() => reject(new Error(this.fatal ?? "recognition host exited")));
      });
      // Don't keep the process alive on exit; also make sure it dies with us.
      child.unref();
      process.once("exit", () => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      });
    });
  }

  private deliverFinal(text: string): void {
    const waiter = this.finalWaiters.shift();
    if (waiter) waiter(text);
    else this.pendingFinals.push(text); // spoken before anyone asked; keep it
  }

  /** Resolve with the next completed utterance, or "" on timeout/abort. */
  async nextFinal(timeoutSec: number, onPartial?: (t: string) => void, signal?: AbortSignal): Promise<string> {
    const buffered = this.pendingFinals.shift();
    if (buffered !== undefined) return buffered;
    this.onPartial = onPartial;
    try {
      return await new Promise<string>((resolve) => {
        let done = false;
        const finish = (v: string) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          const i = this.finalWaiters.indexOf(waiter);
          if (i >= 0) this.finalWaiters.splice(i, 1);
          resolve(v);
        };
        const waiter = (t: string) => finish(t);
        const timer = setTimeout(() => finish(""), Math.max(1, timeoutSec) * 1000);
        const onAbort = () => finish("");
        signal?.addEventListener("abort", onAbort, { once: true });
        this.finalWaiters.push(waiter);
      });
    } finally {
      this.onPartial = undefined;
    }
  }

  send(cmd: "PAUSE" | "RESUME" | "QUIT"): void {
    try {
      this.child?.stdin.write(cmd + "\n");
    } catch {
      /* host already gone */
    }
  }

  async dispose(): Promise<void> {
    this.send("QUIT");
    const child = this.child;
    this.child = undefined;
    this.readyPromise = undefined;
    if (child) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    if (this.scriptPath) await fs.rm(this.scriptPath, { force: true }).catch(() => {});
  }
}

/**
 * Streaming Windows STT: keeps one recognizer running so turns start instantly
 * and partial text appears while you're still speaking.
 */
export class WindowsStreamingSttProvider implements SttProvider {
  readonly name = "windows-stream";
  private host?: RecognitionHost;
  private hostLocale?: string;

  async available(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    return (await this.installedLocales()).length > 0;
  }

  unavailableReason(): string {
    return process.platform !== "win32"
      ? "the Windows speech engine only runs on Windows"
      : "no Windows speech recognizer is installed — add a speech language pack in Settings › Time & Language › Speech";
  }

  async installedLocales(): Promise<string[]> {
    if (process.platform !== "win32") return [];
    return parseLocales(await runPowerShellOnce(recognizersScript(), [], 15_000));
  }

  private async ensureHost(locale?: string): Promise<RecognitionHost> {
    const want = locale ?? "";
    if (this.host && this.hostLocale === want) return this.host;
    if (this.host) await this.host.dispose(); // locale changed → new engine
    const host = new RecognitionHost(want);
    await host.start();
    this.host = host;
    this.hostLocale = want;
    return host;
  }

  async listenOnce(opts: ListenOptions = {}): Promise<SttResult> {
    const host = await this.ensureHost(opts.locale);
    host.send("RESUME");
    const text = await host.nextFinal(opts.timeoutSec ?? 10, opts.onPartial, opts.signal);
    return { text: text.trim(), engineLocale: host.activeCulture || undefined };
  }

  async pause(): Promise<void> {
    this.host?.send("PAUSE");
  }

  async resume(): Promise<void> {
    this.host?.send("RESUME");
  }

  async dispose(): Promise<void> {
    await this.host?.dispose();
    this.host = undefined;
  }
}
