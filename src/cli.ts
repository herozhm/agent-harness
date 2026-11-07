/**
 * CLI 入口
 *
 * 三种用法:
 *   npm run demo        --mock:回放脚本驱动完整 loop(不需要任何 API key)
 *   npm run demo:llm    真模型:读环境变量 HARNESS_BASE_URL / HARNESS_API_KEY / HARNESS_MODEL
 *                       (任何 OpenAI 兼容端点:DeepSeek/Qwen/Kimi/GPT)
 *   node dist/cli.js --readonly   权限演示:写操作全部被闸门拦截
 *
 * 默认任务:在 ./workspace 里"创建一个 TODO 应用的最小文件结构并自检" ——
 * 一个完整的 plan → act → verify 闭环,能展示六件套的每一样。
 */
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { OpenAICompatibleProvider, MockProvider, type MockStep } from "./llm.js";
import { runAgent, makeTerminalConfirm } from "./loop.js";
import { TraceRecorder } from "./trace.js";
import { buildFsTools } from "./tools/fs.js";
import { buildExecTool } from "./tools/exec.js";
import type { LoopConfig } from "./types.js";

const DEFAULT_TASK = [
  "Create a minimal TODO app scaffold in this workspace:",
  "1. Explore the directory first (list_dir).",
  "2. Create index.html, app.js, style.css with a simple working TODO list (add/complete/delete).",
  "3. Verify your work: list the directory again and read back app.js to confirm content.",
  "4. Reply with a short summary of what you created.",
].join(" ");

const SYSTEM_PROMPT = [
  "You are a coding agent running inside a minimal agent harness.",
  "Rules:",
  "- Use the provided tools; paths are relative to the workspace root and cannot escape it.",
  "- Plan briefly, act with tools, then VERIFY (re-read files / list dir) before claiming success.",
  "- If a tool returns an ERROR, read the message, fix the arguments, and retry — do not give up on the first error.",
  "- Finish with a plain text summary (no tool calls) once the task is verified.",
].join("\n");

/** mock 演示脚本:一次完整的 explore → create → verify → summarize */
const MOCK_SCRIPT: MockStep[] = [
  { toolCalls: [{ name: "list_dir", args: { path: "." } }], content: null, usage: { promptTokens: 320, completionTokens: 18 } },
  {
    toolCalls: [
      { name: "write_file", args: { path: "index.html", content: "<!doctype html>\n<html><head><link rel=\"stylesheet\" href=\"style.css\"></head>\n<body><h1>TODO</h1><input id=\"t\"/><button onclick=\"add()\">add</button><ul id=\"list\"></ul><script src=\"app.js\"></script></body></html>" } },
      { name: "write_file", args: { path: "app.js", content: "const list = document.getElementById('list');\nfunction add(){\n  const t = document.getElementById('t');\n  if (!t.value.trim()) return;\n  const li = document.createElement('li');\n  li.textContent = t.value;\n  li.onclick = () => li.classList.toggle('done');\n  const del = document.createElement('button');\n  del.textContent = 'x';\n  del.onclick = (e) => { e.stopPropagation(); li.remove(); };\n  li.appendChild(del);\n  list.appendChild(li);\n  t.value = '';\n}" } },
      { name: "write_file", args: { path: "style.css", content: "body{font-family:sans-serif;max-width:480px;margin:40px auto}\nli.done{text-decoration:line-through;opacity:.5}\nli button{margin-left:8px}" } },
    ],
    usage: { promptTokens: 800, completionTokens: 420 },
  },
  { toolCalls: [{ name: "list_dir", args: { path: "." } }], usage: { promptTokens: 1600, completionTokens: 15 } },
  { toolCalls: [{ name: "read_file", args: { path: "app.js" } }], usage: { promptTokens: 1700, completionTokens: 12 } },
  {
    content:
      "Done. Created 3 files: index.html (UI shell), app.js (add/complete/delete logic), style.css (styles). " +
      "Verified by listing the directory and reading back app.js — content confirmed.",
    usage: { promptTokens: 1900, completionTokens: 60 },
  },
];

function parseArgs(argv: string[]) {
  const mode = argv.includes("--readonly") ? "readonly" : argv.includes("--confirm") ? "confirm" : "auto";
  const mock = argv.includes("--mock");
  const taskIdx = argv.indexOf("--task");
  const task = taskIdx >= 0 ? argv[taskIdx + 1] : DEFAULT_TASK;
  return { mode: mode as LoopConfig["permissionMode"], mock, task };
}

async function main() {
  const { mode, mock, task } = parseArgs(process.argv.slice(2));
  const cwd = resolve(process.cwd(), "workspace");
  mkdirSync(cwd, { recursive: true });

  const provider = mock
    ? new MockProvider(MOCK_SCRIPT)
    : new OpenAICompatibleProvider({
        baseURL: process.env.HARNESS_BASE_URL ?? "https://api.deepseek.com/v1",
        apiKey: process.env.HARNESS_API_KEY ?? "",
        model: process.env.HARNESS_MODEL ?? "deepseek-chat",
      });

  if (!mock && !process.env.HARNESS_API_KEY) {
    console.error("Missing HARNESS_API_KEY. Set it (any OpenAI-compatible endpoint), or run `npm run demo` for keyless mock mode.");
    process.exit(1);
  }

  const trace = new TraceRecorder(resolve(cwd, "../.trace"));

  const cfg: LoopConfig = {
    provider,
    tools: [...buildFsTools(), buildExecTool()],
    systemPrompt: SYSTEM_PROMPT,
    task,
    maxTurns: 24,
    maxCompletionTokens: 8000,
    maxToolResultChars: 6000,
    permissionMode: mode,
    confirmFn: mode === "confirm" ? makeTerminalConfirm() : undefined,
    cwd,
  };

  console.log(`▶ agent-harness | mode=${mode} | provider=${mock ? "mock" : process.env.HARNESS_MODEL ?? "deepseek-chat"}`);
  console.log(`▶ workspace: ${cwd}\n`);

  const t0 = Date.now();
  const result = await runAgent(cfg, trace);

  console.log(`\n■ status=${result.status} turns=${result.turns} ` +
    `prompt=${result.totalPromptTokens}tok completion=${result.totalCompletionTokens}tok ` +
    `wall=${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (result.answer) console.log(`\n${result.answer}`);
  console.log(`\ntrace: ${trace.finalize(result) ?? "(not persisted)"}`);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
