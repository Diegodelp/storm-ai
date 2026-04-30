/**
 * Templates: clone-able starter projects pre-mapped for storm-ai.
 *
 * The registry lives at:
 *   https://raw.githubusercontent.com/Diegodelp/storm-ai/main/templates/registry.json
 *
 * Schema of the registry file:
 *   {
 *     "version": 1,
 *     "templates": [
 *       {
 *         "id": "nextjs-saas",                        // stable identifier
 *         "label": "Next.js SaaS Starter",
 *         "description": "Landing + Auth + DB + Stripe.",
 *         "repo": "Diegodelp/storm-template-nextjs-saas",
 *         "ref": "main",                              // optional, default "main"
 *         "stackId": "nextjs-app",                    // for display
 *         "minStormVersion": "0.2.0"                  // optional gating
 *       },
 *       ...
 *     ]
 *   }
 *
 * Each template repo must contain:
 *   - storm-template.json    (metadata: variables, postInstall, initialTasks)
 *   - template/              (the actual project files; copied to <project-root>/)
 *   - .storm/                (storm scaffolding; copied as-is to <project-root>/)
 *
 * `storm-template.json` schema:
 *   {
 *     "version": 1,
 *     "name": "nextjs-saas",
 *     "label": "Next.js SaaS Starter",
 *     "description": "...",
 *     "stackId": "nextjs-app",
 *     "databaseId": "postgres",
 *     "variables": [                                  // user-prompted values
 *       { "key": "PROJECT_NAME", "prompt": "Nombre", "placeholder": "mi-saas" }
 *     ],
 *     "postInstall": [                                // shell commands run after copy
 *       "pnpm install",
 *       "npx prisma generate"
 *     ],
 *     "initialTasks": [                               // pre-loaded into task-state.json
 *       { "title": "...", "description": "...", "branches": ["app"] }
 *     ]
 *   }
 *
 * We never execute arbitrary code from the template until the user
 * confirms — postInstall commands are shown before running.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile, rm, cp } from 'node:fs/promises';
import path from 'node:path';

const REGISTRY_URL =
  'https://raw.githubusercontent.com/Diegodelp/storm-ai/main/templates/registry.json';

const FETCH_TIMEOUT_MS = 8000;

/**
 * @typedef {Object} TemplateRegistryEntry
 * @property {string} id
 * @property {string} label
 * @property {string} description
 * @property {string} repo                    "owner/repo"
 * @property {string} [ref]                   git ref (default "main")
 * @property {string} [stackId]
 * @property {string} [minStormVersion]
 */

/**
 * @typedef {Object} TemplateMetadata
 * @property {number} version
 * @property {string} name
 * @property {string} label
 * @property {string} description
 * @property {string} stackId
 * @property {string} [databaseId]
 * @property {{key: string, prompt: string, placeholder?: string, optional?: boolean}[]} [variables]
 * @property {string[]} [postInstall]
 * @property {{title: string, description?: string, branches?: string[]}[]} [initialTasks]
 */

/**
 * Fetch the registry. Returns an empty array on any failure (offline,
 * 404, malformed JSON) — the caller should fall back to the from-scratch
 * wizard.
 *
 * @returns {Promise<TemplateRegistryEntry[]>}
 */
export async function fetchTemplateRegistry() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, { signal: controller.signal });
    if (!res.ok) return [];
    const json = await res.json();
    if (!json || !Array.isArray(json.templates)) return [];
    // Filter out malformed entries.
    return json.templates.filter(
      (t) => t && typeof t.id === 'string' && typeof t.repo === 'string',
    );
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Clone a template repo into a temp directory and return its path.
 * Caller is responsible for cleanup.
 *
 * @param {{repo: string, ref?: string, dest: string}} input
 * @returns {Promise<{ok: boolean, message?: string}>}
 */
export async function cloneTemplate({ repo, ref = 'main', dest }) {
  // Ensure parent exists.
  await mkdir(path.dirname(dest), { recursive: true });

  const url = `https://github.com/${repo}.git`;
  const args = ['clone', '--depth', '1', '--branch', ref, url, dest];

  return new Promise((resolve) => {
    const proc = spawn('git', args, { stdio: 'inherit', windowsHide: true });
    proc.on('exit', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, message: `git clone exited ${code}` });
    });
    proc.on('error', (err) => {
      resolve({
        ok: false,
        message: `git no se pudo ejecutar: ${err.message}. ¿Está instalado?`,
      });
    });
  });
}

/**
 * Read storm-template.json from a cloned template directory.
 *
 * @param {string} cloneDir
 * @returns {Promise<TemplateMetadata>}
 */
export async function readTemplateMetadata(cloneDir) {
  const file = path.join(cloneDir, 'storm-template.json');
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    throw new Error(
      `El template no tiene storm-template.json (${err.code === 'ENOENT' ? 'no existe' : err.message}).`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`storm-template.json inválido: ${err.message}`);
  }

  return validateMetadata(parsed);
}

/**
 * Apply variable substitution + copy template files into projectRoot.
 * Walks `<cloneDir>/template/` and `<cloneDir>/.storm/`.
 *
 * Replaces `{{KEY}}` in TEXT FILES with values from `variables`.
 * Binary files are copied as-is.
 *
 * @param {{
 *   cloneDir: string,
 *   projectRoot: string,
 *   variables: Record<string, string>,
 * }} input
 * @returns {Promise<{filesWritten: number, filesSkipped: string[]}>}
 */
export async function applyTemplate(input) {
  const { cloneDir, projectRoot, variables } = input;
  const sources = [
    { from: path.join(cloneDir, 'template'), to: projectRoot },
    { from: path.join(cloneDir, '.storm'),   to: projectRoot },
  ];

  let filesWritten = 0;
  const filesSkipped = [];

  for (const src of sources) {
    if (!(await pathExists(src.from))) continue;
    const result = await copyTreeWithVars(src.from, src.to, variables);
    filesWritten += result.filesWritten;
    filesSkipped.push(...result.filesSkipped);
  }

  return { filesWritten, filesSkipped };
}

/**
 * Run the template's postInstall commands in projectRoot. Stops at the
 * first failure and returns its index.
 *
 * @param {{projectRoot: string, commands: string[]}} input
 * @returns {Promise<{ok: boolean, completed: number, failedAt?: string, message?: string}>}
 */
export async function runPostInstall({ projectRoot, commands }) {
  if (!Array.isArray(commands) || commands.length === 0) {
    return { ok: true, completed: 0 };
  }

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    const result = await runShellCommand({ command: cmd, cwd: projectRoot });
    if (!result.ok) {
      return {
        ok: false,
        completed: i,
        failedAt: cmd,
        message: result.message,
      };
    }
  }
  return { ok: true, completed: commands.length };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const TEXT_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.tsx',
  '.json', '.jsonc',
  '.md', '.mdx', '.txt',
  '.html', '.css', '.scss', '.sass',
  '.svelte', '.astro', '.vue',
  '.yaml', '.yml',
  '.toml',
  '.env', '.env.example', '.env.local',
  '.prisma',
  '.gitignore', '.npmignore',
]);

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTS.has(ext)) return true;
  // Files with no extension that are typically text.
  const base = path.basename(filePath).toLowerCase();
  if (['readme', 'license', 'dockerfile', 'makefile', '.env'].includes(base)) {
    return true;
  }
  return false;
}

async function copyTreeWithVars(srcDir, destDir, variables) {
  let filesWritten = 0;
  const filesSkipped = [];

  async function walk(curSrc, curDest) {
    await mkdir(curDest, { recursive: true });
    const entries = await readdir(curSrc, { withFileTypes: true });
    for (const ent of entries) {
      const sPath = path.join(curSrc, ent.name);
      // The file/dir name itself can contain {{VAR}}.
      const renamedName = substituteVars(ent.name, variables);
      const dPath = path.join(curDest, renamedName);

      if (ent.isDirectory()) {
        await walk(sPath, dPath);
        continue;
      }

      if (await pathExists(dPath)) {
        // Don't silently overwrite — the caller's wizard should have
        // asked about this before, but as a safety net we report it.
        filesSkipped.push(path.relative(destDir, dPath));
        continue;
      }

      if (isTextFile(sPath)) {
        const raw = await readFile(sPath, 'utf8');
        const replaced = substituteVars(raw, variables);
        await writeFile(dPath, replaced, 'utf8');
      } else {
        await cp(sPath, dPath);
      }
      filesWritten++;
    }
  }

  await walk(srcDir, destDir);
  return { filesWritten, filesSkipped };
}

/**
 * Replace every `{{KEY}}` with its value. Unknown keys remain untouched
 * so the user can spot them in the generated output.
 */
function substituteVars(text, variables) {
  return text.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    return key in variables ? variables[key] : `{{${key}}}`;
  });
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function runShellCommand({ command, cwd }) {
  return new Promise((resolve) => {
    // Use shell=true so commands like "pnpm install" are looked up via PATH.
    const proc = spawn(command, {
      cwd,
      stdio: 'inherit',
      shell: true,
      windowsHide: true,
    });
    proc.on('exit', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, message: `Command exited ${code}` });
    });
    proc.on('error', (err) => {
      resolve({ ok: false, message: err.message });
    });
  });
}

/**
 * @param {any} obj
 * @returns {TemplateMetadata}
 */
function validateMetadata(obj) {
  if (!obj || typeof obj !== 'object') {
    throw new Error('storm-template.json no es un objeto JSON.');
  }
  if (typeof obj.name !== 'string' || !obj.name.trim()) {
    throw new Error('storm-template.json: falta `name`.');
  }
  if (typeof obj.stackId !== 'string') {
    throw new Error('storm-template.json: falta `stackId`.');
  }
  /** @type {TemplateMetadata} */
  const out = {
    version: typeof obj.version === 'number' ? obj.version : 1,
    name: obj.name.trim(),
    label: typeof obj.label === 'string' ? obj.label : obj.name,
    description: typeof obj.description === 'string' ? obj.description : '',
    stackId: obj.stackId,
    databaseId: typeof obj.databaseId === 'string' ? obj.databaseId : 'other',
    variables: Array.isArray(obj.variables)
      ? obj.variables.filter((v) => v && typeof v.key === 'string')
      : [],
    postInstall: Array.isArray(obj.postInstall)
      ? obj.postInstall.filter((c) => typeof c === 'string')
      : [],
    initialTasks: Array.isArray(obj.initialTasks)
      ? obj.initialTasks
          .filter((t) => t && typeof t.title === 'string')
          .map((t) => ({
            title: t.title,
            description: typeof t.description === 'string' ? t.description : '',
            branches: Array.isArray(t.branches)
              ? t.branches.filter((b) => typeof b === 'string')
              : [],
          }))
      : [],
  };
  return out;
}
