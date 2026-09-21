/**
 * Voice engine resolution + shared helpers.
 *
 * Chooses concrete STT/TTS providers from config. Today only the local Windows
 * engine is implemented; "openai" is reserved (a cloud/streaming provider is the
 * planned Phase 2). Unknown/unsupported selections resolve to a provider that
 * reports itself unavailable with a helpful reason rather than throwing, so the
 * REPL degrades gracefully to typed input.
 */
import type { VoiceConfig, VoiceProviderId } from "@scissor/core";
import type { ListenOptions, SttProvider, SttResult, TtsProvider, VoiceEngine } from "./types.js";
import { WindowsSttProvider, WindowsTtsProvider } from "./win-speech.js";
import { WindowsStreamingSttProvider } from "./win-host.js";

export * from "./types.js";

/**
 * Try a fast engine, fall back to a simpler one the first time it fails.
 * The streaming host needs to compile a C# helper and hold the audio device; if
 * that's blocked (locked-down machine, no mic), we degrade to spawn-per-turn
 * recognition instead of failing the conversation. `name` reflects whichever
 * engine is actually live, so `/voice status` tells the truth.
 */
export class FallbackSttProvider implements SttProvider {
  private useBackup = false;

  constructor(
    private readonly primary: SttProvider,
    private readonly backup: SttProvider,
  ) {}

  private get current(): SttProvider {
    return this.useBackup ? this.backup : this.primary;
  }

  get name(): string {
    return this.current.name;
  }

  async available(): Promise<boolean> {
    return (await this.primary.available()) || (await this.backup.available());
  }

  unavailableReason(): string {
    return this.backup.unavailableReason();
  }

  async installedLocales(): Promise<string[]> {
    return (await this.current.installedLocales?.()) ?? [];
  }

  async listenOnce(opts?: ListenOptions): Promise<SttResult> {
    if (!this.useBackup) {
      try {
        return await this.primary.listenOnce(opts);
      } catch {
        this.useBackup = true;
        await this.primary.dispose?.().catch(() => {});
      }
    }
    return this.backup.listenOnce(opts);
  }

  async pause(): Promise<void> {
    await this.current.pause?.();
  }

  async resume(): Promise<void> {
    await this.current.resume?.();
  }

  async dispose(): Promise<void> {
    await this.primary.dispose?.();
    await this.backup.dispose?.();
  }
}

class UnavailableStt implements SttProvider {
  readonly name: string;
  constructor(name: string, private readonly reason: string) {
    this.name = name;
  }
  async available(): Promise<boolean> {
    return false;
  }
  unavailableReason(): string {
    return this.reason;
  }
  async listenOnce(): Promise<never> {
    throw new Error(this.reason);
  }
}

class UnavailableTts implements TtsProvider {
  readonly name: string;
  constructor(name: string, private readonly reason: string) {
    this.name = name;
  }
  async available(): Promise<boolean> {
    return false;
  }
  unavailableReason(): string {
    return this.reason;
  }
  async speak(): Promise<void> {
    /* no-op: replies simply aren't spoken when TTS is unavailable */
  }
}

const NOT_IMPLEMENTED =
  "the 'openai' voice provider isn't implemented yet — use 'windows' (local) for now";

function pickStt(choice: VoiceProviderId, platform: string): SttProvider {
  if (choice === "auto") {
    if (platform === "win32") {
      // Prefer the persistent streaming host (instant turns + live partials),
      // but keep the proven spawn-per-turn engine as an automatic safety net.
      return new FallbackSttProvider(new WindowsStreamingSttProvider(), new WindowsSttProvider());
    }
    return new UnavailableStt(
      "none",
      "no built-in speech-to-text on this platform — the local engine is Windows-only; set voice.stt to enable voice off Windows",
    );
  }
  switch (choice) {
    case "windows":
      return new WindowsSttProvider();
    case "windows-stream":
      return new WindowsStreamingSttProvider();
    case "openai":
      return new UnavailableStt("openai", NOT_IMPLEMENTED);
    default:
      return new UnavailableStt("none", "no speech-to-text provider is configured (set voice.stt)");
  }
}

function pickTts(choice: VoiceProviderId, platform: string): TtsProvider | undefined {
  const resolved = choice === "auto" ? (platform === "win32" ? "windows" : "none") : choice;
  switch (resolved) {
    case "windows":
      return new WindowsTtsProvider();
    case "openai":
      return new UnavailableTts("openai", NOT_IMPLEMENTED);
    case "none":
      return undefined;
    default:
      return undefined;
  }
}

export function resolveVoiceEngine(
  cfg: VoiceConfig | undefined,
  platform: string = process.platform,
): VoiceEngine {
  return {
    stt: pickStt(cfg?.stt ?? "auto", platform),
    tts: pickTts(cfg?.tts ?? "auto", platform),
  };
}

/**
 * Turn an assistant markdown reply into something worth reading aloud: drop code
 * blocks (unspeakable), strip markdown punctuation, flatten links to their text,
 * collapse whitespace, and cap the length so TTS doesn't monologue a huge answer.
 */
export function speakableText(markdown: string, maxChars = 1200): string {
  let s = markdown ?? "";
  s = s.replace(/```[\s\S]*?```/g, " (code block omitted) "); // fenced code
  s = s.replace(/`([^`]+)`/g, "$1"); // inline code
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " "); // images
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // links → text
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, ""); // headings
  s = s.replace(/[*_~>#|]/g, ""); // stray markdown punctuation
  s = s.replace(/^\s*[-+]\s+/gm, ""); // bullet markers
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > maxChars) s = s.slice(0, maxChars).replace(/\s+\S*$/, "") + " …";
  return s;
}

/** Spoken phrases that end continuous voice mode. */
export function isStopPhrase(text: string): boolean {
  return /^\s*(stop|exit|quit|end|cancel)(\s+(voice|listening|mode))?[.!]?\s*$/i.test(text);
}
