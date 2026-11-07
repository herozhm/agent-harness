/**
 * 工具层 —— 注册表 + 校验 + 执行 + 结果截断
 *
 * 设计原则(README 里有对应展开):
 *  1. 入参用 zod 校验:校验失败的"错误信息"回填给模型 —— 模型靠可读的错误自我修正,
 *     而不是整个 loop 崩掉。
 *  2. 结果截断:大输出(读大文件、长命令输出)必须截断,否则一次工具调用就吃掉半个窗口。
 *  3. 工具自己不裁决权限:permission 是声明,harness 在执行前统一裁决(见 loop.ts)。
 *     职责分离 —— 工具管"能做什么",harness 管"准不准做"。
 */
import type { AgentTool, ToolContext, ToolSchema } from "./types.js";

export class ToolRegistry {
  private tools = new Map<string, AgentTool>();

  register(tool: AgentTool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`duplicate tool name: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  all(): AgentTool[] {
    return [...this.tools.values()];
  }

  /** 暴露给 LLM API 的 schema 列表(description 质量直接决定模型会不会用、用得对不对) */
  schemas(): ToolSchema[] {
    return this.all().map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        // zod -> JSON Schema:为保持零依赖,工具统一用 .describe() 的简化转换
        parameters: zodToLooseJsonSchema(t.parameters),
      },
    }));
  }

  /**
   * 执行一个工具调用:
   *  未知工具 / 参数校验失败 → 返回可读错误(回填给模型),不抛异常
   */
  async execute(
    name: string,
    rawArgs: string,
    ctx: ToolContext,
    maxResultChars: number
  ): Promise<{ ok: boolean; result: string }> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        result: `ERROR: unknown tool "${name}". Available: ${[...this.tools.keys()].join(", ")}`,
      };
    }

    let parsed: unknown;
    try {
      const json: unknown = JSON.parse(rawArgs || "{}");
      const r = tool.parameters.safeParse(json);
      if (!r.success) {
        const issues = r.error.issues
          .map((i) => `- path "${i.path.join(".") || "(root)"}": ${i.message}`)
          .join("\n");
        return {
          ok: false,
          result: `ERROR: invalid arguments for "${name}":\n${issues}\nFix the arguments and retry.`,
        };
      }
      parsed = r.data;
    } catch {
      return {
        ok: false,
        result: `ERROR: arguments for "${name}" are not valid JSON: ${rawArgs.slice(0, 200)}`,
      };
    }

    try {
      const result = await tool.execute(parsed, ctx);
      return { ok: true, result: truncate(result, maxResultChars) };
    } catch (e) {
      // 工具运行时报错同样回填:模型可以换路径/换参数重试
      return { ok: false, result: `ERROR: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}

/** 截断工具结果,并告诉模型截断发生在哪(截断要可感知,不能静默) */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head - 40;
  return (
    text.slice(0, head) +
    `\n...[truncated ${text.length - maxChars} chars, showing head+tail]...\n` +
    (tail > 0 ? text.slice(-tail) : "")
  );
}

/**
 * 极简 zod → JSON Schema(仅覆盖本仓库用到的类型:object/string/number/boolean/array/enum)
 * 说明:生产项目可直接用 zod-to-json-schema;这里保留手写版以保持零依赖、可逐行讲解。
 */
export function zodToLooseJsonSchema(z: import("zod").ZodTypeAny): Record<string, unknown> {
  const def = (z as unknown as { _def: { typeName: string; description?: string; innerType?: import("zod").ZodTypeAny; shape?: () => Record<string, import("zod").ZodTypeAny>; element?: import("zod").ZodTypeAny; values?: readonly string[] } })._def;
  const base: Record<string, unknown> = def.description ? { description: def.description } : {};

  switch (def.typeName) {
    case "ZodObject": {
      const shape = def.shape?.() ?? {};
      const props: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, v] of Object.entries(shape)) {
        props[key] = zodToLooseJsonSchema(v as import("zod").ZodTypeAny);
        const isOpt = (v as unknown as { _def?: { typeName: string } })._def?.typeName === "ZodOptional";
        if (!isOpt) required.push(key);
      }
      return { type: "object", properties: props, ...(required.length ? { required } : {}), ...base };
    }
    case "ZodString":
      return { type: "string", ...base };
    case "ZodNumber":
      return { type: "number", ...base };
    case "ZodBoolean":
      return { type: "boolean", ...base };
    case "ZodArray":
      return { type: "array", items: def.element ? zodToLooseJsonSchema(def.element) : {}, ...base };
    case "ZodEnum":
      return { type: "string", enum: def.values ?? [], ...base };
    case "ZodOptional":
      return def.innerType ? zodToLooseJsonSchema(def.innerType) : { type: "string", ...base };
    default:
      return { type: "string", ...base };
  }
}
