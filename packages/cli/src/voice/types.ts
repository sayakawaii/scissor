/**
 * Voice I/O provider interfaces (spoken conversation via `/voice`).
 *
 * Audio is a UI concern, so this whole module lives in the CLI package — `core`
 * stays UI-agnostic (see AGENTS.md). The interfaces are deliberately small and
 * turn-based: `listenOnce` captures a single utterance and returns text, `speak`
 * renders one reply. That maps cleanly onto both a local OS speech engine
 * (Windows System.Speech) and a future cloud/streaming provider, so the REPL
 * loop never depends on how the audio is produced.
 */

export interface SttResult {
  /** Recognized text; empty string means nothing was heard (silence/timeout). */
  text: string;
  /** 0..1 engine confidence, when the provider reports it. */
  confidence?: number;
  /**
   * BCP-47 culture of the model that actually decoded the audio. May differ from
   * the requested locale when that language isn't installed — the caller warns
   * rather than silently returning nonsense (e.g. Mandarin decoded as English).
   */
  engineLocale?: string;
}

export interface ListenOptions {
  /** BCP-47 locale, e.g. "en-US" / "zh-CN". */
  locale?: string;
  /** Give up if no speech starts within this many seconds. */
  timeoutSec?: number;
  signal?: AbortSignal;
  /**
   * Live partial hypotheses as the user is still speaking (streaming engines
   * only). Lets the UI show text before the utterance ends.
   */
  onPartial?: (text: string) => void;
}

export interface SpeakOptions {
  locale?: string;
  signal?: AbortSignal;
}

/** Speech-to-text: listen for one spoken utterance and transcribe it. */
export interface SttProvider {
  readonly name: string;
  /** Whether this engine can actually run on this machine right now. */
  available(): Promise<boolean>;
  /** One-line reason shown when `available()` is false (missing engine, etc.). */
  unavailableReason(): string;
  listenOnce(opts?: ListenOptions): Promise<SttResult>;
  /** BCP-47 locales this engine can recognize, for `/voice status`. */
  installedLocales?(): Promise<string[]>;
  /**
   * Stop/resume consuming the microphone. An always-on engine must be paused
   * while the agent speaks, or it transcribes its own TTS output back as input.
   */
  pause?(): Promise<void>;
  resume?(): Promise<void>;
  /** Release a long-lived recognition process. */
  dispose?(): Promise<void>;
}

/** Text-to-speech: speak one reply aloud. */
export interface TtsProvider {
  readonly name: string;
  available(): Promise<boolean>;
  unavailableReason(): string;
  speak(text: string, opts?: SpeakOptions): Promise<void>;
}

export interface VoiceEngine {
  stt: SttProvider;
  tts?: TtsProvider;
}
