# agent-harness

A minimal, framework-free **agent harness**: the runtime skeleton that turns a stateless LLM into an agent that can act.

> The model is the engine. The harness is the whole car — loop, tools, memory, brakes, mirrors.

Most agent tutorials start at "call the API". This repo starts one level below: **what does it actually take to run a model as an agent?** Everything here is hand-built (the only runtime dependency is `zod`) so that every design decision is visible, explainable, and testable.

## Why a harness

An LLM alone is a stateless function: tokens in, tokens out. To act as an agent it needs five things it doesn't have:

| The model lacks | The harness provides | Where in this repo |
|---|---|---|
| Can only emit text | Tool layer (files, commands) | `src/tools.ts`, `src/tools/` |
| No memory across turns | Context management + compaction | `src/context.ts` |
| One conversation, then done | The main loop | `src/loop.ts` |
| Will hallucinate & misbehave | Permission gates + dangerous-command guard | `src/permissions.ts` |
| A black box on failure | Full per-turn trace (JSONL) | `src/trace.ts` |

## Architecture

```
┌─────────────────────────────────────────────┐
│ CLI (src/cli.ts)                            │
│   --mock (keyless) / real LLM / --readonly  │
├─────────────────────────────────────────────┤
│ Agent Loop (src/loop.ts)                    │
│   context → provider → parse                │
│     ├─ tool_calls → permission → execute    │
│     │                → refill result        │
│     └─ text      → done                    │
├──────────┬──────────┬───────────┬───────────┤
│ Context  │ Tools    │ Perms     │ Trace     │
│ window + │ zod      │ 3-mode    │ JSONL     │
│ compact  │ validate │ + denylist│ per-turn  │
├──────────┴──────────┴───────────┴───────────┤
│ Provider (src/llm.ts)                       │
│   OpenAI-compatible │ Mock (script replay)  │
└─────────────────────────────────────────────┘
```

## Four iron laws (each enforced in code)

1. **Tool errors are refilled, never fatal** — the model self-corrects from readable error messages (`src/tools.ts` returns `ERROR: ...` strings instead of throwing).
2. **Permission is decided before execution; the model cannot elevate itself** — tool declares a level, harness adjudicates (`src/loop.ts` → `checkPermission`). A denial reason is fed back so the model adapts instead of getting stuck.
3. **Termination is multi-layered** — task completion, `maxTurns`, and a completion-token budget breaker. The harness *assumes* the model can loop forever.
4. **Compact before overflow, not after** — context is checked against a token watermark each turn; old tool results are compacted to markers while decisions (assistant text) are preserved (`src/context.ts`).

## Quick start

```bash
npm install
npm run demo        # keyless mock demo: full explore → create → verify → summarize loop
npm test            # 6 e2e tests, all mock-driven, no API key needed
```

Mock demo runs the entire loop with a scripted model, writes real files into `workspace/`, and persists a per-turn trace to `.trace/trace.jsonl` — so CI needs zero secrets.

### With a real model (any OpenAI-compatible endpoint)

```bash
export HARNESS_BASE_URL=https://api.deepseek.com/v1   # or Qwen/Kimi/OpenAI
export HARNESS_API_KEY=sk-...
export HARNESS_MODEL=deepseek-chat
npm run demo:llm

# permission demo: writes are refused by the gate, refusal reason is fed to the model
npm run build && node dist/src/cli.js --readonly
```

## Design decisions (the "why" behind each choice)

| Decision | Why |
|---|---|
| Zero framework, `zod` only | A harness you can't read line-by-line is a harness you can't debug. Also: the two things frameworks don't give you — context strategy and guardrails — are exactly the interesting parts, so they're built here, by hand. |
| `MockProvider` as a first-class citizen | The model is a replaceable dependency. Script replay makes the loop testable end-to-end without any API key — this is what "testability" means for agent systems. |
| OpenAI-compatible message format | One wire format covers DeepSeek/Qwen/Kimi/GPT; no adapter layer to maintain. |
| Deterministic compaction (no LLM summarization) | Summary-style compaction makes the harness itself depend on a model — bad for determinism, cost, and tests. Compaction strategy is an injectable function; production can swap in LLM summaries (see roadmap). |
| Whitelist for exec + denylist for patterns | Permission gates at tool granularity aren't enough for exec tools; argument-level whitelisting is defense-in-depth. The denylist is a last resort — real isolation should be sandboxing (roadmap). |
| Per-turn JSONL trace, append-as-it-happens | If the process dies mid-run you still keep every turn that completed. Debugging agents without traces is guessing. |

## The three permission modes

| Mode | read | write | exec |
|---|---|---|---|
| `auto` | allow | allow | allow |
| `readonly` | allow | **deny** (reason fed back) | **deny** |
| `confirm` | allow | allow | denylist → **ask human** |

## Roadmap (what production would add)

- **Plan mode**: model emits a plan, human approves, then execute — plan as an approval artifact
- **Sub-agents**: dispatch isolated-context child runs, return summaries (context isolation, at the cost of handoff quality)
- **Checkpoint/resume**: persist `messages` + loop state; long tasks survive restarts
- **Sandboxed exec**: container or temp-HOME + no network, replacing the denylist
- **LLM-summary compaction**: swap-in strategy behind the same interface
- **Structured verification**: post-task verifier that runs tests/lints and reports pass/fail as a gate

## Repo layout

```
src/
  types.ts        # vocabulary: messages, tools, config, trace events
  llm.ts          # provider abstraction: OpenAI-compatible + Mock (script replay)
  loop.ts         # THE LOOP: turn machine + permission adjudication + budget breaker
  context.ts      # message window + token watermark + compaction
  tools.ts        # registry: zod validation, error refill, result truncation
  permissions.ts  # 3-mode gate + dangerous-pattern denylist
  trace.ts        # JSONL per-turn observability
  index.ts        # public API (embed as a library)
  tools/fs.ts     # read_file / write_file / list_dir (workspace-jailed)
  tools/exec.ts   # run_command (whitelist + timeout)
  cli.ts          # entry: --mock / real LLM / --readonly / --task
test/loop.test.ts # 6 e2e tests, mock-driven, keyless
```

## License

MIT
