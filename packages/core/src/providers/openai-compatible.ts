import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type {
  ChatParams,
  ChatResult,
  LLMProvider,
  Message,
  ProviderId,
  Tool,
  ToolCall,
} from "../types.js";
import { safeParseJsonObject } from "./util.js";

export interface OpenAICompatibleOptions {
  id: ProviderId;
  apiKey: string;
  model: string;
  baseURL?: string;
}

/**
 * Provider implementation for any OpenAI Chat Completions-compatible API.
 * Used for OpenAI GPT, DeepSeek, and GLM (Zhipu) via different base URLs.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  private client: OpenAI;

  constructor(opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.model = opts.model;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
    });
  }

  async chat(params: ChatParams): Promise<ChatResult> {
    const messages = params.messages.map(toOpenAIMessage);
    const tools = params.tools?.length ? params.tools.map(toOpenAITool) : undefined;

    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages,
        tools,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: params.signal },
    );

    let text = "";
    let finishReason: string | undefined;
    let usage: ChatResult["usage"];
    // Accumulate streamed tool-call fragments keyed by their index.
    const toolAcc = new Map<
      number,
      { id: string; name: string; args: string }
    >();

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;

      const delta = choice?.delta;
      if (delta?.content) {
        text += delta.content;
        params.callbacks?.onText?.(delta.content);
      }
      // Some providers (deepseek-reasoner) stream reasoning separately.
      const reasoning = (delta as { reasoning_content?: string } | undefined)
        ?.reasoning_content;
      if (reasoning) params.callbacks?.onReasoning?.(reasoning);

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const existing =
            toolAcc.get(idx) ?? { id: "", name: "", args: "" };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.args += tc.function.arguments;
          toolAcc.set(idx, existing);
        }
      }

      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        };
      }
    }

    const toolCalls: ToolCall[] = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, acc]) => ({
        id: acc.id || `call_${idx}`,
        name: acc.name,
        arguments: safeParseJsonObject(acc.args),
      }))
      .filter((c) => c.name.length > 0);

    return { text, toolCalls, usage, finishReason };
  }
}

function toOpenAITool(tool: Tool): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as unknown as Record<string, unknown>,
    },
  };
}

function toOpenAIMessage(msg: Message): ChatCompletionMessageParam {
  switch (msg.role) {
    case "system":
      return { role: "system", content: msg.content };
    case "user":
      return { role: "user", content: msg.content };
    case "tool":
      return {
        role: "tool",
        content: msg.content,
        tool_call_id: msg.toolCallId ?? "",
      };
    case "assistant": {
      const base: ChatCompletionMessageParam = {
        role: "assistant",
        content: msg.content || null,
      };
      if (msg.toolCalls?.length) {
        (base as { tool_calls?: unknown }).tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments ?? {}),
          },
        }));
      }
      return base;
    }
    default:
      return { role: "user", content: msg.content };
  }
}
