/**
 * `storm new` — create a new project.
 *
 * This module is pure orchestration. It takes an `input` object (usually
 * filled by the clack wizard but also reachable from tests or scripts)
 * and produces the full project scaffold:
 *
 *   <dir>/
 *     project.config.json
 *     CLAUDE.md
 *     TASKS.md
 *     .context-compact/
 *       project-map.md
 *       task-state.json
 *       <branch>.md ...
 *     .claude/
 *       commands/
 *       skills/
 *       agents/
 *
 * No prompts, no console output — that's the UI layer's job. We just
 * return a result object with paths and warnings.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createConfig, writeConfig } from '../core/config.js';
import { refreshCompactContext } from '../core/compact.js';
import { safeName, projectPaths, fileExists } from '../core/paths.js';
import { writeState, regenerateTasksMd } from '../core/tasks.js';
import { getStack } from '../core/stacks.js';
import {
  getDefaultAgent,
  getDefaultProvider,
  getDefaultLaunchCommand,
} from '../core/global-config.js';
import {
  getAgent,
  getInstructionsFile,
  isProviderCompatible,
  resolveLaunchModel,
  getCompatibleProviders,
} from '../core/agents.js';
import { validateProviderModel } from '../core/providers.js';
import { syncAgentConfig } from '../core/agent-config.js';
import {
  BUILTIN_OPENCODE_COMMANDS,
  BUILTIN_OPENCODE_AGENTS,
  renderOpencodeCommand,
  renderOpencodeAgent,
  renderOpencodeIndex,
} from '../core/opencode-scaffold.js';

/**
 * @typedef {Object} NewProjectInput
 * @property {string} name
 * @property {string} [description]
 * @property {string} [stack]
 * @property {string} [database]
 * @property {string} parentDir         Where to create the project folder.
 * @property {Array<{path:string,description?:string,pinned?:string[]}>} [branches]
 * @property {Array<{name:string,builtin?:boolean,description?:string}>} [skills]
 * @property {Array<{name:string,slash:string,description?:string,tasks?:string[]}>} [agents]
 * @property {{provider:string,name:string|null}} [model]
 *   Launch provider/model. Default: global default provider (if it can
 *   drive the agent), else the agent's native provider.
 * @property {string} [agent]           Agent id. Default: global default.
 * @property {{customCommand?: string}} [launch]
 *   Default: global launchCommand, only for agents storm doesn't know.
 * @property {boolean} [force]          Overwrite if the target dir exists.
 */

/**
 * @typedef {Object} NewProjectResult
 * @property {string} projectRoot       Absolute path of the created project.
 * @property {string} safeName          Slugified name used as the dirname.
 * @property {string[]} createdFiles    Relative paths of all files written.
 * @property {string[]} warnings        Non-fatal messages for the user.
 */

/**
 * @param {NewProjectInput} input
 * @returns {Promise<NewProjectResult>}
 */
export async function createProject(input) {
  if (!input.name?.trim()) {
    throw new Error('Project name is required.');
  }
  if (!input.parentDir) {
    throw new Error('parentDir is required.');
  }

  const slug = safeName(input.name);
  const projectRoot = path.resolve(input.parentDir, slug);

  // 1. Bail out if the target exists and we're not forcing.
  if (!input.force && (await fileExists(projectRoot))) {
    throw new Error(
      `Directory already exists: ${projectRoot}. Pass force:true to overwrite, or choose another name.`,
    );
  }

  const warnings = [];
  const createdFiles = [];

  // 2. Create directory skeleton.
  // .context-compact/ is always created (storm's universal output).
  // .claude/* dirs are only created when the user picks claude-code, so
  // an opencode project doesn't get empty .claude/ subtrees lying around.
  await mkdir(projectRoot, { recursive: true });
  await mkdir(projectPaths.compactDir(projectRoot), { recursive: true });

  // 3. Build and write project.config.json.
  // Built-in skills are always included — they are the ones that power
  // the context-compact workflow.
  const skills = mergeBuiltinSkills(input.skills ?? []);

  // Resolve agent: explicit input > global default > 'claude-code'.
  const resolvedAgent = input.agent ?? (await getDefaultAgent());
  const model = await resolveNewProjectModel(input.model, resolvedAgent);
  const launch = input.launch ?? (await defaultLaunchFor(resolvedAgent));

  const config = createConfig({
    name: slug,
    description: input.description ?? '',
    stack: input.stack ?? '',
    stackId: input.stackId ?? 'other',
    database: input.database ?? '',
    databaseId: input.databaseId ?? 'other',
    model,
    agent: resolvedAgent,
    launch,
    skills,
    agents: input.agents ?? [],
    branches: input.branches ?? [],
  });
  await writeConfig(projectRoot, config);
  createdFiles.push('project.config.json');

  // 4. Write empty task-state.json (the Tasks module creates TASKS.md
  // from it on first regenerate).
  const now = new Date().toISOString();
  const state = {
    version: 1,
    project: { name: slug, created_at: now },
    counters: {
      done_since_refresh: 0,
      auto_refresh_threshold: config.compact_context.auto_refresh_threshold,
      last_refresh_at: null,
    },
    branches_index: (input.branches ?? []).map((b) => b.path),
    tasks: [],
  };
  await writeState(projectRoot, state);
  await regenerateTasksMd(projectRoot, state);
  createdFiles.push('.context-compact/task-state.json', 'TASKS.md');

  // 5-8. Agent-specific files: instructions file (CLAUDE.md / AGENTS.md),
  // built-in commands, skill and agent skeletons.
  const scaffold = await writeAgentScaffold({ projectRoot, config });
  createdFiles.push(...scaffold.createdFiles);

  // 9. Run the first compact-context refresh. At this point most projects
  // have no source files yet (we just scaffolded), so this mostly writes
  // an empty project-map.md and branch files — which is what we want:
  // Claude can see the structure from turn 1 even with no code.
  const refresh = await refreshCompactContext(projectRoot, {
    branches: config.compact_context.branches,
    mapFilesPerBranch: config.compact_context.map_files_per_branch,
    ignoredPaths: config.compact_context.ignored_paths ?? [],
    tasks: [],
  });
  for (const w of refresh.warnings) warnings.push(w);
  createdFiles.push('.context-compact/project-map.md');
  for (const b of config.compact_context.branches) {
    createdFiles.push(
      path.join('.context-compact', b.path.replaceAll('/', '-') + '.md'),
    );
  }

  try {
    const native = await syncAgentConfig(projectRoot);
    createdFiles.push(...native.createdFiles);
    warnings.push(...native.warnings);
  } catch (err) {
    warnings.push(`No pude autoconfigurar el CLI: ${err.message}`);
  }

  return {
    projectRoot,
    safeName: slug,
    createdFiles,
    warnings,
  };
}

/**
 * Pick the launch model for a new project.
 * Explicit input must be valid and compatible with the agent (we throw
 * otherwise, so flag typos don't produce projects that can't launch).
 * Without input we use the global default when it can drive the agent,
 * else the agent's native provider.
 *
 * @param {{provider:string,name:string|null}|undefined} model
 * @param {string} agentId
 * @returns {Promise<{provider:string,name:string|null}>}
 */
export async function resolveNewProjectModel(model, agentId) {
  if (model) {
    const err = validateProviderModel(model.provider, model.name);
    if (err) throw new Error(err);
    if (!isProviderCompatible(model.provider, agentId)) {
      throw new Error(
        `El provider "${model.provider}" no puede lanzar ${getAgent(agentId)?.label ?? agentId}. ` +
        `Compatibles: ${getCompatibleProviders(agentId).join(', ')}.`,
      );
    }
    return { provider: model.provider, name: model.name ?? null };
  }
  // An Ollama default without a model is fine: agent-config picks an
  // installed/recommended one when the project is prepared.
  const def = await getDefaultProvider();
  const base = def ? { provider: def.provider, name: def.model } : { provider: 'claude', name: null };
  return resolveLaunchModel(base, agentId).model;
}

/**
 * The global launch command is the way to run agents storm doesn't
 * know; known agents use their own launch template.
 * @param {string} agentId
 */
async function defaultLaunchFor(agentId) {
  if (getAgent(agentId)) return {};
  const cmd = await getDefaultLaunchCommand();
  return cmd ? { customCommand: cmd } : {};
}

/**
 * Write the agent-specific scaffolding for a project: the instructions
 * file the agent auto-loads plus its commands/skills/agents files.
 *
 * Used when creating a project and when switching a project to another
 * agent (`storm project set agent ...`). With `overwrite: false`, files
 * that already exist are left alone (and reported as skipped), except
 * storm's own built-in command/role docs which are always refreshed.
 *
 * @param {{projectRoot: string, config: import('../core/config.js').ProjectConfig, overwrite?: boolean}} input
 * @returns {Promise<{createdFiles: string[], skippedFiles: string[]}>}
 */
export async function writeAgentScaffold({ projectRoot, config, overwrite = true }) {
  const agentId = config.agent ?? 'claude-code';
  /** @type {string[]} */
  const createdFiles = [];
  /** @type {string[]} */
  const skippedFiles = [];

  const write = async (rel, content, force = overwrite) => {
    const abs = path.join(projectRoot, rel);
    if (!force && (await fileExists(abs))) {
      skippedFiles.push(rel);
      return;
    }
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    createdFiles.push(rel);
  };

  const agentMd = renderAgentMd({ config });
  await write(agentMd.filename, agentMd.content);

  if (agentId === 'claude-code') {
    await mkdir(projectPaths.claudeCommands(projectRoot), { recursive: true });
    await mkdir(projectPaths.claudeSkills(projectRoot), { recursive: true });
    await mkdir(projectPaths.claudeAgents(projectRoot), { recursive: true });

    // Built-in slash commands, in Claude Code's `.claude/commands/` format.
    for (const { filename, content } of renderBuiltinCommands()) {
      await write(path.join('.claude', 'commands', filename), content);
    }
    // User skills as placeholder .md files (Claude Code's convention).
    for (const skill of config.skills.filter((s) => !s.builtin)) {
      await write(path.join('.claude', 'skills', `${safeName(skill.name)}.md`), renderSkillSkeleton(skill));
    }
    for (const agent of config.agents) {
      await write(path.join('.claude', 'agents', `${safeName(agent.slash || agent.name)}.md`), renderAgentSkeleton(agent));
    }
  } else if (agentId === 'opencode') {
    // OpenCode loads .opencode/commands/*.md and .opencode/agents/*.md;
    // AGENTS.md at the root indexes them.
    await mkdir(projectPaths.opencodeCommands(projectRoot), { recursive: true });
    await mkdir(projectPaths.opencodeAgents(projectRoot), { recursive: true });

    for (const cmd of BUILTIN_OPENCODE_COMMANDS) {
      await write(path.join('.opencode', 'commands', `${cmd.id}.md`), renderOpencodeCommand(cmd), true);
    }
    for (const ag of BUILTIN_OPENCODE_AGENTS) {
      await write(path.join('.opencode', 'agents', `${ag.id}.md`), renderOpencodeAgent(ag), true);
    }
    // User-defined agents become per-project role docs.
    for (const agent of config.agents) {
      await write(path.join('.opencode', 'agents', `${safeName(agent.slash || agent.name)}.md`), renderAgentSkeleton(agent));
    }
  }

  return { createdFiles, skippedFiles };
}

// ---------------------------------------------------------------------------
// Built-in skills
// ---------------------------------------------------------------------------

const BUILTIN_SKILLS = [
  {
    name: 'compact-route',
    builtin: true,
    description:
      'Decide which .context-compact/ branches to load based on the active task.',
  },
  {
    name: 'refresh-compact',
    builtin: true,
    description:
      'Regenerate .context-compact/ after significant changes (manual trigger).',
  },
  {
    name: 'plan-systematic',
    builtin: true,
    description:
      'Break down a high-level request into concrete tasks, each tied to branches.',
  },
];

function mergeBuiltinSkills(userSkills) {
  const builtinNames = new Set(BUILTIN_SKILLS.map((s) => s.name));
  const filtered = userSkills.filter((s) => !builtinNames.has(s.name));
  return [...BUILTIN_SKILLS, ...filtered];
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * Render the project's "agent instructions" markdown file.
 *
 * @param {Object} args
 * @param {import('../core/config.js').ProjectConfig} args.config
 * @param {string} [args.agentId]   'claude-code' | 'opencode' | other.
 *                                  Defaults to config.agent.
 * @returns {{ filename: string, content: string }}
 *   filename relative to projectRoot:
 *     'CLAUDE.md'   (claude-code)
 *     'AGENTS.md'   (opencode and anything else)
 */
export function renderAgentMd({ config, agentId }) {
  const agent = agentId ?? config.agent ?? 'claude-code';
  const branches = config.compact_context.branches;
  const skills = config.skills;
  const agents = config.agents;

  const branchLines =
    branches.length === 0
      ? '_No branches declared yet. They will be auto-detected as the project grows._'
      : branches.map((b) => {
          const desc = b.description ? ` — ${b.description}` : '';
          return `- \`${b.path}\`${desc}`;
        }).join('\n');

  const skillLines = skills.length === 0
    ? '_No skills configured._'
    : skills.map((s) => {
        const tag = s.builtin ? ' _(built-in)_' : ' _(custom)_';
        const desc = s.description ? ` — ${s.description}` : '';
        return `- **${s.name}**${tag}${desc}`;
      }).join('\n');

  const agentLines = agents.length === 0
    ? '_No agents configured._'
    : agents.map((a) => {
        const desc = a.description ? ` — ${a.description}` : '';
        return `- **${a.name}** (\`/${a.slash}\`)${desc}`;
      }).join('\n');

  // Stack-specific branch conventions, if known.
  let conventionBlock = '';
  const preset = getStack(config.stackId);
  if (preset && preset.branchPatterns?.length) {
    conventionBlock =
      '### Convenciones de ramas (' + preset.label + ')\n\n' +
      'Cuando crees una carpeta nueva con código, **debe ubicarse en uno de\n' +
      'estos patrones** para que `storm sync` la registre como rama:\n\n' +
      preset.branchPatterns.map((p) => `- \`${p}\``).join('\n') +
      '\n\nSi necesitás una carpeta fuera de estos patrones, registrala manualmente\n' +
      'con `storm branch add <path> "descripción"` antes de crear archivos adentro.\n';
  }

  // Adapt the "where skills live" hint to the agent. Both agents read
  // skills from .claude/skills/ today (storm writes them there), so the
  // copy is the same — but we keep this branchable in case OpenCode ever
  // wants its own skill layout.
  const skillsLocationHint =
    agent === 'opencode'
      ? 'This creates `.claude/skills/<slug>.md` (storm writes skill files there) and tracks it in `project.config.json`. OpenCode currently reads skill metadata from `project.config.json`.'
      : 'This creates `.claude/skills/<slug>.md` (where Claude Code looks for them) and tracks it in `project.config.json`.';

  // Filename / location depends on the agent.
  const filename = getInstructionsFile(agent);

  // OpenCode: list the command/role files under .opencode/ so the LLM
  // knows they exist.
  let opencodeIndexBlock = '';
  if (agent === 'opencode') {
    const idx = renderOpencodeIndex();
    opencodeIndexBlock = `
## Storm CLI commands (referencia)

${idx.commands}

## Storm roles (referencia)

${idx.agents}
`;
  }

  const content = `# ${config.name}

${config.description || '_No project description yet._'}

## Stack

${config.stack || '_Not specified._'}

${config.database ? `## Database\n\n${config.database}\n` : ''}

## How to work in this project

This project uses **storm-ai** for context-aware development. Before doing
anything, read these two files:

1. \`.context-compact/project-map.md\` — high-level index of the codebase.
2. \`TASKS.md\` — current task list with status.

### Workflow

1. Pick or receive a task.
2. Read \`.context-compact/task-state.json\` to find the task's \`branches\`.
3. Load only the \`.context-compact/<branch>.md\` files listed there.
4. Only open full source files if the compact summaries are not enough.
5. When you finish a task, mark it done via \`storm task done <id>\` (or
   the \`/task-done\` slash command). storm will auto-sync the branch
   list. After 5 \`done\` tasks since the last refresh, the user will be
   prompted to run \`storm refresh\`.

### Creating new directories

When you create a new directory of code (a feature, a service, a route group),
**you don't need to manually register it as a branch** — \`storm task done\`
runs \`storm sync\` automatically and picks up new directories that match
the stack's conventions.

If you want to be explicit (recommended for clarity), use:

\`\`\`
storm branch add <path> "<one-line description>"
\`\`\`

This registers the branch immediately and gives it a description that
will appear in \`project-map.md\`.

${conventionBlock}

### Function index (#IDs)

Every function of the app has a stable ID (\`#ID-001\`, \`#ID-002\`, ...) and
is grouped by section in \`.context-compact/sections/<frontend|backend|shared>/<section>.md\`
(listed in \`project-map.md\`). Each entry has the ID, signature, a
one-line description and the line range in its file.

To work on a feature, open the section file (e.g. \`sections/frontend/pacientes.md\`),
pick the IDs you need and read only those lines, or run
\`storm functions show <ID>\` to print the exact code. Use
\`storm functions list <text>\` to search. Refer to functions by their ID
when you talk about them. Never add \`#ID\` markers to the source code: the
index is regenerated by \`storm refresh\`.

### Branches

${branchLines}

### Available skills

${skillLines}

You can add a per-project skill at any time:

\`\`\`
storm skill add <n>
\`\`\`

${skillsLocationHint}

### Available agents

${agentLines}
${opencodeIndexBlock}
## Guardrails

- **Never edit \`TASKS.md\` directly.** It is a view generated from \`.context-compact/task-state.json\`. Use the task commands.
- **Never overwrite the "## Notes" section of a \`.context-compact/<branch>.md\` file.** Append only.
- When you create new directories, prefer paths that match the stack's branch patterns above. If a different layout is genuinely better, register the branch with \`storm branch add\` and explain why in its description.
`;

  return { filename, content };
}

function renderSkillSkeleton(skill) {
  return `# ${skill.name}

${skill.description || '_Describe what this skill does and when Claude should use it._'}

## When to use

<!-- List concrete triggers. Examples:
- When the user asks to modify component styling
- When analyzing database schema
-->

## Steps

<!-- Concrete actions Claude should take when this skill activates. -->

## Examples

<!-- Input → expected behavior pairs. -->
`;
}

function renderAgentSkeleton(agent) {
  const taskList = (agent.tasks ?? []).map((t) => `- ${t}`).join('\n') ||
    '_No preset tasks._';
  return `# ${agent.name}

Invoke with: \`/${agent.slash}\`

${agent.description || '_Describe this agent\'s role._'}

## Responsibilities

${taskList}

## Context to load

<!-- Which compact-context branches should this agent always load? -->

## Output format

<!-- What does this agent produce? PRs, diffs, reports, code? -->
`;
}

/**
 * Built-in slash commands, dropped into .claude/commands/.
 * Each command is a .md file following Claude Code's convention.
 */
function renderBuiltinCommands() {
  return [
    {
      filename: 'task-add.md',
      content: `# /task-add

Create a new task and append it to the task list.

## Usage

\`\`\`
/task-add <title> | <description> | branch1,branch2
\`\`\`

## Behavior

1. Parse the input into title, description, and branch list.
2. Validate each branch against \`project.config.json\`'s \`compact_context.branches\`.
3. Shell out to \`storm task add\` (or call the JS equivalent).
4. Confirm the new task ID and current status.
`,
    },
    {
      filename: 'task-done.md',
      content: `# /task-done

Mark a task as complete.

## Usage

\`\`\`
/task-done <task-id>
\`\`\`

## Behavior

1. Confirm the task exists and is not already done.
2. Update status to \`done\` via \`storm task done <id>\`.
3. If the counter reaches the auto-refresh threshold, prompt the user
   to run \`storm refresh\` (do not auto-run without confirmation).
`,
    },
    {
      filename: 'task-start.md',
      content: `# /task-start

Begin work on a task. Sets status to \`in_progress\` and pre-loads
the relevant compact-context branches.

## Usage

\`\`\`
/task-start <task-id>
\`\`\`

## Behavior

1. Set status to \`in_progress\`.
2. Read the task's \`branches\` field from \`task-state.json\`.
3. Load each \`.context-compact/<branch>.md\` into context.
4. Confirm ready to begin.
`,
    },
    {
      filename: 'refresh-compact.md',
      content: `# /refresh-compact

Regenerate the \`.context-compact/\` directory.

## Usage

\`\`\`
/refresh-compact
\`\`\`

## Behavior

1. Walk the project tree.
2. Re-parse every source file for exports and comments.
3. Re-rank files per branch using the deterministic heuristic.
4. Preserve the "## Notes" sections of existing branch files.
5. Report a summary: files scanned, branches written, warnings.
`,
    },
  ];
}
