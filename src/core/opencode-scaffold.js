/**
 * OpenCode scaffolding renderers.
 *
 * When `agent=opencode` is selected, storm writes:
 *
 *   .opencode/AGENTS.md       — main entry point, what OpenCode reads first.
 *   .opencode/commands/<n>.md — per-command knowledge base.
 *   .opencode/agents/<n>.md   — per-role knowledge base.
 *
 * Important: these files are NOT executed by OpenCode the way
 * `.claude/commands/` are by Claude Code. OpenCode doesn't currently
 * implement project-local slash commands. So we treat these as a
 * **knowledge base** the LLM (operating through OpenCode) can read
 * when the user asks it to do task management with storm.
 *
 * To make this discoverable, AGENTS.md (the file OpenCode does read
 * automatically) ends with a section listing the commands and agents
 * defined here, with one-line summaries pointing to the detail file.
 */

// ---------------------------------------------------------------------------
// Built-in commands the LLM should know about
// ---------------------------------------------------------------------------

/**
 * Each entry produces one file at `.opencode/commands/<id>.md`.
 *
 * @typedef {Object} OpenCodeCommandSpec
 * @property {string} id          Slug for the filename (e.g. "task-add").
 * @property {string} title       Human-readable title shown at the top.
 * @property {string} summary     One-line summary used in AGENTS.md index.
 * @property {string} body        Full markdown content (what to do, examples).
 */

/** @type {OpenCodeCommandSpec[]} */
export const BUILTIN_OPENCODE_COMMANDS = [
  {
    id: 'task-add',
    title: 'Crear una tarea (task add)',
    summary: 'Cómo crear una tarea nueva con storm task add y enlazarla a una branch.',
    body: `# Crear una tarea

When the user describes work that should be tracked as a task — a feature,
a bugfix, a refactor — create it via the storm CLI. **Do not edit
\`TASKS.md\` directly.** It is regenerated from \`.context-compact/task-state.json\`
and any manual edits will be lost on the next refresh.

## Comando

\`\`\`bash
storm task add "<title>" --branch <branch-path>
\`\`\`

You can pass \`--branch\` multiple times if the task spans more than one
branch. Each \`<branch-path>\` must already exist in
\`project.config.json\` (otherwise storm will reject it). Use
\`storm branch list\` to see what's declared.

## Ejemplos

\`\`\`bash
# Tarea simple en una branch
storm task add "Fix login redirect on iOS" --branch pages/api/auth

# Tarea cross-branch
storm task add "Refactor product card" \\
  --branch components \\
  --branch pages/products

# Tarea con descripción larga
storm task add "Add dark mode toggle" --branch components/theme
\`\`\`

## Output

Storm prints the assigned task ID (\`T-001\`, \`T-002\`, etc.) and creates
an entry in \`task-state.json\`. \`TASKS.md\` is regenerated automatically.

## Cuándo NO crear una tarea

- Trivial fixes that take less than 5 minutes (typo, lint warning).
- Exploratory work where the user is just asking questions.
- Code review feedback that is being addressed inline.

If the task spawns follow-up work mid-implementation, create the
follow-up as a separate task with \`storm task add\` so it doesn't
get forgotten.
`,
  },
  {
    id: 'task-start',
    title: 'Iniciar una tarea (task start)',
    summary: 'Marcá una tarea como en progreso antes de empezar a trabajar.',
    body: `# Iniciar una tarea

Before you start working on a task, mark it as in_progress. This makes
the project state visible to anyone (or any other agent) inspecting
\`TASKS.md\`, and it bumps the task's recency score so the relevant
branches surface higher in \`project-map.md\`.

## Comando

\`\`\`bash
storm task start <task-id>
\`\`\`

## Ejemplo

\`\`\`bash
storm task start T-003
\`\`\`

## Workflow recomendado

1. \`storm task start T-XXX\`
2. Read the relevant \`.context-compact/<branch>.md\` files for that task.
   Find them via the \`branches\` field in \`task-state.json\`.
3. Open source files only when the compact summaries aren't enough.
4. Make your changes.
5. Add notes about decisions: \`storm task note T-XXX "..."\`.
6. When done, run \`storm task done T-XXX\`.
`,
  },
  {
    id: 'task-done',
    title: 'Cerrar una tarea (task done)',
    summary: 'Marcá una tarea completada. Storm corre sync automático.',
    body: `# Cerrar una tarea

When the work is finished, run:

\`\`\`bash
storm task done <task-id>
\`\`\`

Storm will:

1. Update \`task-state.json\` (status: done, finishedAt: now).
2. Regenerate \`TASKS.md\`.
3. Run \`storm sync\` automatically — this scans the filesystem for any
   new directories that match the project's stack patterns and
   registers them as branches if missing.
4. Regenerate \`.context-compact/\` so the new branches show up in
   \`project-map.md\` immediately.

After every 5 \`task done\` calls, storm reminds the user to run
\`storm refresh\` for a full reindex (it doesn't do it automatically
because that's heavier than a sync).

## Comando

\`\`\`bash
storm task done T-003
\`\`\`

## Cuándo es apropiado

- All acceptance criteria for the task are met.
- Code is committed (or the user has explicitly asked you to mark it
  done before a commit — in which case warn them).
- No follow-up tasks are blocked on this one.

If you discover follow-up work mid-task, **don't lump it into this
task**. Create a new one with \`storm task add\` and mention it in the
done note.
`,
  },
  {
    id: 'task-note',
    title: 'Anotar una tarea (task note)',
    summary: 'Append una nota a una tarea (decisiones, blockers, follow-ups).',
    body: `# Anotar una tarea

Use task notes to record decisions, blockers, design choices, or
follow-up work that should not be lost. Notes are append-only and
visible in \`TASKS.md\` under the task entry.

## Comando

\`\`\`bash
storm task note <task-id> "<text>"
\`\`\`

## Ejemplos

\`\`\`bash
# Decisión técnica
storm task note T-003 "JWT in httpOnly cookie + refresh via /api/auth/refresh"

# Blocker
storm task note T-003 "Blocked: waiting on backend team for /api/users endpoint"

# Follow-up encontrado durante el trabajo
storm task note T-003 "Follow-up: T-004 created for password reset flow"
\`\`\`

## Buenas prácticas

- One sentence per note. If it's longer, you probably want a separate task.
- Decisions worth keeping after the task closes go in
  \`.context-compact/<branch>.md\` under \`## Notes\` instead.
- The user reads \`TASKS.md\`, so write for a human reviewer.
`,
  },
  {
    id: 'task-list',
    title: 'Listar tareas (task list)',
    summary: 'Listá tareas filtrando por status o branch.',
    body: `# Listar tareas

Use this to get an overview of pending work or to check what's already
in progress before creating something new.

## Comando

\`\`\`bash
storm task list                          # all tasks
storm task list --status pending
storm task list --status in_progress
storm task list --status done
storm task list --branch pages/api/auth  # all statuses, this branch
\`\`\`

## Cuándo usar

- Before creating a new task — check if it already exists.
- At the start of a session — see what was in progress.
- When the user asks "what's left to do".

## Ojo

\`TASKS.md\` is a regenerated view of the same data. Reading the file
directly works fine, but \`storm task list --status X\` is often more
useful for filtering programmatically.
`,
  },
  {
    id: 'branch-add',
    title: 'Crear una branch (branch add)',
    summary: 'Registrá una nueva branch en el compact-context.',
    body: `# Crear una branch

A "branch" in storm is a directory tracked separately in the
compact-context tree. Each declared branch produces a
\`.context-compact/<branch>.md\` summary.

## Comando

\`\`\`bash
storm branch add <path> "<one-line description>"
\`\`\`

## Ejemplos

\`\`\`bash
storm branch add pages/api/admin "Admin-only API endpoints"
storm branch add lib/payments "Payment gateway integration (Stripe)"
storm branch add "feature/onboarding" "New user onboarding flow"
\`\`\`

## Cuándo registrar una branch

- You're adding a new top-level feature directory (e.g.
  \`features/billing/\`).
- An existing directory has grown large enough to deserve its own
  summary (\`storm refresh\` will tell you in the warnings).
- The user explicitly asks for it.

## Cuándo NO

- Small directories (\`utils/\`, \`hooks/\`) — they're better included
  in a parent branch.
- Generated directories (\`dist/\`, \`build/\`) — already ignored.
- One-off scripts.

After creating a branch, run \`storm refresh\` so the new
\`<branch>.md\` is generated.
`,
  },
  {
    id: 'branch-list',
    title: 'Listar branches (branch list)',
    summary: 'Mostrá las branches declaradas y sus stats.',
    body: `# Listar branches

\`\`\`bash
storm branch list
\`\`\`

Shows declared branches, their description, file count, and any
\`stale\` flag (which means the branch existed in config but its
directory no longer has any tracked files).

Use this before creating a new branch to check if one already covers
what you need.
`,
  },
  {
    id: 'branch-pin',
    title: 'Pinear archivos en una branch (branch pin)',
    summary: 'Forzá que ciertos archivos aparezcan primero en project-map.md.',
    body: `# Pinear archivos en una branch

By default, files within a branch are ranked by import-graph fan-in,
barrel detection, export count, and task activity. Pinning overrides
that — pinned files always appear first in \`project-map.md\`.

## Comando

\`\`\`bash
storm branch pin <branch-path> <file1> <file2> ...
storm branch unpin <branch-path> <file1> <file2> ...
\`\`\`

## Cuándo pinear

- The "entry point" of a feature (e.g. \`index.ts\`, \`route.ts\`,
  \`main.tsx\`).
- Files the user explicitly says are important.
- Architectural keystones that aren't obvious from imports.

## Ejemplo

\`\`\`bash
storm branch pin src/auth index.ts middleware.ts
\`\`\`

After pinning, run \`storm refresh\` to regenerate the project map.
`,
  },
  {
    id: 'refresh',
    title: 'Refrescar el compact-context (refresh)',
    summary: 'Reindexá el proyecto entero (parser AST, ranking, summaries).',
    body: `# Refrescar el compact-context

This is the heavy reindex. It walks the project, parses every supported
file (JS/TS/JSX/TSX), recomputes the import graph, ranks files,
regenerates \`project-map.md\` and every \`.context-compact/<branch>.md\`,
and preserves the \`## Notes\` section of each branch file.

## Comando

\`\`\`bash
storm refresh
\`\`\`

## Cuándo correrlo

- After significant code changes (a feature is done, a refactor landed).
- When \`storm sync\` reports newly added branches and you want their
  summaries generated immediately.
- When the user asks "regenerate the context" or similar.
- The user is prompted automatically every 5 \`storm task done\`
  invocations.

## Cuándo NO

- After every single file save — wasteful.
- During an in-progress task — wait until the task is done so the
  ranking reflects the final state.

## Debug

If you see warnings like \`5 file(s) failed to parse\`, set
\`STORM_DEBUG=1\` to get the full list with parser errors:

\`\`\`bash
$env:STORM_DEBUG = "1"   # PowerShell
storm refresh
Remove-Item env:STORM_DEBUG
\`\`\`
`,
  },
  {
    id: 'sync',
    title: 'Sincronizar branches (sync)',
    summary: 'Detectá nuevas branches en el filesystem que no están en config.',
    body: `# Sincronizar branches

Lighter than \`storm refresh\`. Walks the project looking for new
directories that match the stack's branch patterns (e.g. for Next.js
Pages Router: \`pages/api/*\`, \`pages/*\`, \`components/*\`). Any match
that isn't already in \`project.config.json\` gets registered as a
branch automatically.

## Comando

\`\`\`bash
storm sync                 # detect + regenerate compact context
storm sync --no-regenerate # detect + update config only (faster)
\`\`\`

## Cuándo

- After creating new directories that should become branches (storm
  task done already runs sync — if you used that, this is redundant).
- The user explicitly asks "pick up the new directories".
- Just after \`storm import\` (storm import already runs sync at the
  end — this is mostly redundant unless you want to force it).
`,
  },
];

// ---------------------------------------------------------------------------
// Built-in agent roles
// ---------------------------------------------------------------------------

/**
 * Each entry produces one file at `.opencode/agents/<id>.md`.
 *
 * @typedef {Object} OpenCodeAgentSpec
 * @property {string} id
 * @property {string} title
 * @property {string} summary
 * @property {string} body
 */

/** @type {OpenCodeAgentSpec[]} */
export const BUILTIN_OPENCODE_AGENTS = [
  {
    id: 'task-runner',
    title: 'Task Runner',
    summary: 'Toma una tarea de TASKS.md y la ejecuta usando los comandos storm.',
    body: `# Task Runner

You are operating as the Task Runner role. The user gives you a task
to work on; your responsibility is to:

1. Read \`TASKS.md\` and find the task. If the user gave you a task
   ID (e.g. \`T-003\`), use it directly. Otherwise, find the matching
   task by title.
2. Read \`.context-compact/task-state.json\` to find the task's
   \`branches\` field.
3. Read each branch's \`.context-compact/<branch>.md\` summary.
   These contain enough information to plan the change without
   loading every source file.
4. Run \`storm task start <task-id>\`.
5. Make the change. Open source files only when the summaries aren't
   enough.
6. After significant decisions, run
   \`storm task note <task-id> "<decision>"\`.
7. When the change is complete and tests pass, run
   \`storm task done <task-id>\`. Storm will sync new branches
   automatically.

## What you must NOT do

- Do not edit \`TASKS.md\` directly. It is regenerated from
  \`task-state.json\`.
- Do not edit \`.context-compact/task-state.json\` directly either.
  Use the \`storm task\` commands.
- Do not overwrite the \`## Notes\` section of any
  \`.context-compact/<branch>.md\`. Append-only.

## Branch hygiene

If during the task you create new directories of code, they will be
auto-detected and registered by \`storm sync\` (which runs as part of
\`storm task done\`). You don't need to call \`storm branch add\`
manually for directories that match the stack's patterns.

If you create something OUTSIDE those patterns and want it tracked,
register it explicitly with \`storm branch add <path> "<description>"\`.
`,
  },
  {
    id: 'context-refresher',
    title: 'Context Refresher',
    summary: 'Mantenedor del compact-context: corre sync/refresh cuando hace falta.',
    body: `# Context Refresher

You are operating as the Context Refresher role. Your responsibility
is keeping \`.context-compact/\` accurate as the project evolves.

## Cuándo activarte

- The user asks "regenerate the context" or "refresh the project map".
- After a long session with many file changes that haven't been synced.
- After an external change (\`git pull\`, branch switch).

## Acciones

1. \`storm sync\` — detect new directories.
2. If sync added branches, \`storm refresh\` — regenerate the full
   compact context.
3. Report what changed.

## Reporte tipo

\`\`\`
Sync: 2 branches added (pages/api/billing, lib/payments).
Refresh: 47 files indexed, 3 unassigned (next.config.js, package.json,
tsconfig.json — root configs, expected).
\`\`\`

## What you must NOT do

- Do not run \`storm refresh\` mid-task — wait for the task to be
  done so the ranking reflects the final state.
- Do not edit \`.context-compact/<branch>.md\` files manually except
  for the \`## Notes\` section (which is preserved across refreshes).
`,
  },
  {
    id: 'planner',
    title: 'Planner',
    summary: 'Descompone trabajo grande en tareas storm enlazadas a branches.',
    body: `# Planner

You are operating as the Planner role. The user describes a piece of
work too big for a single task; your job is to break it down.

## Proceso

1. Read \`project-map.md\` to understand the project layout.
2. Read the relevant \`.context-compact/<branch>.md\` files to
   understand existing code in those areas.
3. Decompose the work into 3-7 tasks. Each task should:
   - Be doable in 30-90 minutes.
   - Be linked to one or two branches (use \`--branch\`).
   - Have a clear acceptance criterion.
4. Create each task with \`storm task add\`.
5. Optionally, set up a sequence with notes
   (\`storm task note T-001 "blocks T-002"\`).

## Ejemplo

User: "Add user profile page with avatar upload."

\`\`\`bash
storm task add "Profile page: layout + read-only data display" \\
  --branch pages/profile --branch components/profile
storm task add "Profile page: edit form for name + bio" \\
  --branch pages/profile --branch components/profile
storm task add "Avatar upload: API route with S3 SDK" \\
  --branch pages/api/profile --branch lib/storage
storm task add "Avatar upload: client component + crop UI" \\
  --branch components/profile
storm task add "Profile page: wire avatar to backend" \\
  --branch pages/profile --branch components/profile
\`\`\`

## What you must NOT do

- Do not start working on the tasks yourself. The Planner only plans.
- Do not pad with vague tasks ("Code Review", "Testing"). Every task
  has concrete output.
- Do not create more than 7-8 tasks at once. If the scope is bigger,
  the user should split into milestones first.
`,
  },
];

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/**
 * Render a single command file as `.opencode/commands/<id>.md`.
 * @param {OpenCodeCommandSpec} spec
 * @returns {string}
 */
export function renderOpencodeCommand(spec) {
  return `<!--
This file is part of storm-ai's scaffolding. It is a knowledge base
entry the LLM (operating through OpenCode) can read when the user
asks for something matching this command's purpose.

OpenCode does NOT execute this file as a slash command. It is a
reference document.
-->

${spec.body}
`;
}

/**
 * Render a single agent role file as `.opencode/agents/<id>.md`.
 * @param {OpenCodeAgentSpec} spec
 * @returns {string}
 */
export function renderOpencodeAgent(spec) {
  return `<!--
This file describes a "role" the LLM (operating through OpenCode) can
adopt when the user asks. It is a knowledge base entry, not an
auto-loaded sub-agent.
-->

${spec.body}
`;
}

/**
 * Render the index sections that go into AGENTS.md so the LLM knows
 * which command and agent files exist and what each one is for.
 * @returns {{commands: string, agents: string}}
 */
export function renderOpencodeIndex() {
  const commands = BUILTIN_OPENCODE_COMMANDS.map((c) =>
    `- **${c.title}** (\`./.opencode/commands/${c.id}.md\`) — ${c.summary}`,
  ).join('\n');

  const agents = BUILTIN_OPENCODE_AGENTS.map((a) =>
    `- **${a.title}** (\`./.opencode/agents/${a.id}.md\`) — ${a.summary}`,
  ).join('\n');

  return { commands, agents };
}
