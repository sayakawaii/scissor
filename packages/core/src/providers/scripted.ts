/**
 * A provider that replays a fixed list of assistant turns instead of calling a
 * model.
 *
 * Every `scripts/test-*.mts` already hand-rolls a variant of this to drive the
 * agent loop deterministically; this is that pattern made reusable, so the
 * replay demo and the tests share one implementation with one guarantee:
 *
 *   **It never performs I/O of any kind.** No network, no credentials, no
 *   config. `chat()` is a pure lookup into the script.
 *
 * Replacing only the model leaves the rest of the system genuinely running —
 * the agent loop, tools, edit engine, guardrails and shell all execute for
 * real. That makes a scripted run an honest demonstration of everything except
 * the model's reasoning, which is exactly how it must be labelled.
 */
import type { ChatParams, ChatResult, LLMProvider, ProviderId } from "../types.js";

export interface ScriptedProviderOptions {
  /** Turns to replay, in order. */
  script: ChatResult[];
  /**
   * Provider id to report. The agent uses it only for token-estimation ratios;
   * a scripted run is not that provider and must not be presented as one.
   */
  id?: ProviderId;
  /** Model label to report. Defaults to a name that cannot be mistaken for real. */
  model?: string;
}

/** Text returned once the script is spent, so the agent loop terminates cleanly. */
export const SCRIPT_EXHAUSTED_TEXT =
  "(scripted replay finished: no further recorded turns)";

export class ScriptedProvider implements LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  private readonly script: ChatResult[];
  private index = 0;
  /** Params of each `chat()` call, so a test can assert what the agent asked. */
  readonly calls: ChatParams[] = [];

  constructor(opts: ScriptedProviderOptions) {
    this.script = opts.script;
    this.id = opts.id ?? "deepseek";
    this.model = opts.model ?? "scripted-replay";
  }

  /** How many scripted turns have been consumed. */
  get turnsUsed(): number {
    return this.index;
  }

  /** How many turns the script holds in total. */
  get turnCount(): number {
    return this.script.length;
  }

  /** True once every scripted turn has been handed out. */
  get exhausted(): boolean {
    return this.index >= this.script.length;
  }

  async chat(params: ChatParams): Promise<ChatResult> {
    this.calls.push(params);
    const next = this.script[this.index];
    this.index++;
    // Running past the end is not an error: the agent may take one more turn
    // than scripted (e.g. after a verification retry). Ending the turn with
    // plain text stops the loop instead of hanging or throwing.
    if (!next) return { text: SCRIPT_EXHAUSTED_TEXT, toolCalls: [] };
    return next;
  }
}
