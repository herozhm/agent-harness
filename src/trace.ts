/**
 * 可观测层 —— 每轮事件落盘,可回放调试
 *
 * 没有_trace 的 agent 出了问题只能靠猜。这里把每一轮的
 * LLM 响应、工具调用、权限裁决、压缩事件全部记录,
 * 结束时写 JSON 文件 —— 面试演示时打开这个文件讲"出了问题怎么查"。
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoopResult, TraceEvent } from "./types.js";

export class TraceRecorder {
  private events: TraceEvent[] = [];
  private startedAt = Date.now();

  constructor(private outDir?: string) {
    if (outDir) mkdirSync(outDir, { recursive: true });
  }

  record(e: TraceEvent): void {
    this.events.push(e);
    if (this.outDir) {
      // 逐条追加,进程崩溃也能留下已发生的部分
      appendFileSync(join(this.outDir, "trace.jsonl"), JSON.stringify({ ts: Date.now(), ...e }) + "\n");
    }
  }

  /** 结束时输出汇总文件(人类可读的结构化结果) */
  finalize(result: LoopResult): string | null {
    if (!this.outDir) return null;
    const file = join(this.outDir, "trace.jsonl");
    const summary = join(this.outDir, "summary.json");
    writeFileSync(
      summary,
      JSON.stringify(
        {
          startedAt: new Date(this.startedAt).toISOString(),
          durationMs: Date.now() - this.startedAt,
          result,
          eventCount: this.events.length,
        },
        null,
        2
      )
    );
    return file;
  }
}
