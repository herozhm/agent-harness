/**
 * 权限闸门 —— harness 的刹车
 *
 * 职责:在"工具声明"之上做运行时裁决。模型无法自我提权:
 *  - readonly 模式:read 放行,write/exec 一律拒绝(拒绝原因回填,模型可转述而不执行)
 *  - confirm 模式:read 放行;write 放行;exec 需人工确认;命中危险模式的命令直接拒绝
 *  - auto 模式:全放行,仅记录
 *
 * 危险命令黑名单是"模式匹配"而非穷举 —— 演示闸门思想:
 *  生产里应换成沙箱执行(容器/临时目录 + 无网络),黑名单只是最后一道兜底。
 */

const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/, // rm -rf / rm -fr
  /\bsudo\b/,
  /\bgit\s+push\s+.*--force/,
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\//,
  /\b(shutdown|reboot)\b/,
  />\s*\/dev\/sd[a-z]/,
  /\bchmod\s+-R\s+777\s+\//,
  /\bcurl\b.*\|\s*(ba)?sh/, // 远程脚本直接执行
];

export type PermissionDecision = "allow" | "deny" | "confirm";

export interface PermissionVerdict {
  decision: PermissionDecision;
  reason: string;
}

export function checkPermission(
  permission: "read" | "write" | "exec",
  toolName: string,
  args: unknown,
  mode: "readonly" | "confirm" | "auto"
): PermissionVerdict {
  if (mode === "auto") {
    return { decision: "allow", reason: "auto mode" };
  }

  if (permission === "read") {
    return { decision: "allow", reason: "read-only tool" };
  }

  if (mode === "readonly") {
    return {
      decision: "deny",
      reason: `readonly mode: tool "${toolName}" (level=${permission}) is blocked`,
    };
  }

  // confirm 模式:write 放行,exec 检查危险模式后问人
  if (permission === "write") {
    return { decision: "allow", reason: "write tool in confirm mode" };
  }

  // exec + confirm
  const cmd = (args as { command?: string })?.command ?? "";
  for (const p of DANGEROUS_PATTERNS) {
    if (p.test(cmd)) {
      return {
        decision: "deny",
        reason: `blocked by dangerous-pattern guard: matches ${p.source}`,
      };
    }
  }
  return { decision: "confirm", reason: `exec tool requires confirmation: ${cmd.slice(0, 80)}` };
}
