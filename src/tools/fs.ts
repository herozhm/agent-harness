/**
 * 内置文件工具:read_file / write_file / list_dir
 *
 * 路径安全:所有路径解析到 cwd 内 —— 绝对路径越界直接拒绝。
 * 这是工具层的"沙箱边界"演示:agent 的手要被关在笼子里。
 */
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import { z } from "zod";
import type { AgentTool } from "../types.js";

function assertInsideCwd(cwd: string, p: string): string {
  const full = isAbsolute(p) ? p : resolve(cwd, p);
  const rel = relative(cwd, full);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes workspace: "${p}" (cwd=${cwd})`);
  }
  return full;
}

export function buildFsTools(): AgentTool[] {
  return [
    {
      name: "read_file",
      description:
        "Read a text file inside the workspace and return its content. " +
        "Path is relative to the workspace root (or absolute inside it). Use this to inspect existing files before editing.",
      parameters: z.object({ path: z.string().describe("file path relative to workspace root") }),
      permission: "read",
      async execute(args, ctx) {
        const full = assertInsideCwd(ctx.cwd, (args as { path: string }).path);
        const info = await stat(full);
        if (info.isDirectory()) throw new Error(`${args && (args as { path: string }).path} is a directory, use list_dir`);
        return readFile(full, "utf-8");
      },
    },
    {
      name: "write_file",
      description:
        "Create or overwrite a text file inside the workspace with the given content. " +
        "Parent directories are created automatically. Always read the file first if it may already exist.",
      parameters: z.object({
        path: z.string().describe("file path relative to workspace root"),
        content: z.string().describe("full file content to write"),
      }),
      permission: "write",
      async execute(args, ctx) {
        const { path, content } = args as { path: string; content: string };
        const full = assertInsideCwd(ctx.cwd, path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content, "utf-8");
        return `OK: wrote ${content.length} chars to ${path}`;
      },
    },
    {
      name: "list_dir",
      description:
        "List files and directories under a path inside the workspace (non-recursive). " +
        "Returns entries with type (dir/file) and size. Use to explore the workspace structure.",
      parameters: z.object({
        path: z.string().optional().describe("directory path, default '.'"),
      }),
      permission: "read",
      async execute(args, ctx) {
        const p = (args as { path?: string }).path ?? ".";
        const full = assertInsideCwd(ctx.cwd, p);
        const entries = await readdir(full, { withFileTypes: true });
        if (entries.length === 0) return `(empty directory: ${p})`;
        const lines: string[] = [];
        for (const e of entries) {
          const info = await stat(join(full, e.name));
          lines.push(`${e.isDirectory() ? "DIR " : "file"}  ${e.name}${e.isDirectory() ? "/" : `  (${info.size}B)`}`);
        }
        return lines.join("\n");
      },
    },
  ];
}

export { assertInsideCwd };
