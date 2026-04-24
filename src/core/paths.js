/**
 * Path helpers.
 *
 * The CLI is run from arbitrary cwd. These helpers let commands locate
 * the current storm project (walking up from cwd) and compute canonical
 * locations of config, state, and compact files.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';

const MARKER = 'project.config.json';

/**
 * Walk up from `startDir` looking for a project.config.json. Returns the
 * project root or null if not found.
 *
 * @param {string} startDir
 * @returns {Promise<string|null>}
 */
export async function findProjectRoot(startDir) {
  let dir = path.resolve(startDir);
  // Safety cap: no filesystem should have >64 levels, but cap anyway.
  for (let i = 0; i < 64; i++) {
    if (await fileExists(path.join(dir, MARKER))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached fs root
    dir = parent;
  }
  return null;
}

/**
 * Same as findProjectRoot but throws a friendly error if not found.
 * @param {string} startDir
 * @returns {Promise<string>}
 */
export async function requireProjectRoot(startDir) {
  const root = await findProjectRoot(startDir);
  if (!root) {
    throw new Error(
      `Not inside a storm project. No ${MARKER} found in ${startDir} or any parent. ` +
        `Run 'storm new' to create one.`,
    );
  }
  return root;
}

/**
 * @param {string} p
 * @returns {Promise<boolean>}
 */
export async function fileExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitize a user-provided name into a safe directory/file name.
 * Same rules as the PS1 version: lowercase, dashes, no path separators,
 * no reserved Windows names, trimmed to 60 chars.
 *
 * @param {string} name
 * @returns {string}
 */
export function safeName(name) {
  if (!name) return 'untitled';
  let n = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\-_ ]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!n) n = 'untitled';
  // Windows reserved names — collision avoidance.
  const reserved = new Set([
    'con', 'prn', 'aux', 'nul',
    'com1','com2','com3','com4','com5','com6','com7','com8','com9',
    'lpt1','lpt2','lpt3','lpt4','lpt5','lpt6','lpt7','lpt8','lpt9',
  ]);
  if (reserved.has(n)) n = `${n}-app`;
  if (n.length > 60) n = n.slice(0, 60).replace(/-+$/, '');
  return n;
}

/**
 * Convenience: absolute paths for well-known files inside a project.
 * Using these instead of string concatenation makes the codebase easier
 * to grep when we need to move things.
 */
export const projectPaths = {
  config: (root) => path.join(root, 'project.config.json'),
  tasksMd: (root) => path.join(root, 'TASKS.md'),
  claudeMd: (root) => path.join(root, 'CLAUDE.md'),
  compactDir: (root) => path.join(root, '.context-compact'),
  taskState: (root) => path.join(root, '.context-compact', 'task-state.json'),
  projectMap: (root) => path.join(root, '.context-compact', 'project-map.md'),
  branchMd: (root, branchPath) =>
    path.join(root, '.context-compact', branchPath.replaceAll('/', '-') + '.md'),
  claudeCommands: (root) => path.join(root, '.claude', 'commands'),
  claudeSkills: (root) => path.join(root, '.claude', 'skills'),
  claudeAgents: (root) => path.join(root, '.claude', 'agents'),
};
