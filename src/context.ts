/**
 * 上下文管理层 —— harness 里最重要的工程
 *
 * 职责:
 *  1. 维护消息历史(追加是常态,但增长必须被管理)
 *  2. 预算检查:估算 token,超过水位线触发压缩
 *  3. 压缩(compaction):把较老轮次的"工具结果"替换为短摘要标记,
 *     保留决策链(assistant 文本) —— 工具原始输出用完即弃,结论必须留下。
 *
 * 说明:这里用的是确定性压缩(截断旧工具结果),不额外调一次 LLM 做摘要 ——
 * 摘要式压缩生产上更好,但会让"harness 自身"依赖模型,演示与测试都复杂;
 * 策略做成了可替换函数,README 里有"生产化建议"一节。
 */
import type { ChatMessage } from "./types.js";

/** token 估算:粗略 1 token ≈ 4 字符(中英混合场景偏保守,仅用于水位判断,不用于计费) */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content?.length ?? 0;
    for (const tc of m.tool_calls ?? []) chars += tc.function.arguments.length + tc.function.name.length;
  }
  return Math.ceil(chars / 4);
}

export class ContextWindow {
  /** 触发压缩的 token 水位线 */
  constructor(
    private messages: ChatMessage[] = [],
    private compactThresholdTokens = 24000,
    /** 压缩时保留最近 N 条消息不压缩 */
    private keepRecentMessages = 8
  ) {}

  all(): ChatMessage[] {
    return this.messages;
  }

  /** 把一条 assistant(含 tool_calls)与其对应的多条 tool 结果一次性入列 */
  push(...msgs: ChatMessage[]): void {
    this.messages.push(...msgs);
  }

  /** 预算检查 + 压缩;返回是否发生了压缩 */
  maybeCompact(): boolean {
    if (estimateTokens(this.messages) < this.compactThresholdTokens) return false;

    // 压缩目标:keepRecentMessages 之前的消息里,role=tool 的结果替换为标记
    const cutoff = Math.max(0, this.messages.length - this.keepRecentMessages);
    let compacted = 0;
    for (let i = 0; i < cutoff; i++) {
      const m = this.messages[i];
      if (m.role === "tool" && (m.content?.length ?? 0) > 200) {
        this.messages[i] = {
          ...m,
          content: `[compacted: tool result (${m.content!.length} chars) removed; conclusion preserved in later assistant turns]`,
        };
        compacted++;
      }
      // 很老的 assistant 文本也截短,保留"决策"不保留"复述"
      if (m.role === "assistant" && m.content && i < cutoff - 4 && m.content.length > 1000) {
        this.messages[i] = { ...m, content: m.content.slice(0, 500) + "…[compacted]" };
      }
    }
    return compacted > 0;
  }

  /** 导出完整历史(用于 trace 回放/调试) */
  dump(): ChatMessage[] {
    return JSON.parse(JSON.stringify(this.messages));
  }
}
