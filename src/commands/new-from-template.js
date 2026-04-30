/**
 * `storm new --template <id>` orchestration.
 *
 * Pipeline:
 *   1. Resolve template entry from registry.
 *   2. Clone template repo into a temp directory.
 *   3. Read its storm-template.json metadata.
 *   4. (UI layer prompts the user for variable values.)
 *   5. applyTemplate() — substitute variables, copy template/ + .storm/.
 *   6. Patch project.config.json with the user's project name.
 *   7. Patch task-state.json with initialTasks from the template metadata.
 *   8. Run postInstall commands.
 *   9. Cleanup temp clone.
 *
 * UI layer (wizard-new.js) drives the user prompts; this module is
 * pure orchestration.
 */

import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  cloneTemplate,
  readTemplateMetadata,
  applyTemplate,
  runPostInstall,
} from '../core/templates.js';
import { readConfig, writeConfig } from '../core/config.js';
import { projectPaths, safeName, fileExists } from '../core/paths.js';

/**
 * @typedef {Object} TemplateApplyInput
 * @property {string} projectName             Final project name (slug).
 * @property {string} parentDir               Where to create the project folder.
 * @property {string} repo                    e.g. "Diegodelp/storm-template-nextjs-saas"
 * @property {string} [ref]                   git ref (default "main")
 * @property {Record<string, string>} [variables]   Substitution map (excl. PROJECT_NAME).
 * @property {boolean} [skipPostInstall]      Skip running postInstall commands.
 * @property {boolean} [force]                Overwrite if the target dir exists.
 */

/**
 * @typedef {Object} TemplateApplyResult
 * @property {string} projectRoot
 * @property {string} safeName
 * @property {import('../core/templates.js').TemplateMetadata} metadata
 * @property {number} filesWritten
 * @property {string[]} filesSkipped
 * @property {string[]} warnings
 * @property {{ok: boolean, completed: number, failedAt?: string, message?: string}} [postInstall]
 */

/**
 * Stage 1 of the template flow: clone the repo and read its metadata.
 * The UI uses this to know what variables to ask the user for.
 *
 * @param {{repo: string, ref?: string}} input
 * @returns {Promise<{cloneDir: string, metadata: import('../core/templates.js').TemplateMetadata, cleanup: () => Promise<void>}>}
 */
export async function fetchTemplate({ repo, ref }) {
  const cloneDir = await mkdtemp(path.join(tmpdir(), 'storm-template-'));

  // mkdtemp creates the dir; git clone needs it to NOT exist. Remove it.
  await rm(cloneDir, { recursive: true, force: true });

  const result = await cloneTemplate({ repo, ref, dest: cloneDir });
  if (!result.ok) {
    throw new Error(
      `No pude clonar ${repo}: ${result.message}. ` +
        `Verificá que el repo exista y que tengas git instalado.`,
    );
  }

  const metadata = await readTemplateMetadata(cloneDir);

  return {
    cloneDir,
    metadata,
    cleanup: async () => {
      try {
        await rm(cloneDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

/**
 * Stage 2 of the template flow: apply the cloned template to the
 * destination project directory.
 *
 * @param {TemplateApplyInput & {cloneDir: string, metadata: import('../core/templates.js').TemplateMetadata}} input
 * @returns {Promise<TemplateApplyResult>}
 */
export async function applyTemplateToProject(input) {
  if (!input.projectName?.trim()) {
    throw new Error('Project name is required.');
  }
  if (!input.parentDir) {
    throw new Error('parentDir is required.');
  }

  const slug = safeName(input.projectName);
  const projectRoot = path.resolve(input.parentDir, slug);

  if (!input.force && (await fileExists(projectRoot))) {
    throw new Error(
      `Directory already exists: ${projectRoot}. Pass force:true to overwrite, or choose another name.`,
    );
  }

  /** @type {string[]} */
  const warnings = [];

  // Always include PROJECT_NAME in the substitution map.
  const variables = {
    ...(input.variables ?? {}),
    PROJECT_NAME: slug,
    PROJECT_NAME_TITLE: titleCase(slug),
  };

  // Copy the template into projectRoot.
  const apply = await applyTemplate({
    cloneDir: input.cloneDir,
    projectRoot,
    variables,
  });

  // Patch project.config.json: replace name with the user's input,
  // ensure model field exists if not in the template.
  await patchProjectConfig(projectRoot, slug, input.metadata, warnings);

  // Patch task-state.json with initialTasks from metadata.
  await patchTaskState(projectRoot, slug, input.metadata.initialTasks ?? [], warnings);

  // Run postInstall.
  /** @type {TemplateApplyResult['postInstall']} */
  let postInstall;
  if (!input.skipPostInstall && input.metadata.postInstall?.length) {
    postInstall = await runPostInstall({
      projectRoot,
      commands: input.metadata.postInstall,
    });
    if (!postInstall.ok) {
      warnings.push(
        `Falló "${postInstall.failedAt}". Podés ejecutarlo a mano dentro del proyecto.`,
      );
    }
  }

  return {
    projectRoot,
    safeName: slug,
    metadata: input.metadata,
    filesWritten: apply.filesWritten,
    filesSkipped: apply.filesSkipped,
    warnings,
    postInstall,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function patchProjectConfig(projectRoot, slug, metadata, warnings) {
  const configPath = path.join(projectRoot, 'project.config.json');
  if (!(await pathExists(configPath))) {
    warnings.push(
      'El template no incluyó project.config.json. Storm puede que no funcione correctamente; ' +
        'considerá registrar un issue al autor del template.',
    );
    return;
  }

  try {
    const config = await readConfig(projectRoot);
    config.name = slug;
    if (!config.stackId && metadata.stackId) config.stackId = metadata.stackId;
    if (!config.databaseId && metadata.databaseId) config.databaseId = metadata.databaseId;
    await writeConfig(projectRoot, config);
  } catch (err) {
    warnings.push(`No pude actualizar project.config.json: ${err.message}`);
  }
}

async function patchTaskState(projectRoot, slug, initialTasks, warnings) {
  const stateFile = path.join(projectPaths.compactDir(projectRoot), 'task-state.json');
  if (!(await pathExists(stateFile))) {
    warnings.push(
      'El template no incluyó .context-compact/task-state.json. ' +
        'Las tareas iniciales no se cargaron.',
    );
    return;
  }

  try {
    const raw = await readFile(stateFile, 'utf8');
    const state = JSON.parse(raw);

    state.project = state.project ?? {};
    state.project.name = slug;
    state.project.created_at = state.project.created_at ?? new Date().toISOString();

    state.tasks = Array.isArray(state.tasks) ? state.tasks : [];

    // Append initial tasks. Each gets a sequential id.
    let nextId = state.tasks.length + 1;
    const now = new Date().toISOString();
    for (const t of initialTasks) {
      state.tasks.push({
        id: `t${nextId++}`,
        title: t.title,
        description: t.description ?? '',
        status: 'pending',
        branches: Array.isArray(t.branches) ? t.branches : [],
        created_at: now,
        updated_at: now,
        completed_at: null,
        notes: [],
      });
    }

    await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch (err) {
    warnings.push(`No pude inicializar task-state.json: ${err.message}`);
  }
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function titleCase(slug) {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}
