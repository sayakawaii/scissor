# Voice mode (`/voice`) — talk to scissor

Have a spoken conversation with scissor: speak your turn into the microphone,
scissor transcribes it, runs as your prompt, and (optionally) reads its reply
back aloud. Useful for hands-free use and for practice scenarios — e.g. **letting
scissor play an interviewer** and drilling you out loud.

Voice is a UI-layer feature (all code lives in `packages/cli/src/voice/`); the
engine (`packages/core`) is untouched and stays UI-agnostic.

## What's implemented

- **Default engine: local Windows speech (offline, no API key, no extra deps).**
  - STT → `System.Speech.Recognition` (the engine behind Windows dictation).
  - TTS → `System.Speech.Synthesis` (SAPI, always present on Windows).
- **Streaming-ish and low latency.** The recognizer starts **once per session**
  (~3s) and then stays running in continuous dictation mode, so each turn begins
  instantly and partial text appears on screen while you're still speaking.
  (The old design constructed an engine per turn, which is where the multi-second
  lag came from.) The mic is automatically muted while the agent talks, so it
  never transcribes its own voice back as your next turn.
- **Automatic fallback:** if the persistent host can't start (locked-down
  machine, no audio device), scissor silently falls back to the simpler
  spawn-per-turn engine. `/voice status` shows which one is actually live.
- **Off Windows / other engines:** `voice.stt: "openai"` is reserved but not yet
  implemented; on non-Windows the command degrades gracefully to typed input with
  a clear message.

## Windows setup (one-time)

1. Install a **speech language pack** (this is the "voice pack" download):
   Settings → *Time & Language* → *Speech* → add a language for speech
   recognition. English (`en-US`) works out of the box on most installs.
2. Make sure a microphone is set as the default input device.
3. That's it — no API keys, nothing leaves your machine.

Check it's wired up from inside scissor:

```
/voice status
```

You should see `stt=windows(ready) tts=windows`.

## Commands

| Command               | Effect                                                          |
| --------------------- | --------------------------------------------------------------- |
| `/voice`              | Start a **continuous** spoken conversation (auto-listens).      |
| `/voice once`         | Speak a **single** turn, then back to typing.                   |
| `/voice off`          | Leave continuous mode. (Or just **say** "stop".)                |
| `/voice lang <loc>`   | Switch recognition language, e.g. `/voice lang zh-CN`.          |
| `/voice say <txt>`    | Speak `<txt>` aloud — quick test that TTS works.                |
| `/voice status`       | Show engines, current language, and **installed** languages.    |

In continuous mode, saying **"stop" / "exit voice" / "cancel"** ends it. `Ctrl-C`
interrupts the current turn as usual.

## Speaking a language other than English

**This is the most common gotcha.** If you don't set a language, recognition uses
the machine's *default* recognizer — usually `en-US`. Speaking Mandarin into the
English model doesn't fail loudly; it returns confident nonsense (a stream of
unrelated English words). Fix it with:

```
/voice lang zh-CN
```

or persist it as `voice.locale` in the config below. `/voice status` lists the
languages actually installed, and scissor now tells you which model decoded your
audio — and warns when it isn't the one you asked for.

If your language isn't listed, install its speech pack: Settings → *Time &
Language* → *Speech* → *Add a language for speech recognition*.

## Config (`~/.scissor/config.json`)

```json
{
  "voice": {
    "enabled": true,
    "stt": "auto",
    "tts": "auto",
    "locale": "en-US",
    "speakReplies": true,
    "listenTimeoutSec": 10
  }
}
```

- `stt`: `"auto"` (persistent streaming engine on Windows, falling back to
  spawn-per-turn), `"windows-stream"` (force streaming), `"windows"` (force the
  simple engine), `"openai"` (reserved), `"none"`.
- `tts`: `"auto"` / `"windows"` / `"none"` (don't speak replies).
- `locale`: BCP-47 tag, e.g. `"en-US"`, `"zh-CN"`. Needs the matching speech
  language pack installed for recognition.
- `speakReplies`: read the agent's replies aloud (code blocks are skipped, long
  answers are trimmed for listenability).
- `listenTimeoutSec`: how long to wait for you to start speaking before skipping.

## Interview-practice pattern (no extra setup)

The "mock interviewer" use case works with the continuous loop plus an opening
instruction:

```
/voice
```

then say:

> "Act as a senior backend interviewer. Ask me one question at a time, wait for
> my spoken answer, then give brief feedback and ask the next one."

scissor asks a question (spoken via TTS), you answer out loud, it critiques and
continues — a fully spoken loop. Say "stop" to end.

## Manual smoke test (needs a real mic — can't run in CI)

The deterministic suite (`scripts/test-voice.mts`) covers provider selection,
the PowerShell script shape, markdown-to-speech cleanup, and the controller state
machine against a scripted engine. The actual microphone + `System.Speech` path
must be verified by hand on Windows:

```bash
# 1. TTS only — should hear the sentence:
scissor        # then in the REPL:
/voice say hello, this is scissor speaking

# 2. One spoken turn:
/voice once
# (speak: "create a file called notes.txt with the text hello")

# 3. Continuous interview loop:
/voice
# (speak: "act as an interviewer and ask me one question at a time")
# ... answer out loud; say "stop" to end.

# 4. Non-English:
/voice lang zh-CN
/voice
```

To check the persistent recognition host on its own (proves the C# helper
compiles, the recognizer loads, and the mic opens — then prints what it hears):

```bash
node --import tsx scripts/smoke-voice-host.mts zh-CN 8
```

If `/voice status` shows `stt=windows(unavailable)`, install a speech language
pack (see setup above).
