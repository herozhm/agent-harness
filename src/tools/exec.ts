/**
 * exec 工具:run_command —— 权限最高的工具,也是闸门演示的核心道具
 *
 * 安全分层(README "安全分层"一节):
 *  1. 工具层:超时 + 输出截断 + 白名单起手(只允许只读命令族)
 *  2. harness 层:permission=exec,confirm/auto 模式才可执行,危险模式黑名单兜底
 *  3. (生产建议)进程层:容器/临时 HOME/断网 —— 见 README
 *
 * 注意:这里做了"命令白名单" —— 因为 harness 的 permission 只到工具粒度,
 * 对 exec 类工具,参数级白名单是必要的纵深防御。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { AgentTool } from "../types.js";

const run = promisify(execFile);

/** 只读命令白名单:agent 可以"看",但不能用 shell 干"改"的事 */
const ALLOWED_BINARIES = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "git", "node", "npm", "npx", "tsc", "python3",
]);

export function buildExecTool(): AgentTool {
  return {
    name: "run_command",
    description:
      "Run a shell command inside the workspace (timeout 30s). Only whitelisted read/build commands are allowed " +
      "(ls, cat, head, tail, wc, grep, rg, find, git, node, npm, npx, tsc, python3). " +
      "Use for verification: run tests, type checks, grep code. Destructive commands are rejected.",
    parameters: z.object({
      command: z.string().describe("command line to run, executed inside the workspace directory"),
    }),
    permission: "exec",
    async execute(args, ctx) {
      const { command } = args as { command: string };
      const bin = command.trim().split(/\s+/)[0];
      if (!ALLOWED_BINARIES.has(bin)) {
        throw new Error(
          `command "${bin}" is not whitelisted. Allowed: ${[...ALLOWED_BINARIES].join(", ")}. ` +
            `This tool is for verification/inspection only.`
        );
      }
      try {
        const { stdout, stderr } = await run(bin, command.trim().split(/\s+/).slice(1), {
          cwd: ctx.cwd,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          shell: false,
        });
        const parts = [
          stdout && `STDOUT:\n${stdout}`,
          stderr && `STDERR:\n${stderr}`,
        ].filter(Boolean);
        return parts.join("\n") || "(no output, exit 0)";
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
        // 非 0 退出码是"信息"不是"故障":完整回填,模型据此修正
        const body = [err.stdout, err.stderr].filter(Boolean).join("\n") || "(no output)";
        const head = `EXIT ${err.code ?? "?"}${err.killed ? " (timeout)" : ""}\n${body}`;
        throw new Error(head.slice(0, 4000));
      }
    },
  };
}
