/**
 * Windows local speech engine — the default voice provider (offline, zero
 * runtime deps). STT uses `System.Speech.Recognition` (the same engine behind
 * Windows dictation; needs a speech language pack installed), TTS uses
 * `System.Speech.Synthesis` (SAPI, always present on Windows).
 *
 * We can't call these .NET APIs from Node directly, so — exactly like the Go
 * bridge in eval/go-helpers.ts — we write a tiny PowerShell script to a temp
 * file and spawn `powershell.exe -File`, then parse sentinel-prefixed lines off
 * stdout. The script builders are pure so their shape is unit-testable without
 * spawning anything or touching a microphone.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ListenOptions, SpeakOptions, SttProvider, SttResult, TtsProvider } from "./types.js";

const PS = "powershell.exe";
const PS_FLAGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];

/** UTF-8 stdout so recognized/spoken non-ASCII text survives the console codepage. */
const PS_PREAMBLE = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n';

/**
 * PS that prints "@@RECOG@@<n>" (installed STT recognizer count) plus one
 * "@@LOCALE@@<culture>|<name>" line per recognizer, so the UI can tell the user
 * which languages are actually usable on this machine.
 */
export function recognizersScript(): string {
  return (
    PS_PREAMBLE +
    "try {\n" +
    "  Add-Type -AssemblyName System.Speech\n" +
    "  $all = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()\n" +
    '  [Console]::Out.WriteLine("@@RECOG@@" + $all.Count)\n' +
    '  foreach ($r in $all) { [Console]::Out.WriteLine("@@LOCALE@@" + $r.Culture.Name + "|" + $r.Name) }\n' +
    '} catch { [Console]::Out.WriteLine("@@RECOG@@0") }\n'
  );
}

/**
 * PS that listens for one utterance and prints "@@STT@@<text>" (empty on
 * silence/timeout) or "@@STTERR@@<message>". Args: [0]=locale, [1]=timeoutSec.
 *
 * It also always reports the recognizer it actually used as
 * "@@ENGINE@@<culture>|<name>". That matters: if the requested locale has no
 * recognizer we fall back to the machine default, and decoding (say) Mandarin
 * with the en-US model yields confident nonsense. Reporting the culture lets the
 * caller warn instead of silently mis-transcribing.
 */
export function recognizeScript(): string {
  return (
    PS_PREAMBLE +
    "try {\n" +
    "  Add-Type -AssemblyName System.Speech\n" +
    "  $locale = $args[0]; $timeout = [int]$args[1]\n" +
    "  $rec = $null\n" +
    "  if ($locale) {\n" +
    "    try { $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine (New-Object System.Globalization.CultureInfo($locale)) } catch { $rec = $null }\n" +
    "  }\n" +
    "  if ($rec -eq $null) { $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine }\n" +
    '  [Console]::Out.WriteLine("@@ENGINE@@" + $rec.RecognizerInfo.Culture.Name + "|" + $rec.RecognizerInfo.Name)\n' +
    "  $rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))\n" +
    "  $rec.SetInputToDefaultAudioDevice()\n" +
    "  $res = $rec.Recognize([TimeSpan]::FromSeconds($timeout))\n" +
    '  if ($res -ne $null) { [Console]::Out.WriteLine("@@STT@@" + $res.Text) } else { [Console]::Out.WriteLine("@@STT@@") }\n' +
    "  $rec.Dispose()\n" +
    '} catch { [Console]::Out.WriteLine("@@STTERR@@" + $_.Exception.Message) }\n'
  );
}

/**
 * PS that speaks the UTF-8 text file at args[0] via SAPI, optionally preferring a
 * voice for the locale at args[1]. Prints "@@TTSERR@@<message>" on failure.
 */
export function speakScript(): string {
  return (
    PS_PREAMBLE +
    "try {\n" +
    "  Add-Type -AssemblyName System.Speech\n" +
    "  $path = $args[0]; $locale = $args[1]\n" +
    "  $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)\n" +
    "  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer\n" +
    "  if ($locale) {\n" +
    "    try { $synth.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::NotSet, [System.Speech.Synthesis.VoiceAge]::NotSet, 0, (New-Object System.Globalization.CultureInfo($locale))) } catch {}\n" +
    "  }\n" +
    "  $synth.Speak($text)\n" +
    "  $synth.Dispose()\n" +
    '} catch { [Console]::Out.WriteLine("@@TTSERR@@" + $_.Exception.Message) }\n'
  );
}

interface PsResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Write a PS script to a temp file, run it with args, return stdout/stderr. */
async function runPowerShell(
  script: string,
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<PsResult> {
  const file = path.join(os.tmpdir(), `scissor-voice-${randomBytes(6).toString("hex")}.ps1`);
  await fs.writeFile(file, script, "utf8");
  try {
    return await new Promise<PsResult>((resolve) => {
      const child = spawn(PS, [...PS_FLAGS, file, ...args], { windowsHide: true });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const done = (r: PsResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(r);
      };
      const timer = setTimeout(() => {
        child.kill();
        done({ code: null, stdout, stderr: stderr + "\n(timed out)" });
      }, opts.timeoutMs);
      const onAbort = () => {
        child.kill();
        done({ code: null, stdout, stderr: stderr + "\n(aborted)" });
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (d) => (stdout += d));
      child.stderr?.on("data", (d) => (stderr += d));
      child.on("error", (e) => done({ code: null, stdout, stderr: stderr + "\n" + e.message }));
      child.on("close", (code) => done({ code, stdout, stderr }));
    });
  } finally {
    await fs.rm(file, { force: true }).catch(() => {});
  }
}

/** Run a one-shot PowerShell script and return its stdout (shared with win-host). */
export async function runPowerShellOnce(
  script: string,
  args: string[] = [],
  timeoutMs = 15_000,
): Promise<string> {
  const r = await runPowerShell(script, args, { timeoutMs });
  return r.stdout;
}

/** Pull the first "@@TAG@@rest" line's payload out of PowerShell stdout. */
export function parseSentinel(stdout: string, tag: string): string | undefined {
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith(tag)) return line.slice(tag.length);
  }
  return undefined;
}

/** Collect the BCP-47 cultures from "@@LOCALE@@<culture>|<name>" lines. */
export function parseLocales(stdout: string): string[] {
  const out: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.startsWith("@@LOCALE@@")) continue;
    const culture = (line.slice("@@LOCALE@@".length).split("|")[0] ?? "").trim();
    if (culture && !out.includes(culture)) out.push(culture);
  }
  return out;
}

export class WindowsSttProvider implements SttProvider {
  readonly name = "windows";

  async available(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    const r = await runPowerShell(recognizersScript(), [], { timeoutMs: 15_000 });
    const n = parseSentinel(r.stdout, "@@RECOG@@");
    return n !== undefined && Number(n) > 0;
  }

  unavailableReason(): string {
    return process.platform !== "win32"
      ? "the Windows speech engine only runs on Windows (set voice.stt to another provider)"
      : "no Windows speech recognizer is installed — add a speech language pack in Settings › Time & Language › Speech";
  }

  async installedLocales(): Promise<string[]> {
    if (process.platform !== "win32") return [];
    const r = await runPowerShell(recognizersScript(), [], { timeoutMs: 15_000 });
    return parseLocales(r.stdout);
  }

  async listenOnce(opts: ListenOptions = {}): Promise<SttResult> {
    const locale = opts.locale ?? "";
    const timeout = Math.max(1, Math.round(opts.timeoutSec ?? 10));
    // Give the child a little longer than its internal silence timeout to return.
    const r = await runPowerShell(recognizeScript(), [locale, String(timeout)], {
      timeoutMs: timeout * 1000 + 20_000,
      signal: opts.signal,
    });
    const err = parseSentinel(r.stdout, "@@STTERR@@");
    if (err) throw new Error(`speech recognition failed: ${err.trim()}`);
    const text = parseSentinel(r.stdout, "@@STT@@");
    const engine = parseSentinel(r.stdout, "@@ENGINE@@");
    return {
      text: (text ?? "").trim(),
      engineLocale: engine ? (engine.split("|")[0] ?? "").trim() : undefined,
    };
  }
}

export class WindowsTtsProvider implements TtsProvider {
  readonly name = "windows";

  async available(): Promise<boolean> {
    return process.platform === "win32";
  }

  unavailableReason(): string {
    return "Windows SAPI text-to-speech only runs on Windows (set voice.tts to 'none' or another provider)";
  }

  async speak(text: string, opts: SpeakOptions = {}): Promise<void> {
    const clean = text.trim();
    if (!clean) return;
    const file = path.join(os.tmpdir(), `scissor-tts-${randomBytes(6).toString("hex")}.txt`);
    await fs.writeFile(file, clean, "utf8");
    try {
      const r = await runPowerShell(speakScript(), [file, opts.locale ?? ""], {
        timeoutMs: 120_000,
        signal: opts.signal,
      });
      const err = parseSentinel(r.stdout, "@@TTSERR@@");
      if (err) throw new Error(`speech synthesis failed: ${err.trim()}`);
    } finally {
      await fs.rm(file, { force: true }).catch(() => {});
    }
  }
}
