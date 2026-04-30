/**
 * `storm refresh` — regenerate .context-compact/ from current source files.
 *
 * The heavy lifting is in core/compact.js. This module:
 *   - locates the project,
 *   - reads config to know the declared branches and tunables,
 *   - reads tasks to feed the task-activity signal,
 *   - calls refreshCompactContext,
 *   - resets the "done_since_refresh" counter on success.
 */

import { requireProjectRoot } from '../core/paths.js';
import { readConfig } from '../core/config.js';
import { readState, markRefreshed } from '../core/tasks.js';
import { refreshCompactContext } from '../core/compact.js';

/**
 * @typedef {Object} RefreshInput
 * @property {string} cwd
 */

/**
 * @typedef {Object} RefreshResult
 * @property {string} projectRoot
 * @property {number} filesScanned
 * @property {number} branchesWritten
 * @property {number} unassignedCount
 * @property {string[]} warnings
 * @property {number} counterBefore
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

  const result = await refreshCompactContext(root, {
    branches: config.compact_context.branches,
    mapFilesPerBranch: config.compact_context.map_files_per_branch,
    ignoredPaths: config.compact_context.ignored_paths ?? [],
    tasks: state.tasks,
  });

  // Reset the counter AFTER the refresh succeeds. If refresh throws,
  // the counter stays high and the user will be prompted again.
  await markRefreshed(root);

  return {
    projectRoot: root,
    filesScanned: result.filesScanned,
    branchesWritten: result.branchesWritten,
    unassignedCount: result.unassignedCount,
    warnings: result.warnings,
    counterBefore,
  };
}
