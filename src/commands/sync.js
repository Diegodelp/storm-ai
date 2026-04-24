/**
 * `storm sync` — reconcile project.config.json with what's actually on
 * disk. Two passes:
 *
 *   1. Discovery: scan the filesystem for directories that match the
 *      stack's branch patterns and contain at least MIN_FILES code
 *      files. Any such directory not yet in config.compact_context.branches
 *      gets registered as a new branch.
 *
 *   2. Stale-marking: branches in config that no longer have any code
 *      on disk are marked with `stale: true`. We never delete entries
 *      automatically because the user might be mid-restructure.
 *
 * Sync is also called automatically by `storm task done` (see tasks.js)
 * unless the project disables it via compact_context.auto_sync = false.
 *
 * Output is a SyncReport that callers can render however they want
 * (the CLI prints a summary, the post-task hook stays quiet).
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { readConfig, writeConfig } from '../core/config.js';
import {
  getStack,
  matchesAnyPattern,
  suggestBranchDescription,
} from '../core/stacks.js';
import { refreshCompactContext } from '../core/compact.js';

const CODE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.tsx',
  '.svelte', '.astro', '.vue',
  '.py', '.rb', '.go', '.rs',
  '.json',
]);

const MIN_FILES_FOR_BRANCH = 1; // ≥1 code file in the dir to count
const MAX_SCAN_DEPTH = 6;

/**
 * @typedef {Object} SyncReport
 * @property {{path: string, description: string}[]} added     New branches registered.
 * @property {{path: string}[]} markedStale                     Branches with no files left.
 * @property {{path: string}[]} clearedStale                    Branches that were stale but now have files.
 * @property {string[]} warnings                                Non-fatal issues.
 */

/**
 * Public entry. Returns a SyncReport.
 *
 * @param {{cwd: string, projectRoot?: string, regenerate?: boolean}} opts
 * @returns {Promise<SyncReport>}
 */
export async function sync(opts) {
  const projectRoot = opts.projectRoot ?? opts.cwd;
  const config = await readConfig(projectRoot);

  /** @type {SyncReport} */
  const report = { added: [], markedStale: [], clearedStale: [], warnings: [] };

  const stack = getStack(config.stackId ?? 'other');
  if (!stack || stack.id === 'other' || stack.branchPatterns.length === 0) {
    report.warnings.push(
      'Stack sin patrones de auto-detección. Solo se chequea staleness ' +
        'de las ramas declaradas.',
    );
  }

  const declaredPaths = new Set(
    (config.compact_context?.branches ?? []).map((b) => b.path),
  );

  // PASS 1 — discovery: walk the project and propose new branches.
  if (stack && stack.branchPatterns.length > 0) {
    const candidates = await findCandidateDirs(projectRoot, stack, config);

    for (const cand of candidates) {
      if (declaredPaths.has(cand.path)) continue; // already known
      const description = suggestBranchDescription(cand.path, stack);
      report.added.push({ path: cand.path, description });
      config.compact_context.branches.push({
        path: cand.path,
        description,
        pinned: [],
      });
    }
  }

  // PASS 2 — stale marking: re-check existing branches.
  for (const branch of config.compact_context?.branches ?? []) {
    const fullPath = path.join(projectRoot, branch.path);
    const codeCount = await countCodeFilesIfDir(fullPath, config);
    const wasStale = branch.stale === true;

    if (codeCount === 0) {
      if (!wasStale) {
        branch.stale = true;
        report.markedStale.push({ path: branch.path });
      }
    } else if (wasStale) {
      delete branch.stale;
      report.clearedStale.push({ path: branch.path });
    }
  }

  // Persist if something changed.
  const dirty =
    report.added.length > 0 ||
    report.markedStale.length > 0 ||
    report.clearedStale.length > 0;

  if (dirty) {
    await writeConfig(projectRoot, config);
    if (opts.regenerate !== false) {
      try {
        await refreshCompactContext(projectRoot, { resetCounter: false });
      } catch (err) {
        report.warnings.push(
          `Falló la regeneración de .context-compact: ${err.message}`,
        );
      }
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Walk the project, returning every directory whose relative path
 * matches one of the stack's branch patterns AND contains ≥ MIN_FILES
 * code files (counting only direct children, not recursive).
 *
 * We respect ignored_paths from the config.
 */
async function findCandidateDirs(projectRoot, stack, config) {
  const ignored = new Set(config.compact_context?.ignored_paths ?? []);
  /** @type {{path: string}[]} */
  const out = [];

  async function walk(absDir, relDir, depth) {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith('.')) continue;
      if (ignored.has(ent.name)) continue;

      const childRel = relDir ? `${relDir}/${ent.name}` : ent.name;
      const childAbs = path.join(absDir, ent.name);

      if (matchesAnyPattern(childRel, stack.branchPatterns)) {
        const codeCount = await countCodeFilesShallow(childAbs);
        if (codeCount >= MIN_FILES_FOR_BRANCH) {
          out.push({ path: childRel });
        }
      }

      // Always recurse — the pattern might match a deeper level.
      await walk(childAbs, childRel, depth + 1);
    }
  }

  await walk(projectRoot, '', 0);
  return out;
}

/**
 * Count code files DIRECTLY inside `dir` (not recursive).
 */
async function countCodeFilesShallow(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (CODE_EXTS.has(path.extname(ent.name).toLowerCase())) count++;
  }
  return count;
}

/**
 * Count code files in `dir` and all its subdirectories. Used to detect
 * staleness — a branch with 0 code files anywhere underneath is stale.
 */
async function countCodeFilesIfDir(dir, config) {
  const ignored = new Set(config.compact_context?.ignored_paths ?? []);
  let s;
  try {
    s = await stat(dir);
  } catch {
    return 0;
  }
  if (!s.isDirectory()) return 0;

  let total = 0;
  async function walk(d, depth) {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      if (ignored.has(ent.name)) continue;
      const p = path.join(d, ent.name);
      if (ent.isFile()) {
        if (CODE_EXTS.has(path.extname(ent.name).toLowerCase())) total++;
      } else if (ent.isDirectory()) {
        await walk(p, depth + 1);
      }
    }
  }
  await walk(dir, 0);
  return total;
}
