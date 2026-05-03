/**
 * `storm import` — scaffold storm-ai onto an existing project.
 *
 * Pipeline:
 *   1. scanProject(path)              — gather metadata + tree
 *   2. buildAnalysisPrompt(scan)      — build LLM prompt
 *   3. complete({provider, prompt})   — call LLM
 *   4. parseAnalysis(text)            — extract structured data
 *   5. (UI layer) preview + confirm   — let user edit values
 *   6. writeImport(...)               — write scaffolding to disk
 *
 * This module exposes the pieces so the UI can drive each step
 * separately (with spinners, prompts, etc).
 */

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { scanProject, buildAnalysisPrompt } from '../core/analyze.js';
import { complete } from '../core/llm-client.js';
import { parseAnalysis } from '../core/parse-analysis.js';
import { createConfig, writeConfig } from '../core/config.js';
import { refreshCompactContext } from '../core/compact.js';
import { writeState, regenerateTasksMd } from '../core/tasks.js';
import { projectPaths } from '../core/paths.js';
import { getStack, getDatabase } from '../core/stacks.js';
import { getDefaultProvider, getDefaultAgent } from '../core/global-config.js';
import { sync } from './sync.js';

/**
 * @typedef {Object} AnalyzeArgs
 * @property {string} cwd                      Project directory to import.
 * @property {'shallow'|'deep'} mode
 * @property {string} provider                 'ollama-cloud' | 'ollama-local' | 'claude'
 * @property {string|null} [model]
 */

/**
 * Steps 1-4: scan + LLM call + parse. Returns the analysis result and
 * raw LLM text for diagnostics. UI layer wraps this in a spinner.
 *
 * @param {AnalyzeArgs} args
 * @returns {Promise<{analysis: import('../core/parse-analysis.js').AnalysisResult, rawText: string}>}
 */
export async function analyzeForImport(args) {
  const scan = await scanProject({ cwd: args.cwd, mode: args.mode });
  const prompt = buildAnalysisPrompt(scan);

  const rawText = await complete({
    provider: args.provider,
    model: args.model ?? null,
    prompt,
    system:
      'You are a strict JSON-only assistant. Respond with a single JSON ' +
      'object, no commentary, no code fences. Never include text before or ' +
      'after the JSON.',
    temperature: 0.1,
  });

  const analysis = parseAnalysis(rawText);
  return { analysis, rawText };
}

/**
 * @typedef {Object} ImportPlan
 * @property {string} projectRoot              Absolute path of the target.
 * @property {string} name                     Final name (after user edits).
 * @property {string} description
 * @property {string} stackId
 * @property {string} databaseId
 * @property {{provider: string, name: string|null}} model
 * @property {string} [agent]                  CLI agent id. Default: global default.
 * @property {Array<{path: string, description?: string}>} branches
 * @property {Array<{name: string, builtin?: boolean, description?: string}>} skills
 * @property {Array<{name: string, slash: string, description?: string}>} agents
 * @property {boolean} [overwriteClaudeMd]
 * @property {boolean} [overwriteConfig]
 * @property {boolean} [overwriteTasks]
 */

/**
 * @typedef {Object} ImportResult
 * @property {string} projectRoot
 * @property {string[]} createdFiles
 * @property {string[]} skippedFiles    Files left untouched because the user opted out.
 * @property {string[]} warnings
 */

/**
 * Inspect what would conflict with an import. The UI calls this BEFORE
 * showing confirm prompts, so it can ask the user per-file.
 *
 * @param {string} projectRoot
 * @returns {Promise<{claudeMd: boolean, config: boolean, tasks: boolean, contextDir: boolean, claudeDir: boolean, opencodeDir: boolean, agentsMd: boolean}>}
 */
export async function detectConflicts(projectRoot) {
  return {
    claudeMd:    await pathExists(path.join(projectRoot, 'CLAUDE.md')),
    config:      await pathExists(path.join(projectRoot, 'project.config.json')),
    tasks:       await pathExists(path.join(projectRoot, 'TASKS.md')),
    contextDir:  await pathExists(projectPaths.compactDir(projectRoot)),
    claudeDir:   await pathExists(path.join(projectRoot, '.claude')),
    opencodeDir: await pathExists(path.join(projectRoot, '.opencode')),
    // .opencode/AGENTS.md is the equivalent of CLAUDE.md for OpenCode users.
    agentsMd:    await pathExists(path.join(projectRoot, '.opencode/AGENTS.md')) ||
                 await pathExists(path.join(projectRoot, 'AGENTS.md')),
  };
}

/**
 * Step 6: write the storm-ai scaffolding into the existing project.
 *
 * @param {ImportPlan} plan
 * @returns {Promise<ImportResult>}
 */
export async function writeImport(plan) {
  /** @type {ImportResult} */
  const result = {
    projectRoot: plan.projectRoot,
    createdFiles: [],
    skippedFiles: [],
    warnings: [],
  };

  // Make sure the target dirs exist. The compact dir is always needed
  // (storm's universal output). The .claude/ subtree is only needed for
  // the claude-code agent — creating it for opencode would leave empty
  // dirs that confuse OpenCode's project scanner.
  await mkdir(projectPaths.compactDir(plan.projectRoot), { recursive: true });

  const stackPreset = getStack(plan.stackId);
  const dbPreset = getDatabase(plan.databaseId);

  // Build skills: built-ins always, plus any custom from the analysis.
  const builtinSkills = [
    {
      name: 'plan-systematic',
      builtin: true,
      description: 'Break down a high-level request into concrete tasks, each tied to branches.',
    },
    {
      name: 'compact-route',
      builtin: true,
      description: 'Decide which .context-compact/ branches to load based on the active task.',
    },
    {
      name: 'refresh-compact',
      builtin: true,
      description: 'Regenerate .context-compact/ after significant changes (manual trigger).',
    },
  ];
  const customSkills = (plan.skills ?? [])
    .filter((s) => s && s.name)
    .map((s) => ({
      name: slugify(s.name),
      builtin: false,
      description: s.description ?? '',
    }));
  const allSkills = [...builtinSkills, ...customSkills];

  // Resolve which agent to use: explicit plan.agent > global default > 'claude-code'.
  const resolvedAgent = plan.agent ?? (await getDefaultAgent());

  // Create .claude/ subdirs only when the user actually uses claude-code.
  if (resolvedAgent === 'claude-code') {
    await mkdir(projectPaths.claudeCommands(plan.projectRoot), { recursive: true });
    await mkdir(projectPaths.claudeSkills(plan.projectRoot), { recursive: true });
    await mkdir(projectPaths.claudeAgents(plan.projectRoot), { recursive: true });
  }

  const config = createConfig({
    name: plan.name,
    description: plan.description,
    stack: stackPreset?.label ?? '',
    stackId: plan.stackId,
    database: dbPreset?.label ?? '',
    databaseId: plan.databaseId,
    model: plan.model,
    agent: resolvedAgent,
    skills: allSkills,
    agents: (plan.agents ?? []).map((a) => ({
      name: a.name,
      slash: slugify(a.slash || a.name),
      description: a.description ?? '',
    })),
    branches: (plan.branches ?? []).map((b) => ({
      path: b.path,
      description: b.description ?? '',
    })),
  });

  // Write project.config.json.
  if (plan.overwriteConfig === false &&
      (await pathExists(path.join(plan.projectRoot, 'project.config.json')))) {
    result.skippedFiles.push('project.config.json');
  } else {
    await writeConfig(plan.projectRoot, config);
    result.createdFiles.push('project.config.json');
  }

  // Write the agent instructions file. Filename + location depend on
  // which agent the user picked (claude-code → CLAUDE.md at root,
  // opencode → .opencode/AGENTS.md, anything else → AGENTS.md at root).
  const agentMd = renderAgentMd({ config });
  const agentMdPath = path.join(plan.projectRoot, agentMd.filename);
  if (plan.overwriteClaudeMd === false &&
      (await pathExists(agentMdPath))) {
    result.skippedFiles.push(agentMd.filename);
  } else {
    // Ensure parent directory exists (for .opencode/ etc.).
    await mkdir(path.dirname(agentMdPath), { recursive: true });
    await writeFile(agentMdPath, agentMd.content, 'utf8');
    result.createdFiles.push(agentMd.filename);
  }

  // Write task-state.json + TASKS.md.
  await writeState(plan.projectRoot, {
    version: 1,
    project: { name: plan.name, created_at: new Date().toISOString() },
    counters: {
      done_since_refresh: 0,
      auto_refresh_threshold: 5,
      last_refresh_at: null,
    },
    branches_index: [],
    tasks: [],
  });
  result.createdFiles.push('.context-compact/task-state.json');

  if (plan.overwriteTasks === false &&
      (await pathExists(path.join(plan.projectRoot, 'TASKS.md')))) {
    result.skippedFiles.push('TASKS.md');
  } else {
    await regenerateTasksMd(plan.projectRoot, await readState(plan.projectRoot));
    result.createdFiles.push('TASKS.md');
  }

  // Write skill files.
  for (const skill of customSkills) {
    const file = path.join(projectPaths.claudeSkills(plan.projectRoot), `${skill.name}.md`);
    if (await pathExists(file)) {
      result.skippedFiles.push(`.claude/skills/${skill.name}.md`);
      continue;
    }
    await writeFile(file, renderSkillTemplate(skill), 'utf8');
    result.createdFiles.push(`.claude/skills/${skill.name}.md`);
  }

  // Write agent files and built-in slash commands ONLY for claude-code.
  // Other agents (opencode, custom) have different conventions; emitting
  // .claude/ files into a non-claude-code project would be cargo-cult.
  if (resolvedAgent === 'claude-code') {
    for (const agent of config.agents) {
      const file = path.join(projectPaths.claudeAgents(plan.projectRoot), `${agent.slash}.md`);
      if (await pathExists(file)) {
        result.skippedFiles.push(`.claude/agents/${agent.slash}.md`);
        continue;
      }
      await writeFile(file, renderAgentTemplate(agent), 'utf8');
      result.createdFiles.push(`.claude/agents/${agent.slash}.md`);
    }

    // Built-in slash commands (always written for claude-code; they're
    // storm's own commands and the user shouldn't have hand-edited them).
    await writeBuiltinCommands(plan.projectRoot, result);
  }

  // Generate compact context for the project.
  // CRITICAL: pass branches/mapFilesPerBranch/ignoredPaths from the config
  // we just wrote. If we don't, refreshCompactContext defaults to "no
  // branches", every file lands in `_unassigned`, and the user's first
  // impression of the project-map.md is broken until they manually run
  // `storm refresh`.
  try {
    const stateForRefresh = await readState(plan.projectRoot);
    await refreshCompactContext(plan.projectRoot, {
      branches: config.compact_context.branches,
      mapFilesPerBranch: config.compact_context.map_files_per_branch,
      ignoredPaths: config.compact_context.ignored_paths ?? [],
      tasks: stateForRefresh.tasks ?? [],
    });
  } catch (err) {
    result.warnings.push(`Falló la generación de .context-compact: ${err.message}`);
  }

  // Run sync once at the very end. The LLM + initialBranches don't always
  // catch every branch worth tracking — for example, deeper directories
  // like `pages/api/admin` only become obvious once you walk the filesystem.
  // Sync does that walk, registers any new branches, and regenerates the
  // compact context. Skipping this step would force the user to run
  // `storm sync` manually right after import to get a complete picture.
  try {
    const syncReport = await sync({ cwd: plan.projectRoot, regenerate: true });
    if (syncReport.added.length > 0) {
      const names = syncReport.added.map((b) => b.path).join(', ');
      result.warnings.push(
        `Sync agregó ${syncReport.added.length} branch(es) detectada(s) en el filesystem: ${names}`,
      );
    }
  } catch (err) {
    result.warnings.push(`Sync post-import falló: ${err.message}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Templates / helpers
// ---------------------------------------------------------------------------

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readState(projectRoot) {
  const raw = await readFile(
    path.join(projectPaths.compactDir(projectRoot), 'task-state.json'),
    'utf8',
  );
  return JSON.parse(raw);
}

function slugify(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Render the project's "agent instructions" markdown file.
 *
 * The content is mostly the same regardless of which agent the user
 * picked — it documents the storm conventions, branches, skills, etc.
 * The differences:
 *   - The filename and on-disk location depends on the agent.
 *   - The "How to work" intro names the agent the user is actually using.
 *
 * @param {Object} args
 * @param {import('../core/config.js').ProjectConfig} args.config
 * @param {string} [args.agentId]    'claude-code' | 'opencode' | other.
 *                                    Defaults to config.agent.
 * @returns {{ filename: string, content: string }}
 *   - filename:  relative path inside projectRoot. Examples:
 *                  'CLAUDE.md'                 (claude-code)
 *                  '.opencode/AGENTS.md'        (opencode)
 *                  'AGENTS.md'                  (anything else / custom)
 */
function renderAgentMd({ config, agentId }) {
  const agent = agentId ?? config.agent ?? 'claude-code';
  const branches = config.compact_context.branches;
  const skills = config.skills;
  const agents = config.agents;

  const branchLines = branches.length === 0
    ? '_No branches declared yet._'
    : branches.map((b) => {
        const desc = b.description ? ` — ${b.description}` : '';
        return `- \`${b.path}\`${desc}`;
      }).join('\n');

  const skillLines = skills.map((s) => {
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

  const stackPreset = getStack(config.stackId);
  const conventionBlock = stackPreset?.branchPatterns?.length
    ? '### Convenciones de ramas (' + stackPreset.label + ')\n\n' +
      'Cuando crees una carpeta nueva con código, debe ubicarse en uno de\n' +
      'estos patrones para que `storm sync` la registre como rama:\n\n' +
      stackPreset.branchPatterns.map((p) => `- \`${p}\``).join('\n') + '\n'
    : '';

  // Filename / location depends on the agent. OpenCode looks for
  // `.opencode/AGENTS.md` by convention; Claude Code reads `CLAUDE.md`
  // from the project root; anything else gets a generic top-level
  // `AGENTS.md` so a human or another tool can still find it.
  const filename =
    agent === 'opencode'    ? '.opencode/AGENTS.md' :
    agent === 'claude-code' ? 'CLAUDE.md' :
    'AGENTS.md';

  const content = `# ${config.name}

${config.description || '_No project description yet._'}

## Stack

${config.stack || '_Not specified._'}

${config.database ? `## Database\n\n${config.database}\n` : ''}

## How to work in this project

This project was scaffolded with **storm-ai**. Before doing anything, read:

1. \`.context-compact/project-map.md\` — high-level index of the codebase.
2. \`TASKS.md\` — current task list with status.

### Workflow

1. Pick or receive a task.
2. Read \`.context-compact/task-state.json\` to find the task's \`branches\`.
3. Load only the \`.context-compact/<branch>.md\` files listed there.
4. Only open full source files if the compact summaries are not enough.
5. When you finish a task, mark it done via \`storm task done <id>\`. Storm
   auto-syncs new branches.

${conventionBlock}

### Branches

${branchLines}

### Available skills

${skillLines}

### Available agents

${agentLines}

## Guardrails

- **Never edit \`TASKS.md\` directly.** It is generated from \`.context-compact/task-state.json\`.
- **Never overwrite the "## Notes" section of a \`.context-compact/<branch>.md\` file.** Append only.
- New directories should follow the stack's branch patterns above. Otherwise register them with \`storm branch add\`.
`;

  return { filename, content };
}

function renderSkillTemplate(skill) {
  return `# ${skill.name}

${skill.description || '_Describe lo que hace esta skill y cuándo se debe activar._'}

## Cuándo invocarla

<!-- Triggers concretos. -->

## Pasos

1.
2.
3.

## Output esperado

<!-- Qué produce. -->
`;
}

function renderAgentTemplate(agent) {
  return `# ${agent.name}

Invoke with: \`/${agent.slash}\`

${agent.description || '_Describe el rol del agente._'}

## Responsibilities

## Context to load

<!-- Branches que este agente siempre debería cargar. -->

## Output format

<!-- Qué produce este agente: PRs, diffs, reportes? -->
`;
}

async function writeBuiltinCommands(projectRoot, result) {
  const cmdsDir = projectPaths.claudeCommands(projectRoot);
  /** @type {Array<[string, string]>} */
  const commands = [
    ['refresh-compact.md',
     '# /refresh-compact\n\nManually regenerate `.context-compact/`.\n\n## Behavior\n\n1. Run `storm refresh`.\n2. Confirm done.\n'],
    ['task-add.md',
     '# /task-add\n\nAdd a new task.\n\n## Usage\n\n```\n/task-add "<title>" [--branches a,b]\n```\n'],
    ['task-start.md',
     '# /task-start\n\nBegin a task.\n\n## Usage\n\n```\n/task-start <task-id>\n```\n\n## Behavior\n\n1. Set status to in_progress.\n2. Load the task\'s branches.\n'],
    ['task-done.md',
     '# /task-done\n\nMark a task done.\n\n## Usage\n\n```\n/task-done <task-id>\n```\n\n## Behavior\n\n1. Set status to done.\n2. Auto-run sync.\n'],
  ];

  for (const [name, content] of commands) {
    const file = path.join(cmdsDir, name);
    if (await pathExists(file)) continue;
    await writeFile(file, content, 'utf8');
    result.createdFiles.push(`.claude/commands/${name}`);
  }
}

// ---------------------------------------------------------------------------
// Non-interactive entrypoint
//
// `storm import` is normally a wizard, but agents and CI need a way to
// invoke it programmatically. This function does the same pipeline
// (scan + LLM analyze + write) without ever calling clack.
//
// All inputs come from CLI flags. If a flag is missing, we use sensible
// defaults; if a critical flag is missing AND there's no global default,
// we throw a clear error.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} NonInteractiveImportInput
 * @property {string} cwd                               Project directory.
 * @property {'shallow'|'deep'} [mode]                  Default 'shallow'.
 * @property {string} [provider]                        Override global default.
 * @property {string|null} [model]                      Override global default.
 * @property {string} [agent]                           Override global default.
 * @property {string} [name]                            Project name (default: dir basename).
 * @property {string} [description]
 * @property {string} [stack]                           Stack id (e.g. 'nextjs-pages').
 * @property {string} [db]                              Database id.
 * @property {string[]} [extraBranches]                 Branches to add on top of LLM suggestions.
 * @property {string[]} [skills]                        Skill names to scaffold.
 * @property {string[]} [agentNames]                    Agent files to scaffold.
 * @property {boolean} [yes]                            Auto-confirm overwrites.
 * @property {boolean} [skipLLM]                        Don't call the LLM, use defaults.
 * @property {(msg: string) => void} [log]              Optional logger (default: console.log).
 */

/**
 * @param {NonInteractiveImportInput} input
 * @returns {Promise<{
 *   projectRoot: string,
 *   createdFiles: string[],
 *   skippedFiles: string[],
 *   warnings: string[],
 *   analysis?: import('../core/parse-analysis.js').AnalysisResult,
 * }>}
 */
export async function runImportNonInteractive(input) {
  const log = input.log ?? ((m) => console.log(m));
  const projectRoot = path.resolve(input.cwd);

  // Resolve provider + model from flags or global defaults.
  let provider = input.provider;
  let model = input.model ?? null;
  if (!provider) {
    const def = await getDefaultProvider();
    if (!def) {
      throw new Error(
        'No provider configured. Pass --provider or set a default with `storm config`.',
      );
    }
    provider = def.provider;
    if (model === null && def.model) model = def.model;
  }

  // Resolve agent.
  const agent = input.agent ?? (await getDefaultAgent());

  // Run analysis (or skip with defaults).
  /** @type {import('../core/parse-analysis.js').AnalysisResult | null} */
  let analysis = null;
  if (input.skipLLM) {
    log('Skipping LLM analysis (--skip-llm).');
  } else {
    log(`Analizando proyecto con ${provider}${model ? ' (' + model + ')' : ''}...`);
    try {
      const r = await analyzeForImport({
        cwd: projectRoot,
        mode: input.mode ?? 'shallow',
        provider,
        model,
      });
      analysis = r.analysis;
      log(`✓ Análisis completo. Stack: ${analysis.stackId}, ` +
          `LLM sugirió ${analysis.branches.length} branch(es).`);
    } catch (err) {
      log(`⚠ Análisis falló: ${err.message}. Continuando con defaults.`);
    }
  }

  // Build the plan. Flags override LLM analysis, both override defaults.
  const name = (input.name ?? analysis?.name ?? path.basename(projectRoot)).trim();
  const description = input.description ?? analysis?.description ?? '';
  const stackId = input.stack ?? analysis?.stackId ?? 'other';
  const databaseId = input.db ?? analysis?.databaseId ?? 'other';

  // Merge branches from THREE sources, in priority order:
  //   1. LLM analysis (high quality, project-specific)
  //   2. Stack preset's initialBranches (covers gaps the LLM missed —
  //      e.g. Next.js pages router LLM often forgets `pages` itself)
  //   3. --branch flags from the user
  // Only include branches whose directory actually exists.
  const stackPresetForBranches = getStack(stackId);
  const branchPaths = new Set();
  const branches = [];
  const branchSources = { llm: 0, preset: 0, flags: 0 };

  for (const b of analysis?.branches ?? []) {
    const p = b.path.trim();
    if (!p || branchPaths.has(p)) continue;
    branchPaths.add(p);
    branches.push({ path: p, description: b.description });
    branchSources.llm++;
  }

  for (const p of stackPresetForBranches?.initialBranches ?? []) {
    if (branchPaths.has(p)) continue;
    // Only add if the directory actually exists in the project.
    if (await pathExists(path.join(projectRoot, p))) {
      branchPaths.add(p);
      const hint = stackPresetForBranches.branchHints?.find((h) => h.path === p);
      branches.push({
        path: p,
        description: hint?.description ?? '',
      });
      branchSources.preset++;
    }
  }

  for (const p of input.extraBranches ?? []) {
    const trimmed = p.trim();
    if (!trimmed || branchPaths.has(trimmed)) continue;
    branchPaths.add(trimmed);
    branches.push({ path: trimmed });
    branchSources.flags++;
  }

  // Honest summary of where each branch came from. Avoids the confusing
  // "4 sugeridas" log that was followed by 5 actual branches.
  const summaryParts = [];
  if (branchSources.llm > 0)    summaryParts.push(`${branchSources.llm} del LLM`);
  if (branchSources.preset > 0) summaryParts.push(`${branchSources.preset} del preset ${stackId}`);
  if (branchSources.flags > 0)  summaryParts.push(`${branchSources.flags} de --branch`);
  if (branches.length > 0) {
    log(`✓ ${branches.length} branch(es) iniciales: ${summaryParts.join(', ')}.`);
  }

  // Skills / agents from flags only (LLM suggestions are skipped here —
  // we don't want to surprise the user with new skills they didn't ask for).
  const skills = (input.skills ?? []).map((n) => ({ name: n.trim() })).filter((s) => s.name);
  const agents = (input.agentNames ?? []).map((n) => ({
    name: n.trim(),
    slash: n.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
  })).filter((a) => a.name);

  // Detect conflicts. With --yes we overwrite; without it we preserve.
  // Note: the field is still called `overwriteClaudeMd` for backwards
  // compat, but it covers any agent instructions file (CLAUDE.md,
  // .opencode/AGENTS.md, AGENTS.md) since only one is written per project.
  const conflicts = await detectConflicts(projectRoot);
  const overrides = {
    overwriteClaudeMd: input.yes ? true : !(conflicts.claudeMd || conflicts.agentsMd),
    overwriteConfig:   input.yes ? true : !conflicts.config,
    overwriteTasks:    input.yes ? true : !conflicts.tasks,
  };

  log('Aplicando scaffolding...');
  const result = await writeImport({
    projectRoot,
    name,
    description,
    stackId,
    databaseId,
    model: { provider, name: model },
    agent,
    branches,
    skills,
    agents,
    ...overrides,
  });

  log(`✓ ${result.createdFiles.length} archivo(s) creado(s).`);
  if (result.skippedFiles.length) {
    log(`! ${result.skippedFiles.length} archivo(s) preservado(s) (existían — usá --yes para pisar).`);
  }
  for (const w of result.warnings) {
    log(`⚠ ${w}`);
  }

  return { ...result, analysis };
}
