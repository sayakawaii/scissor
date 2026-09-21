/**
 * Deterministic test: voice I/O plumbing (packages/cli/src/voice/*).
 *
 * Exercises everything that does NOT need a microphone or PowerShell:
 *  - resolveVoiceEngine picks Windows locally, degrades gracefully elsewhere,
 *  - speakableText strips markdown/code and caps length before TTS,
 *  - isStopPhrase recognizes "stop"-style utterances (and not false positives),
 *  - the PowerShell script builders contain the right .NET calls + sentinels,
 *  - parseSentinel pulls payloads off (possibly CRLF) stdout,
 *  - VoiceController drives listen/speak/mode correctly against a scripted engine.
 *
 * The real mic + System.Speech path is a manual Windows smoke test (see
 * docs/voice.md); it can't run in CI.
 *
 * Run: node --import tsx scripts/test-voice.mts
 */
import assert from "node:assert/strict";
import {
  isStopPhrase,
  resolveVoiceEngine,
  speakableText,
  type SttProvider,
  type SttResult,
  type TtsProvider,
  type VoiceEngine,
} from "../packages/cli/src/voice/index.js";
import {
  parseLocales,
  parseSentinel,
  recognizeScript,
  recognizersScript,
  speakScript,
} from "../packages/cli/src/voice/win-speech.js";
import { VoiceController } from "../packages/cli/src/voice/controller.js";
import { FallbackSttProvider } from "../packages/cli/src/voice/index.js";
import {
  createLineSplitter,
  hostScript,
  parseHostLine,
} from "../packages/cli/src/voice/win-host.js";

// 1. Engine resolution -------------------------------------------------------
{
  const win = resolveVoiceEngine(undefined, "win32");
  assert.equal(win.stt.name, "windows-stream", "auto → streaming Windows STT on win32");
  assert.equal(win.tts?.name, "windows", "auto → Windows TTS on win32");
  assert.equal(
    resolveVoiceEngine({ stt: "windows" }, "win32").stt.name,
    "windows",
    "the simpler spawn-per-turn engine stays selectable",
  );

  const linux = resolveVoiceEngine(undefined, "linux");
  assert.equal(linux.stt.name, "none", "auto → no local STT off-Windows");
  assert.equal(await linux.stt.available(), false, "unavailable off-Windows");
  assert.match(linux.stt.unavailableReason(), /Windows/, "reason explains the platform limit");
  assert.equal(linux.tts, undefined, "no TTS off-Windows under auto");

  const openai = resolveVoiceEngine({ stt: "openai", tts: "none" }, "linux");
  assert.equal(openai.stt.name, "openai");
  assert.equal(await openai.stt.available(), false, "openai STT not implemented yet");
  assert.match(openai.stt.unavailableReason(), /isn't implemented yet/);
  assert.equal(openai.tts, undefined, "tts:none → no TTS");
}

// 2. speakableText -----------------------------------------------------------
{
  const md = [
    "# Heading",
    "Here is **bold** and `inline` and a [link](http://x.com).",
    "```ts",
    "const x = 1;",
    "```",
    "- a bullet",
  ].join("\n");
  const s = speakableText(md);
  assert.ok(!s.includes("```"), "fenced code removed");
  assert.ok(s.includes("(code block omitted)"), "code replaced with a spoken marker");
  assert.ok(!s.includes("`"), "inline backticks removed");
  assert.ok(s.includes("inline"), "inline code content kept");
  assert.ok(s.includes("link") && !s.includes("http://x.com"), "link → text, url dropped");
  assert.ok(!/[#*]/.test(s), "markdown punctuation stripped");
  assert.ok(!s.includes("\n"), "flattened to one spoken line");

  const long = speakableText("word ".repeat(1000), 100);
  assert.ok(long.length <= 104, "capped near maxChars");
  assert.ok(long.endsWith("…"), "truncation marked");

  assert.equal(speakableText(""), "", "empty stays empty");
}

// 3. isStopPhrase ------------------------------------------------------------
{
  for (const yes of ["stop", "Stop.", "exit voice", "quit listening", "end mode", "cancel"]) {
    assert.ok(isStopPhrase(yes), `stop phrase: ${yes}`);
  }
  for (const no of ["stop the server", "please continue", "exit the function", "how do I stop a goroutine"]) {
    assert.ok(!isStopPhrase(no), `not a stop phrase: ${no}`);
  }
}

// 4. PowerShell script builders + parseSentinel ------------------------------
{
  const rec = recognizeScript();
  assert.match(rec, /System\.Speech/, "loads System.Speech");
  assert.match(rec, /SpeechRecognitionEngine/);
  assert.match(rec, /DictationGrammar/, "free-form dictation grammar");
  assert.match(rec, /SetInputToDefaultAudioDevice/);
  assert.match(rec, /@@STT@@/, "emits the STT sentinel");
  assert.match(rec, /@@STTERR@@/, "emits an error sentinel");
  assert.match(rec, /@@ENGINE@@/, "reports which recognizer actually decoded");
  assert.match(rec, /RecognizerInfo\.Culture\.Name/, "engine line carries the culture");
  assert.match(rec, /OutputEncoding.*UTF8/, "forces UTF-8 stdout");

  assert.match(speakScript(), /SpeechSynthesizer/);
  assert.match(speakScript(), /ReadAllText/, "reads the text file (no shell quoting)");
  assert.match(recognizersScript(), /InstalledRecognizers/);
  assert.match(recognizersScript(), /@@RECOG@@/);
  assert.match(recognizersScript(), /@@LOCALE@@/, "enumerates installed languages");

  assert.equal(parseSentinel("noise\r\n@@STT@@hello world\r\nmore", "@@STT@@"), "hello world");
  assert.equal(parseSentinel("@@RECOG@@2", "@@RECOG@@"), "2");
  assert.equal(parseSentinel("nothing here", "@@STT@@"), undefined, "missing → undefined");
  assert.equal(parseSentinel("@@STT@@", "@@STT@@"), "", "empty payload → empty string (silence)");

  assert.deepEqual(
    parseLocales("@@RECOG@@2\r\n@@LOCALE@@en-US|MS-1033-80-DESK\r\n@@LOCALE@@zh-CN|MS-2052-80-DESK"),
    ["en-US", "zh-CN"],
    "collects installed cultures",
  );
  assert.deepEqual(parseLocales("no locales"), [], "none → empty");
}

// 5. VoiceController against a scripted engine -------------------------------
class ScriptedStt implements SttProvider {
  readonly name = "scripted";
  /** Culture the fake engine claims to have decoded with. */
  engineLocale?: string;
  locales: string[] = ["en-US", "zh-CN"];
  lastRequestedLocale?: string;
  constructor(private queue: string[], public isAvailable = true) {}
  async available(): Promise<boolean> {
    return this.isAvailable;
  }
  unavailableReason(): string {
    return "scripted stt unavailable";
  }
  async installedLocales(): Promise<string[]> {
    return this.locales;
  }
  /** Queue another utterance for a later listen(). */
  push(text: string): void {
    this.queue.push(text);
  }
  async listenOnce(opts?: { locale?: string }): Promise<SttResult> {
    this.lastRequestedLocale = opts?.locale;
    return { text: this.queue.shift() ?? "", engineLocale: this.engineLocale };
  }
}
class RecordingTts implements TtsProvider {
  readonly name = "scripted";
  spoken: string[] = [];
  constructor(public isAvailable = true) {}
  async available(): Promise<boolean> {
    return this.isAvailable;
  }
  unavailableReason(): string {
    return "scripted tts unavailable";
  }
  async speak(text: string): Promise<void> {
    this.spoken.push(text);
  }
}

function makeController(stt: SttProvider, tts?: TtsProvider, speakReplies = true) {
  const out: string[] = [];
  const engine: VoiceEngine = { stt, tts };
  const c = new VoiceController({
    engine,
    speakReplies,
    timeoutSec: 5,
    write: (s) => out.push(s),
  });
  return { c, out };
}

{
  // listen returns the utterance and echoes it; empty prints "(heard nothing)".
  const stt = new ScriptedStt(["hello scissor", ""]);
  const { c, out } = makeController(stt);
  assert.equal(await c.listen(), "hello scissor");
  assert.ok(out.join("").includes("hello scissor"), "echoes recognized text");
  assert.equal(await c.listen(), "", "silence → empty");
  assert.ok(out.join("").includes("heard nothing"));
}

{
  // Bare /voice starts a *continuous* conversation (what users expect); /voice
  // once is the single-turn escape hatch.
  const { c } = makeController(new ScriptedStt([]));
  assert.equal(await c.handleCommand("/voice"), true, "/voice → start listening");
  assert.equal(c.continuous, true, "/voice → continuous conversation");
  assert.equal(c.shouldStop("stop"), true, "stop phrase ends continuous mode");
  assert.equal(await c.handleCommand("/voice off"), false);
  assert.equal(c.continuous, false);
  assert.equal(c.shouldStop("stop"), false, "not in mode → don't treat as stop");

  assert.equal(await c.handleCommand("/voice once"), true, "/voice once → listen");
  assert.equal(c.continuous, false, "/voice once stays single-turn");
}

{
  // TTS: speaks stripped reply when enabled; no-op when disabled or unavailable.
  const tts = new RecordingTts();
  const { c } = makeController(new ScriptedStt([]), tts, true);
  await c.speak("**Great** answer. `code` here.");
  assert.equal(tts.spoken.length, 1, "spoke once");
  assert.ok(!tts.spoken[0]!.includes("*"), "reply was stripped before speaking");

  const tts2 = new RecordingTts();
  const { c: c2 } = makeController(new ScriptedStt([]), tts2, false);
  await c2.speak("hello");
  assert.equal(tts2.spoken.length, 0, "speakReplies=false → silent");

  await c.handleCommand("/voice say testing one two");
  assert.ok(tts.spoken.some((s) => s.includes("testing one two")), "/voice say speaks the text");
}

{
  // Locale: /voice lang switches the language used for the NEXT listen.
  const stt = new ScriptedStt(["你好", "再来一句"]);
  const { c, out } = makeController(stt);
  assert.equal(await c.handleCommand("/voice lang zh-CN"), false, "lang doesn't start listening");
  assert.equal(c.language, "zh-CN");
  await c.listen();
  assert.equal(stt.lastRequestedLocale, "zh-CN", "requested locale reaches the engine");
  assert.ok(out.join("").includes("zh-CN"), "confirms the language switch");

  // An uninstalled language is called out rather than silently accepted.
  stt.locales = ["en-US"];
  const { c: c2, out: out2 } = makeController(stt);
  await c2.handleCommand("/voice lang ja-JP");
  assert.ok(out2.join("").includes("no recognizer"), "warns the language isn't installed");
}

{
  // The Chinese-as-English bug: asked for zh-CN but the engine decoded en-US →
  // warn loudly instead of returning confident nonsense.
  const stt = new ScriptedStt(["some english words"]);
  stt.engineLocale = "en-US";
  const { c, out } = makeController(stt);
  await c.handleCommand("/voice lang zh-CN");
  await c.listen();
  const text = out.join("");
  assert.ok(text.includes("en-US") && text.includes("zh-CN"), "names both locales");
  assert.match(text, /isn't installed|transcript will be wrong/, "explains the consequence");

  // Warned once, not on every turn.
  const before = out.length;
  stt.push("more words");
  await c.listen();
  const added = out.slice(before).join("");
  assert.ok(!/transcript will be wrong/.test(added), "mismatch warning isn't repeated");
}

{
  // No explicit locale: still surface which language is being decoded.
  const stt = new ScriptedStt(["hello"]);
  stt.engineLocale = "en-US";
  const { c, out } = makeController(stt);
  await c.listen();
  assert.ok(out.join("").includes("recognizing as en-US"), "tells the user the active language");
  assert.ok(out.join("").includes("/voice lang"), "points at the fix");
}

{
  // Unavailable STT: listen returns "" and turns continuous off (graceful degrade).
  const { c, out } = makeController(new ScriptedStt(["x"], false));
  c.setContinuous(true);
  assert.equal(await c.listen(), "");
  assert.equal(c.continuous, false, "unavailable engine disables continuous mode");
  assert.ok(out.join("").includes("unavailable"), "prints why it's unavailable");
}

// 6. Streaming host (Phase 2a) protocol ------------------------------------
{
  const s = hostScript();
  assert.match(s, /RecognizeAsync\(RecognizeMode\.Multiple\)/, "continuous dictation");
  assert.match(s, /SpeechHypothesized/, "emits live partials");
  assert.match(s, /SpeechRecognized/, "emits finals");
  assert.match(s, /@@READY@@/);
  assert.match(s, /PAUSE/, "can mute the mic while the agent speaks");
  assert.match(s, /RESUME/);
  assert.match(s, /QUIT/);
  assert.match(s, /Add-Type -ReferencedAssemblies System\.Speech/, "compiles the C# host");

  assert.deepEqual(parseHostLine("@@READY@@zh-CN|MS-2052-80-DESK"), {
    kind: "ready",
    culture: "zh-CN",
  });
  assert.deepEqual(parseHostLine("@@PARTIAL@@你好"), { kind: "partial", text: "你好" });
  assert.deepEqual(parseHostLine("@@FINAL@@你好世界"), { kind: "final", text: "你好世界" });
  assert.deepEqual(parseHostLine("@@ERR@@no mic"), { kind: "error", message: "no mic" });
  assert.equal(parseHostLine("random noise"), undefined, "ignores non-protocol output");

  // Line splitting must survive chunk boundaries mid-line (a real stdout stream).
  const lines: string[] = [];
  const feed = createLineSplitter((l) => lines.push(l));
  feed("@@PARTIAL@@he");
  feed("llo\n@@FIN");
  feed("AL@@hello there\n");
  assert.deepEqual(lines, ["@@PARTIAL@@hello", "@@FINAL@@hello there"], "reassembles split lines");
}

// 7. Fallback provider -------------------------------------------------------
{
  const failing: SttProvider = {
    name: "streaming",
    async available() {
      return true;
    },
    unavailableReason() {
      return "n/a";
    },
    async listenOnce(): Promise<SttResult> {
      throw new Error("host failed to start");
    },
  };
  const backup = new ScriptedStt(["from backup", "again"]);
  const fb = new FallbackSttProvider(failing, backup);

  assert.equal(fb.name, "streaming", "starts on the primary engine");
  const first = await fb.listenOnce({});
  assert.equal(first.text, "from backup", "transparently falls back when the host fails");
  assert.equal(fb.name, "scripted", "status now reports the engine actually in use");
  const second = await fb.listenOnce({});
  assert.equal(second.text, "again", "stays on the backup (doesn't retry every turn)");
}

// 8. The mic is muted while the agent speaks (no self-transcription loop) ----
{
  const order: string[] = [];
  const stt: SttProvider = {
    name: "gated",
    async available() {
      return true;
    },
    unavailableReason() {
      return "n/a";
    },
    async listenOnce(): Promise<SttResult> {
      return { text: "" };
    },
    async pause() {
      order.push("pause");
    },
    async resume() {
      order.push("resume");
    },
  };
  const tts: TtsProvider = {
    name: "t",
    async available() {
      return true;
    },
    unavailableReason() {
      return "n/a";
    },
    async speak() {
      order.push("speak");
    },
  };
  const c = new VoiceController({ engine: { stt, tts }, speakReplies: true, timeoutSec: 5, write: () => {} });
  await c.speak("hello there");
  assert.deepEqual(order, ["pause", "speak", "resume"], "mic muted around TTS");
}

// 9. Live partials are rendered while the user is still speaking -------------
{
  const stt: SttProvider = {
    name: "streaming",
    async available() {
      return true;
    },
    unavailableReason() {
      return "n/a";
    },
    async listenOnce(opts): Promise<SttResult> {
      opts?.onPartial?.("你好");
      opts?.onPartial?.("你好世界");
      return { text: "你好世界" };
    },
  };
  const out: string[] = [];
  const c = new VoiceController({
    engine: { stt },
    speakReplies: false,
    timeoutSec: 5,
    write: (s) => out.push(s),
  });
  const heard = await c.listen();
  assert.equal(heard, "你好世界");
  const all = out.join("");
  assert.ok(all.includes("你好"), "showed the live hypothesis");
  assert.ok(all.includes("\r"), "rewrote the partial line in place");
}

process.stdout.write("test-voice: ALL PASS\n");
