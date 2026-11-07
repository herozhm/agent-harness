/**
 * LLM 接入层 —— provider 抽象
 *
 * 两个实现:
 *  - OpenAICompatibleProvider:任何 OpenAI 兼容端点(DeepSeek/Qwen/Kimi/GPT),
 *    用全局 fetch 直调,不引 SDK —— 协议就一个 POST,引库反而看不清。
 *  - MockProvider:按脚本回放模型行为。测试和演示不需要 API key,
 *    CI 里全程闭环 —— 这体现 harness 的"可测试性":模型是可替换的。
 */
import type {
  ChatMessage,
  LLMProvider,
  LLMResponse,
  ToolCallRequest,
  ToolSchema,
} from "./types.js";

export interface OpenAIConfig {
  baseURL: string; // 如 https://api.deepseek.com/v1
  apiKey: string;
  model: string;
}

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private cfg: OpenAIConfig) {}

  async chat(messages: ChatMessage[], tools: ToolSchema[]): Promise<LLMResponse> {
    const res = await fetch(`${this.cfg.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LLM API ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      choices: { message: { content: string | null; tool_calls?: ToolCallRequest[] } }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const msg = data.choices[0]?.message;
    return {
      content: msg?.content ?? null,
      toolCalls: msg?.tool_calls ?? [],
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }
}

/** Mock 脚本的一步:一段文本、一次工具调用、或混合 */
export interface MockStep {
  content?: string | null;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  usage?: Partial<LLMResponse["usage"]>;
}

export class MockProvider implements LLMProvider {
  private idx = 0;
  constructor(private script: MockStep[]) {}

  async chat(_messages: ChatMessage[], _tools: ToolSchema[]): Promise<LLMResponse> {
    if (this.idx >= this.script.length) {
      // 脚本耗尽:返回完成信号(防止测试里的 loop 死循环)
      return {
        content: "[mock] script exhausted — task treated as complete.",
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 5 },
      };
    }
    const step = this.script[this.idx++];
    return {
      content: step.content ?? null,
      toolCalls: (step.toolCalls ?? []).map((tc, i) => ({
        id: `mock_call_${this.idx}_${i}`,
        type: "function" as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
      usage: {
        promptTokens: step.usage?.promptTokens ?? 100,
        completionTokens: step.usage?.completionTokens ?? 20,
      },
    };
  }
}
