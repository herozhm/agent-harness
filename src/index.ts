/** 公共 API:作为库被其他项目引用(如给现有应用嵌一个 agent 运行时) */
export { runAgent, makeTerminalConfirm } from "./loop.js";
export { ToolRegistry, truncate, zodToLooseJsonSchema } from "./tools.js";
export { ContextWindow, estimateTokens } from "./context.js";
export { checkPermission } from "./permissions.js";
export { TraceRecorder } from "./trace.js";
export { OpenAICompatibleProvider, MockProvider, type MockStep } from "./llm.js";
export { buildFsTools } from "./tools/fs.js";
export { buildExecTool } from "./tools/exec.js";
export type {
  AgentTool,
  ChatMessage,
  LLMProvider,
  LLMResponse,
  LoopConfig,
  LoopResult,
  ToolCallRequest,
  ToolContext,
  ToolSchema,
  TraceEvent,
} from "./types.js";
