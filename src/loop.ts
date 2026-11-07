/**
 * Agent Loop —— harness 的心脏
 *
 * 结构(对应 README 架构图):
 *   组装上下文 → 调 provider → 解析响应
 *     ├─ 有 tool_calls → 权限裁决 → 校验执行 → 结果回填 → 下一轮
 *     └─ 纯文本 → 任务完成,返回
 *
 * 四条铁律(每条都有代码位置):
 *  1. 工具报错也回填 —— 模型靠可读错误自我修正,loop 不因单点失败而崩(ToolRegistry.execute)
 *  2. 权限裁决在执行前,模型无法自我提权(checkPermission)
 *  3. 终止条件多重:完成 / maxTurns / token 预算熔断 —— 必须假设模型会死循环
 *  4. 每轮结束做上下文水位检查,压缩发生在"超限前"而不是"爆掉后"
 */
import { ContextWindow, estimateTokens } from "./context.js";
import { checkPermission } from "./permissions.js";
import { ToolRegistry } from "./tools.js";
import type { ChatMessage, LoopConfig, LoopResult } from "./types.js";
import { TraceRecorder } from "./trace.js";

export async function runAgent(cfg: LoopConfig, trace?: TraceRecorder): Promise<LoopResult> {
  const registry = new ToolRegistry();
  for (const t of cfg.tools) registry.register(t);

  const ctxWindow = new ContextWindow();
  const confirm = cfg.confirmFn; // confirm 模式下的人工确认:由入口(CLI/测试)注入

  const messages: ChatMessage[] = [
    { role: "system", content: cfg.systemPrompt },
    { role: "user", content: cfg.task },
  ];

  const result: LoopResult = {
    status: "max_turns",
    answer: null,
    turns: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
  };

  for (let turn = 1; turn <= cfg.maxTurns; turn++) {
    result.turns = turn;
    trace?.record({ t: "turn_start", turn });

    // ---- 预算熔断:completion token 超限直接停(必须假设模型可能停不下来) ----
    if (result.totalCompletionTokens >= cfg.maxCompletionTokens) {
      result.status = "budget_exceeded";
      trace?.record({ t: "loop_end", status: result.status, turns: turn });
      break;
    }

    // ---- 上下文水位检查:超限先压缩,再调用 ----
    if (ctxWindow.maybeCompact()) {
      trace?.record({
        t: "compaction",
        turn,
        messagesBefore: messages.length,
        messagesAfter: messages.length,
      });
    }

    const providerMessages = messages;
    let resp;
    try {
      resp = await cfg.provider.chat(providerMessages, registry.schemas());
    } catch (e) {
      // provider 报错不静默吞掉:作为 tool 结果回填太 late,这里直接终止并说明
      result.status = "blocked";
      result.answer = `LLM provider failed: ${e instanceof Error ? e.message : String(e)}`;
      trace?.record({ t: "loop_end", status: result.status, turns: turn });
      break;
    }

    result.totalPromptTokens += resp.usage.promptTokens;
    result.totalCompletionTokens += resp.usage.completionTokens;

    trace?.record({
      t: "llm_response",
      turn,
      content: resp.content?.slice(0, 200) ?? null,
      toolCalls: resp.toolCalls.map((c) => c.function.name),
      usage: resp.usage,
    });

    // ---- 分支 1:纯文本 → 完成 ----
    if (resp.toolCalls.length === 0) {
      result.status = "completed";
      result.answer = resp.content;
      trace?.record({ t: "loop_end", status: "completed", turns: turn });
      break;
    }

    // ---- 分支 2:工具调用 → 裁决 → 执行 → 回填 ----
    messages.push({
      role: "assistant",
      content: resp.content,
      tool_calls: resp.toolCalls,
    });

    for (const call of resp.toolCalls) {
      const tool = registry.get(call.function.name);
      const permission = tool?.permission ?? "exec";
      let args: unknown;
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        args = {};
      }

      // 权限裁决:在执行之前,deny 时把原因回填给模型(它可改道,而不是卡死)
      const verdict = checkPermission(permission, call.function.name, args, cfg.permissionMode);
      trace?.record({ t: "permission", turn, tool: call.function.name, decision: verdict.decision });

      if (verdict.decision === "deny") {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: `PERMISSION DENIED: ${verdict.reason}. You cannot perform this action; adapt your plan (explain instead of execute, or use an allowed tool).`,
        });
        continue;
      }

      if (verdict.decision === "confirm") {
        const ok = confirm
          ? await confirm(verdict.reason)
          : false;
        if (!ok) {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.function.name,
            content: "USER DECLINED. Do not retry the same call; adjust your approach.",
          });
          continue;
        }
      }

      trace?.record({ t: "tool_call", turn, tool: call.function.name, args });

      // 执行 + 结果回填(错误也回填 —— 铁律 1)
      const { result: toolResult } = await registry.execute(
        call.function.name,
        call.function.arguments,
        { cwd: cfg.cwd, confirm: async () => true },
        cfg.maxToolResultChars
      );
      trace?.record({
        t: "tool_result",
        turn,
        tool: call.function.name,
        truncatedChars: toolResult.length,
        error: toolResult.startsWith("ERROR") ? toolResult.slice(0, 120) : undefined,
      });

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: toolResult,
      });
    }

    trace?.record({ t: "turn_end", turn });
  }

  if (result.status === "max_turns") {
    trace?.record({ t: "loop_end", status: "max_turns", turns: result.turns });
  }
  return result;
}

/** 供 CLI 注入的人工确认函数(terminal y/n) */
export function makeTerminalConfirm(): (question: string) => Promise<boolean> {
  // 延迟 import readline,保持 loop 纯净可测
  return async (question: string) => {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const ans = await rl.question(`\n⚠️  ${question}\n   Allow? [y/N] `);
      return ans.trim().toLowerCase() === "y";
    } finally {
      rl.close();
    }
  };
}

/** 导出给测试断言用 */
export { estimateTokens };
