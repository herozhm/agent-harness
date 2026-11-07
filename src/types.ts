/**
 * 核心类型定义 —— harness 的"词汇表"
 *
 * 消息结构刻意与 OpenAI chat completions 对齐(业内事实标准),
 * 这样接入任何 OpenAI 兼容端点(DeepSeek/Qwen/Kimi/GPT)都不需要转换层。
 */

/** 角色与消息(OpenAI 兼容格式) */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** assistant 消息携带的工具调用请求 */
  tool_calls?: ToolCallRequest[];
  /** role=tool 时:本次结果对应的 tool_call id */
  tool_call_id?: string;
  /** role=tool 时:工具名(部分端点要求) */
  name?: string;
}

/** 模型发出的工具调用请求 */
export interface ToolCallRequest {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** 暴露给模型的工具 schema(透传给 API 的 tools 字段) */
export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** LLM 的一次补全结果 */
export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCallRequest[];
  usage: { promptTokens: number; completionTokens: number };
}

/** LLM provider 抽象:mock 与 openai-compatible 都实现它 */
export interface LLMProvider {
  chat(messages: ChatMessage[], tools: ToolSchema[]): Promise<LLMResponse>;
}

/** 一个 agent 工具 = schema + zod 校验器 + 执行函数 + 权限级别 */
export interface AgentTool {
  name: string;
  description: string;
  /** zod schema:入参校验(校验失败的信息会回填给模型自我修正) */
  parameters: import("zod").ZodTypeAny;
  /** 权限级别:模型无法自我提权,由 harness 在执行前裁决 */
  permission: "read" | "write" | "exec";
  execute(args: unknown, ctx: ToolContext): Promise<string>;
}

/** 工具执行上下文:harness 注入,工具自身不感知全局状态 */
export interface ToolContext {
  /** 当前工作目录(文件类工具的路径基准) */
  cwd: string;
  /** 需要人工确认时,由 harness 注入的确认函数(CLI 实现=终端问答) */
  confirm: (question: string) => Promise<boolean>;
}

/** 主循环配置 */
export interface LoopConfig {
  provider: LLMProvider;
  tools: AgentTool[];
  /** 注入到每轮的系统提示 */
  systemPrompt: string;
  /** 任务描述(作为首条 user 消息) */
  task: string;
  maxTurns: number;
  /** 预算:累计 completion token 上限,超出熔断 */
  maxCompletionTokens: number;
  /** 工具结果超过该字符数则截断(防止单次结果撑爆上下文) */
  maxToolResultChars: number;
  /** 权限模式:readonly=拒写 / confirm=敏感操作问人 / auto=全放行 */
  permissionMode: "readonly" | "confirm" | "auto";
  /** confirm 模式下的人工确认函数(CLI 注入终端问答;测试注入恒真/恒假) */
  confirmFn?: (question: string) => Promise<boolean>;
  cwd: string;
}

/** 循环结果 */
export interface LoopResult {
  status: "completed" | "max_turns" | "budget_exceeded" | "blocked";
  answer: string | null;
  turns: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

/** 可观测:每一轮的事件流(写 JSON 文件,可回放调试) */
export type TraceEvent =
  | { t: "turn_start"; turn: number }
  | { t: "llm_response"; turn: number; content: string | null; toolCalls: string[]; usage: LLMResponse["usage"] }
  | { t: "tool_call"; turn: number; tool: string; args: unknown }
  | { t: "tool_result"; turn: number; tool: string; truncatedChars: number; error?: string }
  | { t: "permission"; turn: number; tool: string; decision: "allow" | "deny" | "confirm" }
  | { t: "compaction"; turn: number; messagesBefore: number; messagesAfter: number }
  | { t: "turn_end"; turn: number }
  | { t: "loop_end"; status: LoopResult["status"]; turns: number };
