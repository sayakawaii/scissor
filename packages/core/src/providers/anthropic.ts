import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  Tool as AnthropicTool,
} from "@anthropic-ai/sdk/resources/messages";
import type {
  ChatParams,
  ChatResult,
  LLMProvider,
  Message,
  ProviderId,
  Tool,
  ToolCall,
} from "../types.js";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  maxTokens?: number;
}

/** Provider implementation for Anthropic's Messages API (Claude). */
export class AnthropicProvider implements LLMProvider {
  readonly id: ProviderId = "claude";
  readonly model: string;
  private client: Anthropic;
  private maxTokens: number;

  constructor(opts: AnthropicOptions) {
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 4096;
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL });
  }

  async chat(params: ChatParams): Promise<ChatResult> {
    const { system, messages } = toAnthropicMessages(params.messages);
    const tools = params.tools?.length
      ? params.tools.map(toAnthropicTool)
      : undefined;

    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: this.maxTokens,
        system,
        messages,
        tools,
      },
      { signal: params.signal },
    );

    let text = "";
    // Accumulate tool_use blocks keyed by content-block index.
    const toolAcc = new Map<number, { id: string; name: string; json: string }>();

    stream.on("text", (delta) => {
      text += delta;
      params.callbacks?.onText?.(delta);
    });

    stream.on("contentBlock", () => {
      /* handled below via final message for robustness */
    });

    const final = await stream.finalMessage();

    for (const block of final.content) {
      if (block.type === "tool_use") {
        toolAcc.set(toolAcc.size, {
          id: block.id,
          name: block.name,
          json: JSON.stringify(block.input ?? {}),
        });
      }
    }

    const toolCalls: ToolCall[] = [...toolAcc.values()].map((acc) => ({
      id: acc.id,
      name: acc.name,
      arguments: safeParse(acc.json),
    }));

    return {
      text,
      toolCalls,
      usage: {
        promptTokens: final.usage.input_tokens,
        completionTokens: final.usage.output_tokens,
        totalTokens: final.usage.input_tokens + final.usage.output_tokens,
      },
      finishReason: final.stop_reason ?? undefined,
    };
  }
}

function toAnthropicTool(tool: Tool): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as unknown as AnthropicTool["input_schema"],
  };
}

/**
 * Convert scissor's flat message list into Anthropic's format:
 * system prompt is separate, and tool results are user-message content blocks.
 */
function toAnthropicMessages(msgs: Message[]): {
  system: string | undefined;
  messages: MessageParam[];
} {
  const systemParts: string[] = [];
  const messages: MessageParam[] = [];

  for (const msg of msgs) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
      continue;
    }
    if (msg.role === "user") {
      messages.push({ role: "user", content: msg.content });
      continue;
    }
    if (msg.role === "tool") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.toolCallId ?? "",
            content: msg.content,
          },
        ],
      });
      continue;
    }
    if (msg.role === "assistant") {
      const content: MessageParam["content"] = [];
      if (msg.content && msg.content.length > 0) {
        content.push({ type: "text", text: msg.content });
      }
      if (msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.arguments ?? {},
          });
        }
      }
      messages.push({
        role: "assistant",
        content: content.length > 0 ? content : msg.content,
      });
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages,
  };
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
