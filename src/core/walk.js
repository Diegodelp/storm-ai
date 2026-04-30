/**
 * Directory walker for the compact-context refresh.
 *
 * Three sources of "ignore" combine:
 *   1. IGNORED_DIRS / IGNORED_FILES (hard-coded basenames, always skipped).
 *   2. extraIgnoredDirs (from compact_context.ignored_paths).
 *   3. .gitignore patterns at the project root (best-effort: simple
 *      patterns only — no `**`, no negations, no nested .gitignores).
 *
 * Caps:
 *   - depth ≤ MAX_WALK_DEPTH (catches symlink loops)
 *   - files scanned ≤ MAX_FILES_SCANNED (catches "I forgot to ignore X")
 *
 * This module has zero deps beyond Node's stdlib so it can be loaded
 * (and tested) in isolation from the babel-based parser.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

// Dirs we ALWAYS skip, no matter what.
export const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'coverage',
  '.turbo',
  '.vercel',
  '.cache',
  '.context-compact',
  '.claude',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'vendor',
  'target',
  'bin',
  'obj',
]);

export const IGNORED_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.DS_Store',
  'Thumbs.db',
]);

/** Hard cap on directory recursion depth. Catches symlink loops. */
export const MAX_WALK_DEPTH = 12;

/** Hard cap on number of files to scan. */
export const MAX_FILES_SCANNED = 5000;

/**
 * Walk the project tree collecting paths to summarize.
 *
 * @param {string} root
 * @param {{extraIgnoredDirs?: string[]}} [options]
 * @returns {Promise<{files: string[], warnings: string[]}>}
 */
export async function walkProject(root, options = {}) {
  /** @type {string[]} */
  const result = [];
  /** @type {string[]} */
  const warnings = [];

  // Compose the full set of ignored dir basenames.
  const allIgnoredDirs = new Set(IGNORED_DIRS);
  for (const p of options.extraIgnoredDirs ?? []) {
    const base = p.replace(/[\\/]/g, '/').split('/').pop();
    if (base) allIgnoredDirs.add(base);
  }

  const gitignoreMatcher = await loadGitignoreMatcher(root);

  let scanned = 0;
  let aborted = false;

  async function walk(dir, depth) {
    if (aborted) return;
    if (depth > MAX_WALK_DEPTH) {
      warnings.push(`Ignoré ${path.relative(root, dir)} (profundidad > ${MAX_WALK_DEPTH}).`);
      return;
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (aborted) return;

      // Always skip dotfiles/dotdirs (tooling, config).
      if (entry.name.startsWith('.')) continue;

      if (entry.isDirectory()) {
        if (allIgnoredDirs.has(entry.name)) continue;

        const relDir = path
          .relative(root, path.join(dir, entry.name))
          .replace(/\\/g, '/');
        if (gitignoreMatcher.matchesDir(relDir)) continue;

        await walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        if (IGNORED_FILES.has(entry.name)) continue;

        const absPath = path.join(dir, entry.name);
        const relPath = path.relative(root, absPath).replace(/\\/g, '/');
        if (gitignoreMatcher.matchesFile(relPath)) continue;

        result.push(absPath);
        scanned++;

        if (scanned >= MAX_FILES_SCANNED) {
          warnings.push(
            `Alcancé el límite de ${MAX_FILES_SCANNED} archivos. ` +
              'Sumá patrones a compact_context.ignored_paths o .gitignore para reducir el set.',
          );
          aborted = true;
          return;
        }
      }
    }
  }

  await walk(root, 0);
  return { files: result, warnings };
}

// ---------------------------------------------------------------------------
// Internal: tiny .gitignore matcher.
//
// Supported syntax (90% of real-world cases):
//   - blank lines and `#` comments are skipped
//   - trailing `/` means "directory only"
//   - leading `/` anchors the pattern to the project root
//   - `*` matches anything except `/`
//   - exact basenames match anywhere (e.g. `node_modules`)
//
// NOT supported (we err on the side of NOT ignoring real source):
//   - `**` recursive globs
//   - `!` negations
//   - nested .gitignores
// ---------------------------------------------------------------------------

async function loadGitignoreMatcher(root) {
  const gitignorePath = path.join(root, '.gitignore');
  let raw;
  try {
    raw = await readFile(gitignorePath, 'utf8');
  } catch {
    return { matchesFile: () => false, matchesDir: () => false };
  }

  /** @type {Array<{regex: RegExp, dirOnly: boolean, anchored: boolean}>} */
  const rules = [];

  for (let line of raw.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) continue; // skip negations silently

    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);

    const anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);

    const escaped = line
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*');

    const regex = anchored
      ? new RegExp('^' + escaped + '$')
      : new RegExp('(?:^|/)' + escaped + '$');

    rules.push({ regex, dirOnly, anchored });
  }

  if (rules.length === 0) {
    return { matchesFile: () => false, matchesDir: () => false };
  }

  return {
    matchesFile(relPath) {
      for (const r of rules) {
        if (r.dirOnly) continue;
        if (r.regex.test(relPath)) return true;
        if (!r.anchored && r.regex.test(path.basename(relPath))) return true;
      }
      return false;
    },
    matchesDir(relPath) {
      for (const r of rules) {
        if (r.regex.test(relPath)) return true;
        if (!r.anchored && r.regex.test(path.basename(relPath))) return true;
      }
      return false;
    },
  };
}
