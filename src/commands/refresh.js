/**
 * `storm refresh` — regenerate .context-compact/ from current source files.
 *
 * The heavy lifting is in core/compact.js. This module:
 *   - locates the project,
 *   - reads config to know the declared branches and tunables,
 *   - reads tasks to feed the task-activity signal,
 *   - classifies new/modified functions with the default provider (the
 *     function index, see core/functions.js); only what changed is sent,
 *   - calls refreshCompactContext,
 *   - resets the "done_since_refresh" counter on success.
 */

import { requireProjectRoot } from '../core/paths.js';
import { readConfig } from '../core/config.js';
import { readState, markRefreshed } from '../core/tasks.js';
import { refreshCompactContext } from '../core/compact.js';
import { getDefaultProvider } from '../core/global-config.js';
import { makeLlmClassifier } from '../core/function-classifier.js';

/**
 * @typedef {Object} RefreshInput
 * @property {string} cwd
 * @property {boolean} [llm]        false = don't call the LLM (default true).
 * @property {(done: number, total: number) => void} [onProgress]
 * @property {import('../core/functions.js').FunctionClassifier} [classifier]
 *   Override (tests).
 */

/**
 * @typedef {Object} RefreshResult
 * @property {string} projectRoot
 * @property {number} filesScanned
 * @property {number} branchesWritten
 * @property {number} unassignedCount
 * @property {string[]} warnings
 * @property {number} counterBefore
 * @property {import('../core/compact.js').RefreshResult['functions']} functions
 */

/**
 * @param {RefreshInput} input
 * @returns {Promise<RefreshResult>}
 */
export async function refresh(input) {
  const root = await requireProjectRoot(input.cwd);
  const config = await readConfig(root);
  const state = await readState(root);

  const counterBefore = state.counters.done_since_refresh;

  const warnings = [];
  let classifier = input.classifier ?? null;
  if (!classifier && input.llm !== false) {
    const def = await getDefaultProvider();
    if (def) {
      classifier = makeLlmClassifier({
        provider: def.provider,
        model: def.model,
        language: config.compact_context.function_language ?? 'es',
        onProgress: input.onProgress,
      });
    } else {
      warnings.push(
        'Sin provider por defecto: las funciones nuevas se clasificaron solo por ruta. ' +
          'Configurá uno con `storm config` para que la IA las ordene por sección.',
      );
    }
  }

  const result = await refreshCompactContext(root, {
    branches: config.compact_context.branches,
    mapFilesPerBranch: config.compact_context.map_files_per_branch,
    ignoredPaths: config.compact_context.ignored_paths ?? [],
    tasks: state.tasks,
    classifier,
  });

  // Reset the counter AFTER the refresh succeeds. If refresh throws,
  // the counter stays high and the user will be prompted again.
  await markRefreshed(root);

  return {
    projectRoot: root,
    filesScanned: result.filesScanned,
    branchesWritten: result.branchesWritten,
    unassignedCount: result.unassignedCount,
    warnings: [...warnings, ...result.warnings],
    counterBefore,
    functions: result.functions,
  };
}
