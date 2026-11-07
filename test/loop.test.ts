/**
 * 端到端测试:全部用 MockProvider 驱动 —— 不需要 API key,CI 里零外部依赖。
 *
 * 覆盖 harness 的四个关键行为:
 *  1. happy path:explore → write → verify → 完成
 *  2. 权限闸门:readonly 模式下写操作被拒,拒绝原因回填给模型
 *  3. 预算熔断:completion token 超限 → loop 终止(不死循环)
 *  4. 错误回填:工具报错不崩 loop,模型拿到可读错误后自我修正
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/loop.js";
import { MockProvider, type MockStep } from "../src/llm.js";
import { buildFsTools } from "../src/tools/fs.js";
import { buildExecTool } from "../src/tools/exec.js";
import { checkPermission } from "../src/permissions.js";
import { estimateTokens } from "../src/context.js";
import type { LoopConfig } from "../src/types.js";

function makeCfg(over: Partial<LoopConfig>): LoopConfig {
  return {
    provider: new MockProvider([]),
    tools: [...buildFsTools(), buildExecTool()],
    systemPrompt: "test system prompt",
    task: "test task",
    maxTurns: 10,
    maxCompletionTokens: 100000,
    maxToolResultChars: 5000,
    permissionMode: "auto",
    cwd: mkdtempSync(join(tmpdir(), "harness-test-")),
    ...over,
  };
}

test("happy path: mock 脚本驱动完整闭环,文件真实落盘", async () => {
  const script: MockStep[] = [
    { toolCalls: [{ name: "list_dir", args: { path: "." } }] },
    { toolCalls: [{ name: "write_file", args: { path: "notes/a.txt", content: "hello harness" } }] },
    { toolCalls: [{ name: "read_file", args: { path: "notes/a.txt" } }] },
    { content: "created and verified notes/a.txt" },
  ];
  const cfg = makeCfg({ provider: new MockProvider(script) });
  const result = await runAgent(cfg);

  assert.equal(result.status, "completed");
  assert.equal(result.turns, 4);
  assert.match(result.answer!, /created and verified/);
  assert.equal(readFileSync(join(cfg.cwd, "notes/a.txt"), "utf-8"), "hello harness");
  // token 累计来自 mock usage
  assert.ok(result.totalPromptTokens > 0 && result.totalCompletionTokens > 0);
});

test("readonly 闸门:write 被拒且拒绝原因回填,loop 不崩", async () => {
  const script: MockStep[] = [
    { toolCalls: [{ name: "write_file", args: { path: "x.txt", content: "nope" } }] },
    { content: "understood, readonly mode — I will only explain" },
  ];
  const cfg = makeCfg({ provider: new MockProvider(script), permissionMode: "readonly" });
  const result = await runAgent(cfg);

  assert.equal(result.status, "completed");
  assert.ok(!existsSync(join(cfg.cwd, "x.txt")), "readonly 模式下文件不应被创建");
  assert.equal(result.turns, 2);
});

test("预算熔断:completion 超限 → budget_exceeded,不死循环", async () => {
  const script: MockStep[] = [
    { toolCalls: [{ name: "list_dir", args: { path: "." } }], usage: { completionTokens: 900 } },
    { toolCalls: [{ name: "list_dir", args: { path: "." } }], usage: { completionTokens: 900 } },
    { toolCalls: [{ name: "list_dir", args: { path: "." } }], usage: { completionTokens: 900 } },
  ];
  const cfg = makeCfg({ provider: new MockProvider(script), maxCompletionTokens: 2000, maxTurns: 50 });
  const result = await runAgent(cfg);

  assert.equal(result.status, "budget_exceeded");
  // 3 次 LLM 调用累计 2700 > 2000:第 4 轮入口处熔断,未发起第 4 次调用
  assert.equal(result.turns, 4);
});

test("错误回填:read 不存在的文件报 ERROR,loop 继续到完成", async () => {
  const script: MockStep[] = [
    { toolCalls: [{ name: "read_file", args: { path: "ghost.txt" } }] },
    { content: "file missing; adapting plan" },
  ];
  const cfg = makeCfg({ provider: new MockProvider(script) });
  const result = await runAgent(cfg);

  assert.equal(result.status, "completed");
  assert.match(result.answer!, /adapting/);
});

test("权限函数:危险命令黑名单直接 deny,exec 在 confirm 模式要求确认", () => {
  const denied = checkPermission("exec", "run_command", { command: "sudo rm -rf /" }, "confirm");
  assert.equal(denied.decision, "deny");

  const confirmed = checkPermission("exec", "run_command", { command: "node --version" }, "confirm");
  assert.equal(confirmed.decision, "confirm");

  const readonlyDenied = checkPermission("write", "write_file", { path: "a" }, "readonly");
  assert.equal(readonlyDenied.decision, "deny");

  const autoAllowed = checkPermission("exec", "run_command", { command: "whatever" }, "auto");
  assert.equal(autoAllowed.decision, "allow");
});

test("token 估算:中文与英文按字符近似", () => {
  const messages = [
    { role: "user" as const, content: "abcdefgh" }, // 8 chars -> 2 tokens
  ];
  assert.equal(estimateTokens(messages), 2);
});
