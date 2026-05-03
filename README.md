# storm-ai

**Context-aware project scaffolding for AI coding agents.**

Storm is a CLI that creates and maintains projects designed to work well with
LLM coding agents like Claude Code or OpenCode. Its core idea is the
**compact-context tree**: instead of dumping a giant `CLAUDE.md` for the AI
to parse on every turn, storm keeps a lightweight index (`project-map.md`)
that points to per-branch summaries. The agent loads only the branches
relevant to the current task.

```
.context-compact/
├── project-map.md        # always loaded — high-level index
├── src-auth.md           # loaded only when working on auth
├── src-ui.md             # loaded only when working on UI
└── task-state.json       # source of truth for tasks
```

## Install

```bash
npm install -g storm-ai
# or
pnpm add -g storm-ai
```

Requires Node.js 20+.

## Quick start

```bash
# Interactive menu (recommended for first time)
storm

# Create a new project from scratch
storm new

# Import an existing project (analyzes it with an LLM)
storm import "C:\path\to\my-project"

# List available templates
storm templates list
```

On first run, storm offers to install Ollama, git, and your chosen agent
CLI (skippable). It uses the official installers for each platform — on
Windows that means `irm https://ollama.com/install.ps1 | iex` for Ollama,
`irm https://claude.ai/install.ps1 | iex` for Claude Code, and
`winget install Git.Git` for git.

## Usage modes

Storm has two execution modes:

**Interactive** — running `storm` (or any subcommand without flags) opens
a wizard. Best for first-time use, exploration, and human-driven workflows.
Press `Esc` at any time to go back, or pick "← Volver" from any menu.

**Non-interactive (flag-driven)** — for CI, automation, or use from
another LLM agent. Every wizard has a flag-driven equivalent. For example:

```bash
storm import "/path/to/project" \
  --yes \
  --provider via-opencode \
  --agent opencode \
  --stack nextjs-pages \
  --name "My Project" \
  --branch pages/api/admin \
  --skip-llm
```

Storm auto-detects when stdin/stdout aren't a TTY and switches to
non-interactive mode automatically. `--yes` is required to confirm
overwrites in non-interactive mode.

## Concepts

### Provider vs Agent

Storm separates two concerns that are often conflated:

- **Provider** — *where the LLM lives*. Used by `storm import` to analyze
  your project, and by `storm launch` to route the coding agent.
- **Agent** — *which CLI you actually run* in your terminal day-to-day.

You can mix and match. Storm currently supports five providers:

| Provider | What it is | When to use it |
|---|---|---|
| `ollama-cloud` | Free hosted models via Ollama | Default. Free, no API keys, decent quality. |
| `ollama-local` | Models on your machine via `ollama pull` | Offline, private, you control the hardware. |
| `claude` | Anthropic API directly | You have an `ANTHROPIC_API_KEY` and want maximum quality. |
| `via-claude-code` | Delegates to the `claude` CLI you have installed | You already use Claude Code; let storm reuse its config. |
| `via-opencode` | Delegates to the `opencode` CLI | You have OpenCode set up (e.g. with your ChatGPT Pro auth, Anthropic, Gemini). Storm reuses whatever model OpenCode is configured for. |

The `via-*` providers are powerful: they let you avoid configuring API
keys in storm at all. If you've already authenticated OpenCode against
ChatGPT (via web auth), you can use that quota for storm's project
analysis just by selecting `--provider via-opencode`.

And two coding agents:

- **Claude Code** — `claude` CLI from Anthropic. Storm scaffolds `CLAUDE.md`
  and `.claude/commands/` with built-in slash commands (`/task-add`,
  `/task-done`, `/refresh-compact`, etc.).
- **OpenCode** — `opencode` CLI. Storm scaffolds `.opencode/AGENTS.md`
  with the same project conventions but written for OpenCode's format.
  No `.claude/` directory is created.

For other agents (Aider, Cursor CLI, custom scripts), set a `customCommand`
in your config with `{{model}}` as the placeholder:

```bash
storm config set launchCommand 'aider --model {{model}} --no-auto-commits'
```

### Compact-context tree

After importing or creating a project, storm produces:

```
your-project/
├── project.config.json                  # storm's source of truth
├── CLAUDE.md  OR  .opencode/AGENTS.md   # depends on chosen agent
├── TASKS.md                              # generated, don't edit manually
├── .context-compact/
│   ├── project-map.md                    # always loaded (~500 LOC)
│   ├── pages.md                          # per-branch summary
│   ├── pages-api.md
│   ├── components.md
│   └── task-state.json
└── .claude/                              # only if agent=claude-code
    ├── commands/                         # slash commands
    ├── skills/                           # custom and built-in skills
    └── agents/                           # named sub-agents
```

The agent reads `project-map.md` (always fits in context) and the specific
`.context-compact/<branch>.md` files relevant to the current task. Source
files are only opened when the summaries aren't enough.

## Configuration

Storm has two config layers:

**Per-project** — `<project>/project.config.json`. Source of truth for
that project: stack, branches, tasks, model, agent, custom launch command.
Edit by hand or via storm commands.

**Global** — `~/.storm-ai/config.json`. Machine-wide defaults for the
wizards.

```json
{
  "defaultProvider": {
    "provider": "via-opencode",
    "model": null
  },
  "defaultAgent": "opencode",
  "defaultLaunchCommand": null,
  "ollamaHost": "http://127.0.0.1:11434"
}
```

### Editing global config

```bash
# Interactive wizard
storm config

# Scripted
storm config get                                 # print all
storm config get provider                        # print one key
storm config set provider via-opencode
storm config set agent opencode
storm config set launchCommand 'ollama launch opencode --model {{model}}'
storm config set ollamaHost http://my-server:11434
storm config unset launchCommand                 # clear a key
storm config path                                # print the file path
```

Valid keys: `provider`, `model`, `agent`, `launchCommand`, `ollamaHost`.

The wizard also offers to verify and install Claude Code or OpenCode if
they're not already on your PATH.

## Day-to-day commands

Once inside a storm project:

```bash
# Tasks
storm task add "Implement login" --branch pages/api/auth
storm task start T-001
storm task note T-001 "JWT in httpOnly cookie, refresh via /api/auth/refresh"
storm task done T-001               # auto-runs storm sync

# Branches (compact-context segments)
storm branch list
storm branch add pages/api/admin "Admin endpoints"
storm branch pin src/auth index.ts middleware.ts
storm branch unpin src/auth middleware.ts
storm branch remove old-feature     # also deletes the .md file

# Compact context
storm refresh                       # regenerate .context-compact/
storm sync                          # detect new branches in filesystem
storm sync --no-regenerate          # update config but don't rebuild .md files

# Skills
storm skill add code-reviewer "Reviews PRs for security issues"
storm skill list
storm skill remove code-reviewer

# Agent launch
storm open                          # list storm projects, pick one
storm open my-app                   # launch the configured agent there
storm open my-app --print           # only print the path (for shell snippets)
storm launch                        # launch in the current dir
```

### Debugging parse failures

When you see a warning like `5 file(s) failed to parse (exports may be
missing)`, set `STORM_DEBUG=1` to see the full list with each error:

```bash
# Linux/macOS
STORM_DEBUG=1 storm refresh

# Windows PowerShell
$env:STORM_DEBUG = "1"
storm refresh
Remove-Item env:STORM_DEBUG
```

Useful for finding out why an LLM is reporting "no exports" on files that
do export things — usually a parser plugin issue (most commonly TypeScript
with non-standard syntax, or framework-specific JSX dialects).

## Templates

Storm can scaffold projects from templates hosted in the registry:

```bash
storm templates list                    # all available templates
storm templates show <name>             # template metadata
storm new --from-template nextjs-saas   # use template
```

The registry lives at:
`https://raw.githubusercontent.com/Diegodelp/storm-ai/main/templates/registry.json`

To author a new template, see [TEMPLATE_AUTHORING.md](TEMPLATE_AUTHORING.md).

## Importing existing projects

`storm import` analyzes an existing project with an LLM, then writes the
storm scaffolding (config, compact context, agent instructions) without
modifying your source code.

```bash
# Interactive wizard
storm import "C:\Users\me\Desktop\my-project"

# Non-interactive — pick provider, agent, stack, branches explicitly
storm import "C:\Users\me\Desktop\my-project" \
  --yes \
  --provider via-opencode \
  --agent opencode \
  --stack nextjs-pages \
  --branch pages \
  --branch pages/api \
  --branch pages/api/admin \
  --branch components \
  --branch styles

# Skip the LLM analysis entirely (use defaults + stack preset)
storm import "/path/to/project" --yes --skip-llm --stack nextjs-pages
```

After import, storm runs `sync` automatically to pick up any branches the
LLM missed (e.g. nested directories like `pages/api/admin`).

### Sensitive files are never indexed

By default, storm excludes the following from any indexing or LLM input:

- **Secrets**: `.env*`, `*.pem`, `*.key`, `*.cert`, `*.crt`,
  `credentials.json`, `service-account.json`, `secrets/`, `.secrets`,
  `.aws`, `.ssh`
- **Build output**: `node_modules`, `.git`, `dist`, `build`, `.next`,
  `.turbo`, `.cache`, `.parcel-cache`, `.svelte-kit`, `out`, `coverage`,
  `.nyc_output`
- **Editor noise**: `.idea`, `.vscode`, `.DS_Store`

You can override or extend this in `project.config.json`:

```json
{
  "compact_context": {
    "ignored_paths": [".git", "node_modules", "*.tmp", "scratch/"]
  }
}
```

Patterns with `*` match basenames (e.g. `*.pem` matches `key.pem` anywhere
in the tree). Plain names match both files and directories.

## Philosophy

1. **Determinism.** The same code produces the same compact-context. No
   LLMs in the generation pipeline → no diff noise in git.
2. **Thin source of truth.** Tasks live in `task-state.json`. `TASKS.md`
   is regenerated from it. You never edit the MD directly.
3. **Append-only notes.** The `## Notes` section of each branch file is
   preserved across refreshes. Architectural decisions survive
   regeneration.
4. **Opt-in, not opt-out.** Branches are declared explicitly. Storm
   suggests during import, but you confirm. No silent magic.
5. **Bring your own LLM.** Storm doesn't ship API keys. The `via-*`
   providers let you reuse whatever you already pay for (ChatGPT Pro,
   Anthropic credits, Gemini API, local Ollama).

## Architecture

```
src/
├── cli.js                # commander-based router
├── core/
│   ├── analyze.js         # project structure scanner
│   ├── compact.js         # .context-compact/ generator
│   ├── config.js          # project.config.json I/O & validation
│   ├── global-config.js   # ~/.storm-ai/config.json
│   ├── llm-client.js      # 5 providers including via-claude-code, via-opencode
│   ├── parser.js          # AST parser (Babel) for JS/TS/JSX/TSX
│   ├── parse-analysis.js  # tolerant JSON parsing for LLM output
│   ├── paths.js           # path utilities, project root detection
│   ├── providers.js       # PROVIDERS catalog (canonical list)
│   ├── stacks.js          # stack presets (Next.js, Astro, etc.)
│   ├── tasks.js           # task state, TASKS.md regeneration
│   ├── templates.js       # template registry & application
│   ├── version.js         # reads version from package.json at runtime
│   └── walk.js            # filesystem walker with .gitignore support
├── commands/
│   ├── branch.js          # storm branch add/remove/pin/unpin/list
│   ├── config.js          # storm config get/set/unset/path
│   ├── import.js          # storm import (interactive + non-interactive)
│   ├── new.js             # storm new (interactive + non-interactive)
│   ├── open.js, launch.js # storm open, storm launch
│   ├── refresh.js         # storm refresh
│   ├── skill.js           # storm skill add/remove/list
│   ├── sync.js            # storm sync
│   ├── task.js            # storm task add/start/note/done/list
│   └── templates.js       # storm templates list/show
├── ui/
│   ├── ansi.js            # ANSI color utilities
│   ├── first-run.js       # first-run check (Node, npm, git, Ollama)
│   ├── layout.js          # terminal layout helpers
│   ├── logo.js            # storm logo (sharp + ASCII fallback)
│   ├── menu.js            # main interactive menu
│   ├── picker.js          # custom select component
│   └── wizard-*.js        # one wizard per command
└── assets/
    └── logo.png
```

## Ranking heuristic

When a branch has many files, `project-map.md` shows only the top N. The
ranking is deterministic and uses four signals:

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
git clone https://github.com/Diegodelp/storm-ai
cd storm-ai
pnpm install
node --test test/*.test.js
```

The test suite covers parser, compact-context generation, task state,
sync logic, walker, providers, templates, and command orchestration.
~12 tests are skipped on Windows because they depend on `process.env.HOME`
semantics.

### Project conventions

- ESM-only. No CommonJS.
- JSDoc instead of TypeScript (the LLM-readable annotations stay in source).
- Pure functions in `core/`. Side effects only in `commands/` and `ui/`.
- No prompts, no console output in `core/` modules.

## Troubleshooting

**`storm --version` says an old version after upgrading.**
The bin folder cached. Try:

```bash
npm uninstall -g storm-ai
npm cache clean --force
npm install -g storm-ai@latest
```

**`storm import` fails with "TTY initialization failed".**
You're in a non-interactive environment (CI, agent subprocess). Use the
flag-driven mode with `--yes` and any required flags. See "Usage modes"
above.

**`storm refresh` reports "N file(s) failed to parse".**
Set `STORM_DEBUG=1` to see the full list with each error message. Most
common cause: parser plugin issue — file the issue and we'll add the
plugin.

**`storm launch` fails with "requires a model name".**
Your `project.config.json` has the model in the wrong shape. Storm
auto-migrates legacy `{provider, model}` to `{provider, name}` on read,
so just running any storm command should fix it. If it persists, edit
the file by hand.

**Provider says "X no está instalado o no está en el PATH".**
You picked `via-claude-code` or `via-opencode` but the corresponding CLI
isn't installed. Run `storm config` → "Instalar/verificar agent" or
install manually.

## License

MIT © Diego Belotti

## Links

- npm: https://www.npmjs.com/package/storm-ai
- GitHub: https://github.com/Diegodelp/storm-ai
- Issues: https://github.com/Diegodelp/storm-ai/issues
