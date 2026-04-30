/**
 * Compact-context generator.
 *
 * Reads the project, classifies files into branches (declared in
 * project.config.json), ranks them using a deterministic heuristic, and
 * writes:
 *   - .context-compact/project-map.md    (the always-load index)
 *   - .context-compact/<branch>.md        (one per branch, detailed)
 *
 * Ranking is 100% deterministic — no LLM, no timestamps in the scoring,
 * same inputs produce the same output. This matters because the output
 * lives in git and we don't want refreshes to produce diff noise when
 * the code hasn't changed.
 *
 * Four signals feed the score:
 *   1. fan_in       — how many other files in the project import this one.
 *   2. is_barrel    — files named index.{js,ts,jsx,tsx} get a flat boost.
 *   3. export_count — total public exports.
 *   4. task_activity — at branch level, for the "Recent activity" section
 *                     (does not reorder files within a branch).
 *
 * Pinned files (config.compact_context.branches[n].pinned) always come
 * first, in the order declared. The heuristic fills the rest.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

import { summarizeFile } from './parser.js';
import { walkProject } from './walk.js';

const COMPACT_DIR = '.context-compact';
const MAP_FILE = 'project-map.md';
const UNASSIGNED_BRANCH = '_unassigned';
const DEFAULT_MAP_FILES_PER_BRANCH = 10;

/**
 * @typedef {Object} BranchConfig
 * @property {string} path
 * @property {string} [description]
 * @property {string[]} [pinned]
 */

/**
 * @typedef {Object} RefreshResult
 * @property {number} branchesWritten
 * @property {number} filesScanned
 * @property {number} unassignedCount
 * @property {string[]} warnings
 */

/**
 * Regenerate the entire .context-compact/ directory.
 *
 * @param {string} projectRoot
 * @param {Object} options
 * @param {BranchConfig[]} options.branches
 * @param {number} [options.mapFilesPerBranch]
 * @param {import('./tasks.js').Task[]} [options.tasks]
 * @param {string[]} [options.ignoredPaths]   Extra dir basenames to skip
 *                                            (typically from compact_context.ignored_paths).
 * @returns {Promise<RefreshResult>}
 */
export async function refreshCompactContext(projectRoot, options) {
  const branches = options.branches ?? [];
  const mapFilesPerBranch = options.mapFilesPerBranch ?? DEFAULT_MAP_FILES_PER_BRANCH;
  const tasks = options.tasks ?? [];
  const extraIgnoredDirs = options.ignoredPaths ?? [];
  /** @type {string[]} */
  const warnings = [];

  // 1. Walk + summarize every file.
  const walkResult = await walkProject(projectRoot, { extraIgnoredDirs });
  for (const w of walkResult.warnings) warnings.push(w);
  const summaries = await Promise.all(
    walkResult.files.map((absPath) => summarizeFile(absPath, projectRoot)),
  );

  // 2. Classify files into branches (most-specific wins).
  const branchPaths = branches.map((b) => normalizeBranchPath(b.path));
  /** @type {Map<string, Array<import('./parser.js').FileSummary>>} */
  const byBranch = new Map();
  for (const bp of branchPaths) byBranch.set(bp, []);
  byBranch.set(UNASSIGNED_BRANCH, []);

  for (const summary of summaries) {
    const branch = classifyFile(summary.relativePath, branchPaths);
    if (branch) byBranch.get(branch).push(summary);
    else byBranch.get(UNASSIGNED_BRANCH).push(summary);
  }

  // 3. Fan-in and task-activity signals.
  const fanIn = computeFanIn(summaries);
  const taskActivity = computeTaskActivity(tasks);

  // 4. Rank within each branch and write branch files.
  await mkdir(path.join(projectRoot, COMPACT_DIR), { recursive: true });

  const branchReports = [];
  for (const branchConfig of branches) {
    const bp = normalizeBranchPath(branchConfig.path);
    const files = byBranch.get(bp) ?? [];
    const ranked = rankFiles(files, {
      pinned: branchConfig.pinned ?? [],
      branchPath: bp,
      fanIn,
      taskActivity,
    });

    const branchTasks = tasks.filter((t) => (t.branches ?? []).includes(bp));
    await writeBranchMd(projectRoot, bp, {
      description: branchConfig.description ?? '',
      files: ranked,
      tasks: branchTasks,
      allBranches: branches,
    });

    branchReports.push({
      path: bp,
      description: branchConfig.description ?? '',
      fileCount: files.length,
      topFiles: ranked.slice(0, mapFilesPerBranch),
      remaining: Math.max(0, ranked.length - mapFilesPerBranch),
      tasks: branchTasks,
    });
  }

  // 5. Unassigned files (still written for visibility).
  const unassigned = byBranch.get(UNASSIGNED_BRANCH) ?? [];
  if (unassigned.length > 0) {
    const ranked = rankFiles(unassigned, {
      pinned: [],
      branchPath: UNASSIGNED_BRANCH,
      fanIn,
      taskActivity,
    });
    await writeBranchMd(projectRoot, UNASSIGNED_BRANCH, {
      description:
        'Files that do not belong to any declared branch. Consider adding a branch for them in project.config.json.',
      files: ranked,
      tasks: [],
      allBranches: branches,
    });
    branchReports.push({
      path: UNASSIGNED_BRANCH,
      description: 'Unassigned files.',
      fileCount: unassigned.length,
      topFiles: ranked.slice(0, mapFilesPerBranch),
      remaining: Math.max(0, ranked.length - mapFilesPerBranch),
      tasks: [],
    });
    warnings.push(
      `Found ${unassigned.length} file(s) outside declared branches. ` +
        `See ${path.join(COMPACT_DIR, UNASSIGNED_BRANCH + '.md')}.`,
    );
  }

  // 6. Write the map.
  await writeProjectMap(projectRoot, {
    branchReports,
    mapFilesPerBranch,
    activeTasksCount: tasks.filter((t) => t.status === 'in_progress').length,
  });

  // 7. Surface parse errors as non-fatal warnings.
  const parseFailures = summaries.filter((s) => s.parseError);
  if (parseFailures.length > 0) {
    warnings.push(
      `${parseFailures.length} file(s) failed to parse ` +
        `(exports may be missing): ${parseFailures
          .slice(0, 3)
          .map((s) => s.relativePath)
          .join(', ')}${parseFailures.length > 3 ? ', ...' : ''}`,
    );
  }

  return {
    branchesWritten: branches.length + (unassigned.length > 0 ? 1 : 0),
    filesScanned: summaries.length,
    unassignedCount: unassigned.length,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function normalizeBranchPath(p) {
  return p.replaceAll('\\', '/').replace(/\/+$/, '');
}

/**
 * @param {string} relativePath
 * @param {string[]} branchPaths
 * @returns {string|null}
 */
function classifyFile(relativePath, branchPaths) {
  let best = null;
  for (const bp of branchPaths) {
    if (relativePath === bp || relativePath.startsWith(bp + '/')) {
      if (best === null || bp.length > best.length) best = bp;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/**
 * @param {Array<import('./parser.js').FileSummary>} summaries
 * @returns {Map<string, number>}
 */
function computeFanIn(summaries) {
  const knownFiles = new Set(summaries.map((s) => s.relativePath));
  /** @type {Map<string, number>} */
  const fanIn = new Map();
  for (const f of knownFiles) fanIn.set(f, 0);

  const candidateSuffixes = [
    '',
    '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
    '/index.js', '/index.ts', '/index.jsx', '/index.tsx',
  ];

  for (const summary of summaries) {
    for (const imp of summary.imports) {
      if (!imp.source.startsWith('.') && !imp.source.startsWith('/')) continue;
      const fromDir = path.dirname(summary.relativePath).replaceAll('\\', '/');
      const resolvedRaw = path.posix.normalize(path.posix.join(fromDir, imp.source));
      for (const suffix of candidateSuffixes) {
        const candidate = resolvedRaw + suffix;
        if (knownFiles.has(candidate)) {
          fanIn.set(candidate, fanIn.get(candidate) + 1);
          break;
        }
      }
    }
  }

  return fanIn;
}

/**
 * @param {import('./tasks.js').Task[]} tasks
 * @returns {Map<string, number>}
 */
function computeTaskActivity(tasks) {
  const score = new Map();
  for (const t of tasks) {
    const weight = t.status === 'in_progress' ? 2 : t.status === 'done' ? 1 : 0;
    if (weight === 0) continue;
    for (const b of t.branches ?? []) {
      score.set(b, (score.get(b) ?? 0) + weight);
    }
  }
  return score;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * @param {Array<import('./parser.js').FileSummary>} files
 * @param {Object} ctx
 * @param {string[]} ctx.pinned
 * @param {string} ctx.branchPath
 * @param {Map<string, number>} ctx.fanIn
 * @param {Map<string, number>} ctx.taskActivity
 * @returns {Array<import('./parser.js').FileSummary>}
 */
function rankFiles(files, { pinned, fanIn }) {
  const pinnedSet = new Set(pinned);

  const scored = files.map((f) => {
    const filename = path.basename(f.relativePath);
    const nameNoExt = filename.replace(/\.[^.]+$/, '');
    const isBarrel = nameNoExt === 'index';
    const exportCount = f.exports.length;
    const fanInScore = fanIn.get(f.relativePath) ?? 0;

    const score =
      fanInScore * 10 +
      (isBarrel ? 25 : 0) +
      exportCount * 2;

    return { file: f, filename, score };
  });

  // Deterministic: ties broken alphabetically.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.file.relativePath.localeCompare(b.file.relativePath);
  });

  const pinnedFiles = [];
  const otherFiles = [];
  for (const s of scored) {
    if (pinnedSet.has(s.filename)) pinnedFiles.push(s.file);
    else otherFiles.push(s.file);
  }

  pinnedFiles.sort((a, b) => {
    const ia = pinned.indexOf(path.basename(a.relativePath));
    const ib = pinned.indexOf(path.basename(b.relativePath));
    return ia - ib;
  });

  return [...pinnedFiles, ...otherFiles];
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

async function writeBranchMd(projectRoot, branchPath, data) {
  const safeName = branchPath.replaceAll('/', '-') + '.md';
  const outPath = path.join(projectRoot, COMPACT_DIR, safeName);

  const lines = [];
  lines.push(`# ${branchPath}`);
  lines.push('');

  if (data.description) {
    lines.push('## Purpose');
    lines.push(data.description);
    lines.push('');
  }

  lines.push('## Files');
  if (data.files.length === 0) {
    lines.push('_No source files in this branch._');
  } else {
    for (const f of data.files) {
      const displayName =
        branchPath === UNASSIGNED_BRANCH
          ? f.relativePath
          : f.relativePath.slice(branchPath.length + 1) || f.relativePath;
      const desc = f.description ? ` — ${f.description}` : '';
      lines.push(`- \`${displayName}\`${desc}`);
    }
  }
  lines.push('');

  lines.push('## Public exports');
  const allExports = data.files
    .filter((f) => f.supported && f.exports.length > 0)
    .flatMap((f) => {
      const name = path.basename(f.relativePath);
      return f.exports.map((e) => ({ file: name, export: e }));
    });
  if (allExports.length === 0) {
    lines.push('_None._');
  } else {
    for (const e of allExports) {
      lines.push(`- \`${e.export}\` (from \`${e.file}\`)`);
    }
  }
  lines.push('');

  // Cross-branch dependencies.
  const deps = new Set();
  const otherBranchPaths = (data.allBranches ?? [])
    .map((b) => normalizeBranchPath(b.path))
    .filter((p) => p !== branchPath);
  for (const f of data.files) {
    for (const imp of f.imports ?? []) {
      if (!imp.source.startsWith('.')) continue;
      const fromDir = path.dirname(f.relativePath).replaceAll('\\', '/');
      const resolved = path.posix
        .normalize(path.posix.join(fromDir, imp.source))
        .replace(/\.(js|mjs|cjs|jsx|ts|tsx)$/, '');
      for (const bp of otherBranchPaths) {
        if (resolved === bp || resolved.startsWith(bp + '/')) deps.add(bp);
      }
    }
  }
  lines.push('## Depends on');
  if (deps.size === 0) {
    lines.push('_No dependencies on other declared branches._');
  } else {
    for (const d of [...deps].sort()) lines.push(`- \`${d}\``);
  }
  lines.push('');

  if (data.tasks && data.tasks.length > 0) {
    lines.push('## Recent activity');
    const sorted = [...data.tasks].sort((a, b) => {
      const ra = rankStatus(a.status);
      const rb = rankStatus(b.status);
      if (ra !== rb) return ra - rb;
      return (b.updated_at ?? '').localeCompare(a.updated_at ?? '');
    });
    for (const t of sorted.slice(0, 5)) {
      lines.push(`- **${t.id}** (${t.status}) ${t.title}`);
    }
    lines.push('');
  }

  lines.push('## Notes');
  lines.push(
    '<!-- Claude: append architectural decisions here. Never overwrite existing notes. -->',
  );
  lines.push('');

  // If an existing .md has notes, preserve them by reading first.
  const existingNotes = await readExistingNotes(outPath);
  if (existingNotes) {
    lines.push(existingNotes);
    lines.push('');
  }

  await writeFile(outPath, lines.join('\n'), 'utf8');
}

function rankStatus(s) {
  return s === 'in_progress' ? 0 : s === 'pending' ? 1 : s === 'done' ? 2 : 3;
}

/**
 * Preserve user/Claude notes from the previous version of this branch.md.
 * We treat everything after the "## Notes" header (and after the HTML
 * comment line) as preserved content.
 */
async function readExistingNotes(mdPath) {
  let content;
  try {
    content = await readFile(mdPath, 'utf8');
  } catch {
    return null;
  }
  const marker = '<!-- Claude: append architectural decisions here. Never overwrite existing notes. -->';
  const idx = content.indexOf(marker);
  if (idx === -1) return null;
  const after = content.slice(idx + marker.length).trim();
  return after.length > 0 ? after : null;
}

async function writeProjectMap(projectRoot, data) {
  const lines = [];
  lines.push('# Project map');
  lines.push('');
  lines.push(
    `**Branches:** ${data.branchReports.length} | ` +
      `**Tasks in progress:** ${data.activeTasksCount}`,
  );
  lines.push('');

  lines.push('## Branches');
  lines.push('');

  for (const b of data.branchReports) {
    lines.push(`### \`${b.path}\``);
    if (b.description) lines.push(b.description);
    lines.push(`_${b.fileCount} file(s)._`);
    lines.push('');

    if (b.topFiles.length === 0) {
      lines.push('_(empty)_');
    } else {
      for (const f of b.topFiles) {
        const name = path.basename(f.relativePath);
        const desc = f.description ? ` — ${f.description}` : '';
        lines.push(`- \`${name}\`${desc}`);
      }
      if (b.remaining > 0) {
        lines.push(
          `- _...and ${b.remaining} more. See ${COMPACT_DIR}/${b.path.replaceAll('/', '-')}.md_`,
        );
      }
    }

    if (b.tasks && b.tasks.length > 0) {
      const active = b.tasks.filter(
        (t) => t.status === 'in_progress' || t.status === 'pending',
      );
      if (active.length > 0) {
        lines.push('');
        lines.push(`_Touched by: ${active.map((t) => t.id).join(', ')}_`);
      }
    }
    lines.push('');
  }

  lines.push('## How to use');
  lines.push('');
  lines.push('1. Read this map before starting any task.');
  lines.push(
    '2. The active task tells you which branches to load (see `branches` field in `.context-compact/task-state.json`).',
  );
  lines.push('3. Load only the `.md` of those branches, not the full directory.');
  lines.push('4. If you need more context, request additional branches explicitly.');
  lines.push('');

  await writeFile(
    path.join(projectRoot, COMPACT_DIR, MAP_FILE),
    lines.join('\n'),
    'utf8',
  );
}
