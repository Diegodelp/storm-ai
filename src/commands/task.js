/**
 * `storm task` — CRUD over tasks.
 *
 * Sub-actions: add, start, done, cancel, list, note.
 *
 * Each is a pure function that takes the project root and action-specific
 * inputs, returns a result. The CLI layer handles parsing argv and
 * printing output.
 */

import {
  addTask as coreAddTask,
  setStatus,
  addNote as coreAddNote,
  listTasks as coreListTasks,
  readState,
} from '../core/tasks.js';
import { requireProjectRoot } from '../core/paths.js';

/**
 * @typedef {Object} AddInput
 * @property {string} cwd
 * @property {string} title
 * @property {string} [description]
 * @property {string[]} [branches]
 */

/**
 * @typedef {Object} StatusInput
 * @property {string} cwd
 * @property {string} id
 */

/**
 * @typedef {Object} NoteInput
 * @property {string} cwd
 * @property {string} id
 * @property {string} content
 */

/**
 * @typedef {Object} ListInput
 * @property {string} cwd
 * @property {string} [status]
 * @property {string} [branch]
 */

/**
 * @param {AddInput} input
 */
export async function add(input) {
  const root = await requireProjectRoot(input.cwd);
  const task = await coreAddTask(root, {
    title: input.title,
    description: input.description,
    branches: input.branches,
  });
  return { projectRoot: root, task };
}

/**
 * @param {StatusInput} input
 */
export async function start(input) {
  return transition(input, 'in_progress');
}

/**
 * @param {StatusInput} input
 */
export async function done(input) {
  const res = await transition(input, 'done');

  // Auto-sync after marking done: pick up any new directories the AI
  // (or the user) created while working on this task. Best-effort —
  // failures are surfaced as a warning but don't fail the task transition.
  // Disabled by setting compact_context.auto_sync = false in the config.
  try {
    const { readConfig } = await import('../core/config.js');
    const config = await readConfig(res.projectRoot);
    const autoSync = config.compact_context?.auto_sync ?? true;

    if (autoSync) {
      const { sync } = await import('./sync.js');
      // Skip the .context-compact regeneration — `storm refresh` will
      // do that when the user explicitly asks (or when shouldRefresh
      // triggers below).
      const report = await sync({
        cwd: res.projectRoot,
        projectRoot: res.projectRoot,
        regenerate: false,
      });
      res.sync = report;
    }
  } catch (err) {
    res.syncError = err?.message ?? String(err);
  }

  return res;
}

/**
 * @param {StatusInput} input
 */
export async function cancel(input) {
  return transition(input, 'cancelled');
}

/**
 * @param {NoteInput} input
 */
export async function note(input) {
  if (!input.content?.trim()) {
    throw new Error('Note content is required.');
  }
  const root = await requireProjectRoot(input.cwd);
  await coreAddNote(root, input.id, input.content);
  return { projectRoot: root, id: input.id };
}

/**
 * @param {ListInput} input
 */
export async function list(input) {
  const root = await requireProjectRoot(input.cwd);
  const tasks = await coreListTasks(root, {
    status: input.status,
    branch: input.branch,
  });
  const state = await readState(root);
  return {
    projectRoot: root,
    tasks,
    counters: state.counters,
    totalCount: state.tasks.length,
  };
}

// ---------------------------------------------------------------------------

async function transition(input, target) {
  const root = await requireProjectRoot(input.cwd);
  const { task, shouldRefresh } = await setStatus(root, input.id, target);
  return { projectRoot: root, task, shouldRefresh };
}
