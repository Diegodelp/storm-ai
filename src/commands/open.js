/**
 * `storm open` — list projects discovered under a set of search paths
 * and launch Claude Code in the chosen one.
 *
 * "Launch Claude Code" here just means: we return the command the CLI
 * should execute. The actual spawn lives in the CLI layer (so we can
 * test open() without launching real processes).
 */

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { findProjectRoot, projectPaths, fileExists } from '../core/paths.js';

/**
 * Default directories to scan for storm projects. Users can override
 * via the `searchPaths` input.
 */
export function defaultSearchPaths() {
  const home = homedir();
  // These are the common places people keep code. We don't scan the
  // entire home dir (too slow, too noisy).
  return [
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'Projects'),
    path.join(home, 'code'),
    path.join(home, 'dev'),
  ];
}

/**
 * @typedef {Object} DiscoveredProject
 * @property {string} name           From project.config.json.
 * @property {string} description
 * @property {string} root           Absolute path.
 */

/**
 * Discover projects by scanning one level deep into each search path.
 * Deeper scans are intentionally avoided — if the user nests projects
 * inside projects, that's their problem.
 *
 * @param {{searchPaths?: string[]}} input
 * @returns {Promise<DiscoveredProject[]>}
 */
export async function discover(input = {}) {
  const searchPaths = input.searchPaths ?? defaultSearchPaths();
  /** @type {DiscoveredProject[]} */
  const found = [];

  for (const sp of searchPaths) {
    if (!(await fileExists(sp))) continue;

    let entries;
    try {
      entries = await readdir(sp, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;

      const candidate = path.join(sp, entry.name);
      const marker = projectPaths.config(candidate);
      if (!(await fileExists(marker))) continue;

      try {
        const raw = await readFile(marker, 'utf8');
        const json = JSON.parse(raw);
        if (json.name) {
          found.push({
            name: json.name,
            description: json.description ?? '',
            root: candidate,
          });
        }
      } catch {
        // Broken config: skip silently. `storm refresh` inside the
        // project will surface the error.
      }
    }
  }

  // Deduplicate by root (same project could be found via multiple search paths).
  const byRoot = new Map();
  for (const p of found) byRoot.set(p.root, p);
  return [...byRoot.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve a project by exact root path or by name.
 *
 * @param {{cwd:string, target:string}} input
 * @returns {Promise<string>}   Absolute project root.
 */
export async function resolveTarget(input) {
  // 1. If `target` is a path that resolves to a project, use it.
  const asPath = path.resolve(input.cwd, input.target);
  const asRoot = await findProjectRoot(asPath);
  if (asRoot) return asRoot;

  // 2. Otherwise search known paths for a project with that name.
  const discovered = await discover({});
  const match = discovered.find(
    (p) => p.name === input.target || p.root.endsWith(path.sep + input.target),
  );
  if (match) return match.root;

  throw new Error(
    `No project matches "${input.target}". Use \`storm open\` without arguments to list available projects.`,
  );
}
