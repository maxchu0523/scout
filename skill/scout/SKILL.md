---
name: scout
description: >-
  Discover and use local services at runtime. Use this when the user asks you to
  do something that needs an external tool, model, or capability you don't
  natively have — e.g. "generate an image", "talk to my local model / Ollama /
  LM Studio", "summarize with a local LLM", or "use the <X> MCP tool". Scout
  scans the machine (and optionally the LAN) for connectable MCP servers and
  local AI APIs, then invokes them.
---

# Scout: find and use a local service

You have a CLI called `scout` that turns "I don't have that capability" into
"let me find something local that does." Follow this loop:

**discover → select → learn → invoke → return.**

> Requires the `scout` CLI on PATH (`npm i -g` / `npm link` in the scout repo).
> All commands emit JSON when piped, so parse stdout.

## 1. Discover

```bash
scout scan --json
```

Returns `{ services: [...] }`. Each service has a `kind`:

- `kind: "mcp"` — an MCP server. Fields: `url`, `transport`, `tools` (each with
  `name`, `description`, `inputSchema`, `annotations`), `resources`, `prompts`.
- `kind: "llm-api"` — a local AI API. Fields: `url`, `api`
  (`openai-compatible` | `ollama`), `models`.

Scan wider only if the default ports miss it: `scout scan --ports 1-10000 --json`
or a specific port `--ports 1234`. (Localhost by default; `--host <cidr>` for LAN.)

## 2. Select

Match the user's request to a service:

- **A specific capability** (image gen, web search, db query, …) → look for an
  `mcp` service whose `tools[].name`/`description` fits the request.
- **"talk to / use my local model"** → pick an `llm-api` service; choose a model
  from its `models` list (or let Scout pick the first).

If nothing matches, tell the user what you *did* find and stop — don't invent a
service.

## 3. Learn

For an MCP tool, read its `inputSchema` (a JSON Schema) to build the arguments
object. Required fields and types come straight from the schema.

## 4. Safety check (do this before every MCP call)

Look at the tool's `annotations`:

- If `readOnlyHint === true` → safe to call.
- Otherwise (or if `destructiveHint === true`, or annotations are absent) →
  **STOP. Tell the user exactly what you're about to call and with what
  arguments, and get explicit confirmation before invoking.**

Never call a write/destructive/unknown-effect tool without confirmation.

## 5. Invoke

**MCP tool:**

```bash
scout call <url> <toolName> --args '<json-args>'
```

Example (image generation):

```bash
scout call http://127.0.0.1:9000/mcp generate_image \
  --args '{"prompt":"a cyberpunk skyline mixing Hong Kong and Tokyo, neon, rain"}'
```

Add `--json` to get the raw `CallToolResult` (use it when the result references a
file path, resource, or structured data).

**Local AI model (chat):**

```bash
scout chat <url> --model <modelId> "your prompt"
# omit --model to use the first available model
```

Example:

```bash
scout chat http://127.0.0.1:1234 --model qwen/qwen3 "summarize this in 3 bullets: ..."
```

## 6. Return

Parse the command output and give the user the result (the generated content, the
model's answer, the file path it produced, etc.). If a call fails, report the
error and the command you ran so it's reproducible.

---

## Using this skill in other agents

This file is a normal Markdown skill. In Claude Code it auto-loads from
`~/.claude/skills/scout/SKILL.md` (or a project's `.claude/skills/`). For any
other agent, paste the body above into your system prompt / rules file — the
workflow and the safety rule are not Claude-specific.
