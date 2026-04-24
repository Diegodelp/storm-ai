/**
 * `storm branch` — manage declared branches in project.config.json.
 *
 * Sub-actions: add, remove, list, pin, unpin.
 *
 * All mutations trigger a compact-context refresh implicitly, because
 * changing branches invalidates the existing .md files.
 */

import { requireProjectRoot } from '../core/paths.js';
import { readConfig, writeConfig } from '../core/config.js';
import { readState, writeState } from '../core/tasks.js';
import { refreshCompactContext } from '../core/compact.js';

/**
 * @param {{cwd:string, path:string, description?:string}} input
 */
export async function add(input) {
  const root = await requireProjectRoot(input.cwd);
  const config = await readConfig(root);

  const normalized = input.path.replaceAll('\\', '/').replace(/\/+$/, '');
  if (!normalized) throw new Error('Branch path is required.');

  const exists = config.compact_context.branches.some((b) => b.path === normalized);
  if (exists) {
    throw new Error(`Branch "${normalized}" already exists.`);
  }

  config.compact_context.branches.push({
    path: normalized,
    description: input.description ?? '',
    pinned: [],
  });
  await writeConfig(root, config);

  // Keep the tasks' branches_index in sync so new tasks can reference it.
  const state = await readState(root);
  state.branches_index = config.compact_context.branches.map((b) => b.path);
  await writeState(root, state);

  const refresh = await refreshCompactContext(root, {
    branches: config.compact_context.branches,
    mapFilesPerBranch: config.compact_context.map_files_per_branch,
    tasks: state.tasks,
  });

  return { projectRoot: root, branch: normalized, refresh };
}

/**
 * @param {{cwd:string, path:string}} input
 */
export async function remove(input) {
  const root = await requireProjectRoot(input.cwd);
  const config = await readConfig(root);

  const normalized = input.path.replaceAll('\\', '/').replace(/\/+$/, '');
  const before = config.compact_context.branches.length;
  config.compact_context.branches = config.compact_context.branches.filter(
    (b) => b.path !== normalized,
  );
  if (config.compact_context.branches.length === before) {
    throw new Error(`Branch "${normalized}" not found.`);
  }
  await writeConfig(root, config);

  // Any tasks that referenced this branch now have a dangling reference;
  // we don't auto-rewrite them, but we warn.
  const state = await readState(root);
  const affected = state.tasks.filter((t) => (t.branches ?? []).includes(normalized));
  state.branches_index = config.compact_context.branches.map((b) => b.path);
  await writeState(root, state);

  const warnings = [];
  if (affected.length > 0) {
    warnings.push(
      `${affected.length} task(s) still reference the removed branch "${normalized}": ${affected
        .map((t) => t.id)
        .join(', ')}. Edit them manually or via \`storm task edit\`.`,
    );
  }

  const refresh = await refreshCompactContext(root, {
    branches: config.compact_context.branches,
    mapFilesPerBranch: config.compact_context.map_files_per_branch,
    tasks: state.tasks,
  });

  return { projectRoot: root, branch: normalized, warnings, refresh };
}

/**
 * @param {{cwd:string}} input
 */
export async function list(input) {
  const root = await requireProjectRoot(input.cwd);
  const config = await readConfig(root);
  return {
    projectRoot: root,
    branches: config.compact_context.branches,
  };
}

/**
 * @param {{cwd:string, path:string, files:string[]}} input
 */
export async function pin(input) {
  const root = await requireProjectRoot(input.cwd);
  const config = await readConfig(root);
  const normalized = input.path.replaceAll('\\', '/').replace(/\/+$/, '');
  const branch = config.compact_context.branches.find((b) => b.path === normalized);
  if (!branch) throw new Error(`Branch "${normalized}" not found.`);

  const set = new Set(branch.pinned ?? []);
  for (const f of input.files) set.add(f);
  branch.pinned = [...set];
  await writeConfig(root, config);

  const state = await readState(root);
  const refresh = await refreshCompactContext(root, {
    branches: config.compact_context.branches,
    mapFilesPerBranch: config.compact_context.map_files_per_branch,
    tasks: state.tasks,
  });

  return { projectRoot: root, branch: normalized, pinned: branch.pinned, refresh };
}

/**
 * @param {{cwd:string, path:string, files:string[]}} input
 */
export async function unpin(input) {
  const root = await requireProjectRoot(input.cwd);
  const config = await readConfig(root);
  const normalized = input.path.replaceAll('\\', '/').replace(/\/+$/, '');
  const branch = config.compact_context.branches.find((b) => b.path === normalized);
  if (!branch) throw new Error(`Branch "${normalized}" not found.`);

  const toRemove = new Set(input.files);
  branch.pinned = (branch.pinned ?? []).filter((f) => !toRemove.has(f));
  await writeConfig(root, config);

  const state = await readState(root);
  const refresh = await refreshCompactContext(root, {
    branches: config.compact_context.branches,
    mapFilesPerBranch: config.compact_context.map_files_per_branch,
    tasks: state.tasks,
  });

  return { projectRoot: root, branch: normalized, pinned: branch.pinned, refresh };
}
