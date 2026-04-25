/**
 * Project analysis: read metadata files and a sample of source code,
 * build a compact prompt that asks an LLM to characterize the project.
 *
 * Two modes:
 *   - shallow: package.json + README + a directory listing. Fast (~5KB).
 *   - deep:    same plus a few representative code files (~30-50KB).
 *
 * The output is text ready to feed into a chat completion. The actual
 * LLM call lives in src/core/llm-client.js so we can mock it in tests.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { STACKS, DATABASES } from './stacks.js';

/** Files we always try to read. They tell us a lot per byte. */
const PRIORITY_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'turbo.json',
  'tsconfig.json',
  'jsconfig.json',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'astro.config.mjs',
  'svelte.config.js',
  'vite.config.js',
  'vite.config.ts',
  'nest-cli.json',
  'requirements.txt',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'README.md',
  'README.MD',
  'README',
  '.env.example',
];

/** Code-file extensions we'd consider sampling in --deep mode. */
const CODE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.tsx',
  '.svelte', '.astro', '.vue',
  '.py', '.rb', '.go', '.rs',
]);

/** Directories we never descend into. */
const ALWAYS_IGNORED = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next',
  '.turbo', '.cache', 'coverage', '.nuxt', '.svelte-kit',
  'out', 'target', '__pycache__', '.venv', 'venv',
]);

/**
 * @typedef {Object} ProjectScan
 * @property {string} rootName
 * @property {{name: string, content: string}[]} files
 * @property {string[]} treeListing       Up to ~150 paths, depth-limited.
 * @property {{name: string, content: string}[]} sampleCode  Empty in shallow mode.
 */

/**
 * Scan the project directory and return structured data ready to prompt with.
 *
 * @param {{cwd: string, mode: 'shallow'|'deep'}} input
 * @returns {Promise<ProjectScan>}
 */
export async function scanProject({ cwd, mode }) {
  const rootName = path.basename(cwd);
  const files = [];

  // 1. Priority files: read whatever exists.
  for (const fname of PRIORITY_FILES) {
    const fpath = path.join(cwd, fname);
    try {
      const raw = await readFile(fpath, 'utf8');
      // Truncate very long files (e.g. lockfile-style README) to avoid
      // eating the LLM context window with one file.
      const content = truncate(raw, 8000);
      files.push({ name: fname, content });
    } catch {
      // not present, skip
    }
  }

  // 2. Tree listing: collect directory names up to depth 3.
  const treeListing = await listTree(cwd, 3, 200);

  // 3. Code sample (only in --deep mode).
  let sampleCode = [];
  if (mode === 'deep') {
    sampleCode = await pickCodeSamples(cwd, treeListing, 6, 4000);
  }

  return { rootName, files, treeListing, sampleCode };
}

/**
 * Build the prompt sent to the LLM. The prompt asks for a strict JSON
 * response so we can parse it deterministically.
 *
 * @param {ProjectScan} scan
 * @returns {string}
 */
export function buildAnalysisPrompt(scan) {
  const stackOptions = STACKS.map((s) => `  - ${s.id}: ${s.label}`).join('\n');
  const dbOptions = DATABASES.map((d) => `  - ${d.id}: ${d.label}`).join('\n');

  const filesBlock = scan.files
    .map((f) => `### ${f.name}\n\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n');

  const sampleBlock = scan.sampleCode.length
    ? '\n\n## Sample source code\n\n' +
      scan.sampleCode
        .map((f) => `### ${f.name}\n\n\`\`\`\n${f.content}\n\`\`\``)
        .join('\n\n')
    : '';

  const treeBlock = scan.treeListing.slice(0, 150).join('\n');

  return `You are analyzing a software project to scaffold it for AI-assisted development with storm-ai.

The project root directory name is: ${scan.rootName}

Below are the project's metadata files and a partial directory listing.
Read them and answer with a STRICT JSON OBJECT (no prose, no code fences,
no markdown). The JSON must follow this exact schema:

{
  "name": string,                  // a slug-friendly project name; lowercase, hyphens
  "description": string,           // one short sentence describing what this project does
  "stackId": string,               // MUST be one of the stack ids listed below
  "stackReasoning": string,        // one short sentence explaining why
  "databaseId": string,            // MUST be one of the database ids listed below
  "databaseReasoning": string,     // one short sentence explaining why
  "branches": [                    // 2-6 directories that look like branches
    { "path": string, "description": string }
  ],
  "skills": [                      // 0-3 PROJECT-SPECIFIC custom skills (NOT the built-ins)
    { "name": string, "description": string }
  ],
  "agents": [                      // 0-2 agents that would help on this project
    { "name": string, "slash": string, "description": string }
  ]
}

Constraints:
- stackId values: one of:
${stackOptions}
- databaseId values: one of:
${dbOptions}
- If you can't tell the database, use "none" or "other".
- Branches: only include directories that ACTUALLY EXIST in the listing below.
- Skills/agents: only suggest things directly justified by what you see.
  If nothing obvious fits, return empty arrays. Don't pad with generic
  things like "Code Reviewer".
- The slash for an agent must be a single lowercase token, no spaces,
  hyphens allowed (e.g. "frontend-dev", "db-reviewer").

## Project files

${filesBlock}

## Directory listing (first 150 entries)

\`\`\`
${treeBlock}
\`\`\`${sampleBlock}

Now respond with ONLY the JSON object. No prose before or after.
`;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... (truncated, ${s.length - max} more chars)`;
}

/**
 * BFS directory walk capped at maxEntries. Returns relative paths,
 * with a trailing "/" on directories so the LLM can tell them apart.
 */
async function listTree(rootDir, maxDepth, maxEntries) {
  /** @type {string[]} */
  const out = [];
  /** @type {Array<{abs: string, rel: string, depth: number}>} */
  const queue = [{ abs: rootDir, rel: '', depth: 0 }];

  while (queue.length > 0 && out.length < maxEntries) {
    const cur = queue.shift();
    if (cur.depth > maxDepth) continue;

    let entries;
    try {
      entries = await readdir(cur.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const ent of entries) {
      if (ent.name.startsWith('.') && ent.name !== '.env.example') continue;
      if (ALWAYS_IGNORED.has(ent.name)) continue;

      const childRel = cur.rel ? `${cur.rel}/${ent.name}` : ent.name;
      const childAbs = path.join(cur.abs, ent.name);

      if (ent.isDirectory()) {
        out.push(childRel + '/');
        queue.push({ abs: childAbs, rel: childRel, depth: cur.depth + 1 });
      } else {
        out.push(childRel);
      }
      if (out.length >= maxEntries) break;
    }
  }
  return out;
}

/**
 * Pick a few representative code files to include in --deep mode.
 * Heuristic: prefer files in the project's deepest declared module
 * directories (e.g. src/, app/, pages/). Read and truncate each.
 */
async function pickCodeSamples(rootDir, treeListing, maxFiles, perFileMaxBytes) {
  // Find code files in the listing, prioritize by likely importance.
  const candidates = treeListing
    .filter((p) => !p.endsWith('/'))
    .filter((p) => CODE_EXTS.has(path.extname(p).toLowerCase()))
    .map((p) => ({
      path: p,
      score: scoreCandidate(p),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles);

  const out = [];
  for (const c of candidates) {
    try {
      const raw = await readFile(path.join(rootDir, c.path), 'utf8');
      out.push({ name: c.path, content: truncate(raw, perFileMaxBytes) });
    } catch {
      // ignore unreadable files
    }
  }
  return out;
}

/** Higher score = more likely to be a representative file. */
function scoreCandidate(relPath) {
  let score = 0;
  // Prefer entry-point names.
  const base = path.basename(relPath).toLowerCase();
  if (['index.js', 'index.ts', 'index.tsx', 'main.js', 'main.ts', 'app.js', 'app.ts'].includes(base)) {
    score += 50;
  }
  // Prefer files with semantically meaningful names.
  if (/route|controller|service|model|schema/i.test(base)) score += 20;
  // Discourage tests and fixtures (we want production code).
  if (/test|spec|fixture|mock/i.test(relPath)) score -= 30;
  // Discourage very deep paths (probably implementation detail).
  const depth = relPath.split('/').length;
  score -= depth * 2;
  return score;
}
