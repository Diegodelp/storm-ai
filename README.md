# Storm-ai

**Context-aware project scaffolding for AI coding agents.**

Storm is a CLI that creates and maintains projects designed to work well
with Claude Code (and similar AI coding agents). Its core idea is the
**compact-context tree**: instead of dumping a giant `CLAUDE.md` for the
AI to parse on every turn, storm keeps a lightweight index (`project-map.md`)
that points to per-branch summaries. The agent loads only the branches
relevant to the current task.

```
.context-compact/
├── project-map.md        # always loaded
├── src-auth.md           # loaded only when working on auth
├── src-ui.md             # loaded only when working on UI
└── task-state.json       # source of truth for tasks
```

## Status

**v0.1.0 — MVP.** The core and CLI work; the interactive UI is in place.
Proactive file watcher, plugin system, and non-JS/TS language support are
planned for v0.2+.

## Install

```bash
npm install -g @belotti/storm-ai
# or
pnpm add -g @belotti/storm-ai
```

Requires Node.js 20 or later.

## Quick start

```bash
# Create a new project interactively
storm

# Or go straight to the wizard
storm new

# Or fully non-interactive
storm new my-app --description "A CRM" --stack "Next.js + Prisma"
```

On first run, storm offers to install Ollama (skippable). After creating
a project, storm launches Claude Code automatically with the provider
you picked in the wizard.

### Providers

Storm routes Claude Code through one of three providers:

- **Ollama cloud** (default) — free models hosted by Ollama:
  `kimi-k2.6:cloud`, `glm-5:cloud`, `qwen3.5:cloud`, etc. No API key needed.
- **Ollama local** — models running on your machine via `ollama pull`.
  Recommended: `glm-4.7-flash`, `qwen3-coder:30b`.
- **Claude API** — Anthropic's Claude directly. Needs `ANTHROPIC_API_KEY`.

The selection is stored per-project in `project.config.json`. To switch,
edit that file and run `storm launch` again.

Once inside a project:

```bash
storm task add "Implement login" --branch src/auth
storm task start T-001
# ... do the work ...
storm task done T-001

storm refresh        # regenerate .context-compact/
storm branch list
storm branch pin src/auth index.ts middleware.ts
```

## Philosophy

1. **Determinism.** The same code produces the same compact-context. No
   LLMs in the generation pipeline — no diff noise in git.
2. **Thin source of truth.** Tasks live in `task-state.json`. `TASKS.md`
   is regenerated from it. You never edit the MD directly.
3. **Append-only notes.** The `## Notes` section of each branch file is
   preserved across refreshes. Architectural decisions survive regeneration.
4. **Opt-in, not opt-out.** Branches are declared explicitly. No magic
   auto-detection. You know what's indexed.

## Architecture

- `src/core/` — pure logic, no UI. `parser`, `tasks`, `compact`, `config`, `paths`.
- `src/commands/` — command orchestration. Pure functions.
- `src/cli.js` — commander-based router (direct mode).
- `src/ui/` — interactive wizards using `@clack/prompts`.
- `bin/storm.js` — entry point.
- `legacy/` — the original PowerShell prototype (bugfix-only).

## Ranking heuristic

When a branch has many files, `project-map.md` shows only the top N.
The ranking is deterministic and uses four signals:

1. **Fan-in** — how many other project files import this one.
2. **Barrel** — `index.{js,ts,jsx,tsx}` gets a flat boost.
3. **Export count** — more public exports = more central.
4. **Task activity** — branches with active tasks surface higher.

Users can override with `pinned` in `project.config.json`:

```json
{
  "compact_context": {
    "branches": [
      { "path": "src/auth", "pinned": ["index.ts", "middleware.ts"] }
    ]
  }
}
```

## Development

```bash
git clone https://github.com/belotti/storm-ai
cd storm-ai
pnpm install
node --test test/
```

## Roadmap

- **v0.2** — Proactive file watcher (integrated, not daemon). Plugin
  architecture. Ollama fallback for ranking in huge projects.
- **v0.3** — Python + Go parsing. Multi-project view. `storm sync` to
  pull the compact context across machines.

## License

MIT © Diego Belotti
