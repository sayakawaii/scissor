/**
 * REPL-side voice controller: owns the voice mode state and the
 * listen / speak / status plumbing, so chat.ts only has to decide *when* to read
 * a spoken turn vs. a typed one. Kept separate from the providers so it stays
 * testable with a scripted VoiceEngine (no microphone required).
 */
import { theme } from "../ui/render.js";
import { isStopPhrase, speakableText } from "./index.js";
import type { VoiceEngine } from "./types.js";

export interface VoiceControllerOptions {
  engine: VoiceEngine;
  locale?: string;
  speakReplies: boolean;
  timeoutSec: number;
  /** Sink for user-facing lines; injectable for tests (defaults to stdout). */
  write?: (s: string) => void;
}

export class VoiceController {
  private continuousMode = false;
  private ready?: boolean;
  private locale?: string;
  /** Locale mismatches already warned about, so the tip isn't repeated each turn. */
  private readonly warned = new Set<string>();
  private readonly write: (s: string) => void;

  constructor(private readonly opts: VoiceControllerOptions) {
    this.write = opts.write ?? ((s) => process.stdout.write(s));
    this.locale = opts.locale;
  }

  get continuous(): boolean {
    return this.continuousMode;
  }

  get language(): string | undefined {
    return this.locale;
  }

  private async ensureReady(): Promise<boolean> {
    if (this.ready === undefined) {
      this.ready = await this.opts.engine.stt.available();
      if (!this.ready) {
        this.write(theme.warn(`Voice input unavailable: ${this.opts.engine.stt.unavailableReason()}\n`));
      }
    }
    return this.ready;
  }

  /** Listen for one utterance. Returns "" if nothing was heard or on error. */
  async listen(signal?: AbortSignal): Promise<string> {
    if (!(await this.ensureReady())) {
      this.continuousMode = false;
      return "";
    }
    this.write(theme.dim("🎤 listening… (speak now; silence skips, say \"stop\" to end)\n"));
    let partialWidth = 0;
    const showPartial = (t: string) => {
      if (!t) return;
      // Live hypothesis on one rewritten line, so the user sees it land as they
      // speak. Padded to erase a previously longer guess.
      const line = `🎤 ${t}`;
      const pad = Math.max(0, partialWidth - line.length);
      partialWidth = line.length;
      this.write("\r" + theme.dim(line + " ".repeat(pad)));
    };
    const clearPartial = () => {
      if (partialWidth > 0) this.write("\r" + " ".repeat(partialWidth) + "\r");
      partialWidth = 0;
    };
    try {
      const res = await this.opts.engine.stt.listenOnce({
        locale: this.locale,
        timeoutSec: this.opts.timeoutSec,
        signal,
        onPartial: showPartial,
      });
      clearPartial();
      await this.warnOnLocaleMismatch(res.engineLocale);
      const text = res.text.trim();
      if (text) this.write(theme.user("you ›") + " " + text + "\n");
      else this.write(theme.dim("(heard nothing)\n"));
      return text;
    } catch (err) {
      clearPartial();
      this.write(theme.err(`Voice input error: ${(err as Error).message}\n`));
      this.continuousMode = false;
      return "";
    }
  }

  /** Speak an assistant reply, best-effort (never throws into the loop). */
  async speak(text: string, signal?: AbortSignal): Promise<void> {
    const tts = this.opts.engine.tts;
    if (!this.opts.speakReplies || !tts) return;
    const stt = this.opts.engine.stt;
    try {
      if (!(await tts.available())) return;
      const spoken = speakableText(text);
      if (!spoken) return;
      // Mute recognition first: an always-on engine would happily transcribe the
      // agent's own speech back in as the next user turn.
      await stt.pause?.();
      try {
        await tts.speak(spoken, { locale: this.locale, signal });
      } finally {
        await stt.resume?.();
      }
    } catch {
      /* speaking is best-effort — a TTS failure must not break the conversation */
    }
  }

  /** Release any long-lived recognition process (called when the REPL exits). */
  async dispose(): Promise<void> {
    try {
      await this.opts.engine.stt.dispose?.();
    } catch {
      /* nothing useful to do while shutting down */
    }
  }

  /**
   * The engine that actually decoded the audio may not be the language we asked
   * for (an uninstalled locale silently falls back to the machine default), which
   * produces confident nonsense — e.g. Mandarin decoded by the en-US model. Say
   * so, once, with the locales that are actually installed.
   */
  private async warnOnLocaleMismatch(engineLocale?: string): Promise<void> {
    if (!engineLocale) return;
    const want = (this.locale ?? "").toLowerCase();
    const got = engineLocale.toLowerCase();
    // No explicit request: still tell the user which language is being decoded,
    // since "why is my Chinese coming out as English?" is otherwise invisible.
    const key = `${want}->${got}`;
    if (this.warned.has(key)) return;
    if (want && want === got) return;
    this.warned.add(key);
    const installed = await this.listLocales();
    const list = installed.length ? installed.join(", ") : "unknown";
    if (want) {
      this.write(
        theme.warn(
          `Heard using the ${engineLocale} model, not the requested ${this.locale} — ` +
            `that language isn't installed, so the transcript will be wrong. Installed: ${list}.\n`,
        ),
      );
    } else {
      this.write(
        theme.dim(
          `(recognizing as ${engineLocale}; installed: ${list} — switch with /voice lang <locale>)\n`,
        ),
      );
    }
  }

  private async listLocales(): Promise<string[]> {
    try {
      return (await this.opts.engine.stt.installedLocales?.()) ?? [];
    } catch {
      return [];
    }
  }

  /** True if `text` (a recognized utterance) should end continuous voice mode. */
  shouldStop(text: string): boolean {
    return this.continuousMode && isStopPhrase(text);
  }

  setContinuous(on: boolean): void {
    this.continuousMode = on;
  }

  /**
   * Handle a `/voice …` subcommand. Returns true when the loop should immediately
   * read one spoken turn (i.e. `/voice` or `/voice on`).
   */
  async handleCommand(cmd: string): Promise<boolean> {
    const parts = cmd.trim().split(/\s+/);
    const sub = (parts[1] ?? "").toLowerCase();
    switch (sub) {
      case "once":
        this.write(theme.dim("Single voice turn — use /voice for a continuous conversation.\n"));
        return true;
      case "":
      case "on":
      case "start":
        this.continuousMode = true;
        this.write(theme.ok("Continuous voice mode ON — say \"stop\" (or /voice off) to end.\n"));
        return true;
      case "lang":
      case "language": {
        const want = (parts[2] ?? "").trim();
        const installed = await this.listLocales();
        if (!want) {
          this.write(
            theme.warn(
              `Usage: /voice lang <locale>. Current: ${this.locale ?? "engine default"}. ` +
                `Installed: ${installed.length ? installed.join(", ") : "unknown"}\n`,
            ),
          );
          return false;
        }
        this.locale = want;
        this.warned.clear();
        const known = installed.some((l) => l.toLowerCase() === want.toLowerCase());
        this.write(
          known || installed.length === 0
            ? theme.ok(`Voice language set to ${want}.\n`)
            : theme.warn(
                `Voice language set to ${want}, but no recognizer for it is installed ` +
                  `(have: ${installed.join(", ")}) — recognition will fall back and be wrong.\n`,
              ),
        );
        return false;
      }
      case "off":
      case "stop":
        this.continuousMode = false;
        this.write(theme.ok("Voice mode OFF.\n"));
        return false;
      case "say": {
        const text = cmd.replace(/^\/voice\s+say\s*/i, "");
        if (!text.trim()) this.write(theme.warn("Usage: /voice say <text to speak>\n"));
        else await this.speak(text);
        return false;
      }
      case "status": {
        const stt = this.opts.engine.stt.name;
        const tts = this.opts.engine.tts?.name ?? "none";
        const avail = await this.opts.engine.stt.available();
        const installed = await this.listLocales();
        this.write(
          theme.dim(
            `voice: stt=${stt}(${avail ? "ready" : "unavailable"}) tts=${tts} ` +
              `locale=${this.locale ?? "engine default"} speakReplies=${this.opts.speakReplies} ` +
              `continuous=${this.continuousMode}\n` +
              `  installed languages: ${installed.length ? installed.join(", ") : "unknown"}\n`,
          ),
        );
        return false;
      }
      default:
        this.write(
          theme.warn(
            `Unknown /voice subcommand "${sub}". Try /voice (continuous), /voice once, ` +
              `/voice off, /voice lang <locale>, /voice say <text>, /voice status.\n`,
          ),
        );
        return false;
    }
  }
}
