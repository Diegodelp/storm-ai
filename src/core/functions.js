/**
 * Function index: every function of the app gets a stable ID (ID-001,
 * ID-002, ...) and is grouped into sections (frontend/backend/shared ×
 * Pacientes/Turnos/Auth/...).
 *
 * Pieces:
 *   - extractFunctions(ast, source, ...)  AST → function records (no LLM).
 *   - updateFunctionRegistry(...)         keeps IDs stable across runs and
 *                                         tells which functions need a
 *                                         (re)classification.
 *   - heuristicClassify(fn)               path-based layer/section guess,
 *                                         used when no LLM is available.
 *   - writeSections(...)                  .context-compact/sections/**.md
 *
 * The source code is never modified: the index maps each ID to its file
 * and line range. That keeps diffs clean and costs the AI no extra tokens
 * when it reads a file; `storm functions show <ID>` prints the exact code.
 *
 * What counts as a function (noise like `.map(x => ...)` callbacks is
 * deliberately left out):
 *   - top-level function declarations (exported or not)
 *   - top-level `const x = () => {}` / `const x = function () {}`
 *   - `export default function` / `export default () => {}`
 *   - class methods and arrow-function class properties
 *   - methods of top-level object literals (`const api = { get() {} }`)
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteJson } from './atomic-io.js';

const COMPACT_DIR = '.context-compact';
export const REGISTRY_FILE = 'functions.json';
export const SECTIONS_DIR = 'sections';
export const LAYERS = Object.freeze(['frontend', 'backend', 'shared']);

const SNIPPET_MAX_LINES = 12;
const SNIPPET_MAX_CHARS = 700;
const SIGNATURE_MAX = 120;

/**
 * @typedef {Object} ExtractedFunction
 * @property {string} key            Stable identity inside the file: `file::Qualified.name`.
 * @property {string} name           Qualified name (`Clase.metodo`, `api.get`, `default`).
 * @property {'function'|'arrow'|'method'|'component'|'hook'} kind
 * @property {string} file           Project-relative path.
 * @property {number} start          First line (1-based).
 * @property {number} end            Last line (1-based).
 * @property {string} signature      `name(params)`, shortened.
 * @property {boolean} exported
 * @property {boolean} async
 * @property {string|null} doc       First line of the leading JSDoc/comment.
 * @property {string} hash           Hash of the normalized body.
 * @property {string} snippet        First lines of the code (for the LLM).
 */

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const FUNCTION_TYPES = new Set(['FunctionExpression', 'ArrowFunctionExpression']);

/**
 * Extract the functions of one parsed file.
 *
 * @param {Object} ast            @babel/parser File node.
 * @param {string} source
 * @param {string} relativePath
 * @param {{jsx?: boolean}} [opts]
 * @returns {ExtractedFunction[]}
 */
export function extractFunctions(ast, source, relativePath, opts = {}) {
  /** @type {ExtractedFunction[]} */
  const out = [];
  const seen = new Map();

  const add = (name, fnNode, outerNode, { exported = false, isMethod = false } = {}) => {
    if (!fnNode || fnNode.start == null) return;
    const kind = kindOf(name, fnNode, { isMethod, jsx: opts.jsx });
    // Duplicate names (overloads, getters/setters) get a #n suffix.
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    const keyName = count > 1 ? `${name}#${count}` : name;
    const range = outerNode ?? fnNode;
    const code = source.slice(range.start, range.end);
    out.push({
      key: `${relativePath}::${keyName}`,
      name,
      kind,
      file: relativePath,
      start: range.loc.start.line,
      end: range.loc.end.line,
      signature: signatureOf(name, fnNode, source),
      exported,
      async: !!fnNode.async,
      doc: leadingDoc(range, ast.comments ?? [], source),
      hash: hashCode(source.slice(fnNode.start, fnNode.end)),
      snippet: snippetOf(code),
    });
  };

  const fromClass = (className, classNode, exported) => {
    for (const member of classNode.body?.body ?? []) {
      const memberName = propName(member.key);
      if (!memberName) continue;
      if (member.type === 'ClassMethod' || member.type === 'ClassPrivateMethod') {
        if (member.kind === 'constructor') continue;
        add(`${className}.${memberName}`, member, member, { exported, isMethod: true });
      } else if ((member.type === 'ClassProperty' || member.type === 'ClassPrivateProperty') &&
                 FUNCTION_TYPES.has(member.value?.type)) {
        add(`${className}.${memberName}`, member.value, member, { exported, isMethod: true });
      }
    }
  };

  const fromObject = (objName, objNode, exported) => {
    for (const prop of objNode.properties ?? []) {
      const propKey = propName(prop.key);
      if (!propKey) continue;
      if (prop.type === 'ObjectMethod') {
        add(`${objName}.${propKey}`, prop, prop, { exported, isMethod: true });
      } else if (prop.type === 'ObjectProperty' && FUNCTION_TYPES.has(prop.value?.type)) {
        add(`${objName}.${propKey}`, prop.value, prop, { exported, isMethod: true });
      }
    }
  };

  const fromDeclaration = (decl, outer, exported) => {
    if (!decl) return;
    switch (decl.type) {
      case 'FunctionDeclaration':
      case 'TSDeclareFunction':
        if (decl.id?.name && decl.body) add(decl.id.name, decl, outer, { exported });
        return;
      case 'ClassDeclaration':
        if (decl.id?.name) fromClass(decl.id.name, decl, exported);
        return;
      case 'VariableDeclaration':
        for (const d of decl.declarations) {
          if (d.id?.type !== 'Identifier') continue;
          const init = unwrap(d.init);
          const range = decl.declarations.length === 1 ? outer : d;
          if (FUNCTION_TYPES.has(init?.type)) add(d.id.name, init, range, { exported });
          else if (init?.type === 'ObjectExpression') fromObject(d.id.name, init, exported);
          else if (init?.type === 'ClassExpression') fromClass(d.id.name, init, exported);
        }
        return;
    }
  };

  for (const stmt of ast.program?.body ?? []) {
    if (stmt.type === 'ExportNamedDeclaration') {
      fromDeclaration(stmt.declaration, stmt, true);
    } else if (stmt.type === 'ExportDefaultDeclaration') {
      const d = unwrap(stmt.declaration);
      if (d?.type === 'FunctionDeclaration' || FUNCTION_TYPES.has(d?.type)) {
        add(d.id?.name ?? 'default', d, stmt, { exported: true });
      } else if (d?.type === 'ClassDeclaration' || d?.type === 'ClassExpression') {
        fromClass(d.id?.name ?? 'default', d, true);
      } else if (d?.type === 'ObjectExpression') {
        fromObject('default', d, true);
      }
    } else {
      fromDeclaration(stmt, stmt, false);
    }
  }

  // Mark names re-exported later (`export { foo }`).
  const reExported = new Set();
  for (const stmt of ast.program?.body ?? []) {
    if (stmt.type === 'ExportNamedDeclaration' && !stmt.source) {
      for (const s of stmt.specifiers ?? []) if (s.local?.name) reExported.add(s.local.name);
    }
  }
  for (const f of out) {
    if (reExported.has(f.name.split('.')[0])) f.exported = true;
  }
  return out;
}

/** Strip `x as T`, `x satisfies T`, `(x)`, and HOC wrappers like memo(fn). */
function unwrap(node) {
  let n = node;
  for (let i = 0; i < 5 && n; i++) {
    if (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression' ||
        n.type === 'ParenthesizedExpression' || n.type === 'TSNonNullExpression') {
      n = n.expression;
    } else if (n.type === 'CallExpression' && n.arguments?.length &&
               FUNCTION_TYPES.has(n.arguments[0].type) &&
               /^(memo|forwardRef|React\.memo|React\.forwardRef|observer|withRouter|useCallback)$/.test(calleeName(n.callee))) {
      n = n.arguments[0];
    } else {
      break;
    }
  }
  return n;
}

function calleeName(c) {
  if (c?.type === 'Identifier') return c.name;
  if (c?.type === 'MemberExpression') return `${calleeName(c.object)}.${propName(c.property)}`;
  return '';
}

function propName(key) {
  if (!key) return null;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'PrivateName') return `#${key.id?.name}`;
  if (key.type === 'StringLiteral' || key.type === 'NumericLiteral') return String(key.value);
  return null;
}

function kindOf(name, fnNode, { isMethod, jsx }) {
  const base = name.split('.').pop();
  if (!isMethod && /^use[A-Z0-9]/.test(base)) return 'hook';
  if (!isMethod && jsx && /^[A-Z]/.test(base)) return 'component';
  if (isMethod) return 'method';
  return fnNode.type === 'ArrowFunctionExpression' ? 'arrow' : 'function';
}

function signatureOf(name, fnNode, source) {
  const params = (fnNode.params ?? [])
    .map((p) => source.slice(p.start, p.end).replace(/\s+/g, ' '))
    .join(', ');
  const sig = `${fnNode.async ? 'async ' : ''}${name}(${params})`;
  return sig.length > SIGNATURE_MAX ? sig.slice(0, SIGNATURE_MAX - 1) + '…' : sig;
}

function leadingDoc(node, comments, source) {
  // The comment must end right before the node (only whitespace between).
  let best = null;
  for (const c of comments) {
    if (c.end > node.start) break;
    if (/^\s*$/.test(source.slice(c.end, node.start))) best = c;
  }
  if (!best) return null;
  const line = best.value
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\*+\s?/, '').trim())
    .find((l) => l && !l.startsWith('@'));
  if (!line) return null;
  return line.length > 160 ? line.slice(0, 157) + '...' : line;
}

function hashCode(code) {
  return createHash('sha1').update(code.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

function snippetOf(code) {
  const lines = code.split(/\r?\n/).slice(0, SNIPPET_MAX_LINES).join('\n');
  return lines.length > SNIPPET_MAX_CHARS ? lines.slice(0, SNIPPET_MAX_CHARS) + '…' : lines;
}

// ---------------------------------------------------------------------------
// Registry (stable IDs)
// ---------------------------------------------------------------------------

/**
 * @typedef {ExtractedFunction & {
 *   id: string,
 *   layer: 'frontend'|'backend'|'shared',
 *   section: string,
 *   description: string,
 *   classifiedBy: 'llm'|'heuristic',
 *   classifiedHash: string|null,
 * }} FunctionEntry
 */

/**
 * @typedef {Object} FunctionRegistry
 * @property {number} version
 * @property {number} nextId
 * @property {FunctionEntry[]} functions
 */

/** @param {string} projectRoot */
export function registryPath(projectRoot) {
  return path.join(projectRoot, COMPACT_DIR, REGISTRY_FILE);
}

/**
 * @param {string} projectRoot
 * @returns {Promise<FunctionRegistry>}
 */
export async function readRegistry(projectRoot) {
  try {
    const data = JSON.parse(await readFile(registryPath(projectRoot), 'utf8'));
    if (Array.isArray(data?.functions) && Number.isInteger(data.nextId)) return data;
  } catch {
    // Missing or corrupt: start over (IDs are regenerated).
  }
  return { version: 1, nextId: 1, functions: [] };
}

/** @param {number} n */
export function formatId(n) {
  return `ID-${String(n).padStart(3, '0')}`;
}

/**
 * Normalize user input like "1", "#ID-001", "id-1" to "ID-001".
 * @param {string} input
 * @returns {string|null}
 */
export function normalizeId(input) {
  const m = String(input ?? '').trim().match(/^#?(?:id-?)?0*(\d+)$/i);
  return m ? formatId(Number(m[1])) : null;
}

/**
 * Merge freshly extracted functions into the previous registry.
 *
 * Identity rules, in order:
 *   1. same key (file + qualified name) → same ID;
 *   2. same body hash as a function that disappeared → same ID (the
 *      function was moved to another file or renamed);
 *   3. otherwise a new ID.
 * Functions no longer in the code are dropped.
 *
 * Classification is kept when the body didn't change. `pending` lists the
 * entries that need a (re)classification: new, modified, or only
 * classified by the heuristic so far.
 *
 * @param {FunctionRegistry} previous
 * @param {ExtractedFunction[]} extracted
 * @returns {{registry: FunctionRegistry, pending: FunctionEntry[], added: number, removed: number}}
 */
export function mergeRegistry(previous, extracted) {
  const byKey = new Map(previous.functions.map((f) => [f.key, f]));
  const usedIds = new Set();
  let nextId = previous.nextId;

  /** @type {Array<[ExtractedFunction, FunctionEntry|null]>} */
  const matched = extracted.map((fn) => {
    const old = byKey.get(fn.key);
    if (old && !usedIds.has(old.id)) {
      usedIds.add(old.id);
      return [fn, old];
    }
    return [fn, null];
  });

  // Rule 2: match leftovers by body hash (moved/renamed functions).
  const orphansByHash = new Map();
  for (const f of previous.functions) {
    if (usedIds.has(f.id)) continue;
    if (!orphansByHash.has(f.hash)) orphansByHash.set(f.hash, []);
    orphansByHash.get(f.hash).push(f);
  }
  for (const pair of matched) {
    if (pair[1]) continue;
    const candidates = orphansByHash.get(pair[0].hash);
    const old = candidates?.find((c) => !usedIds.has(c.id));
    if (old) {
      usedIds.add(old.id);
      pair[1] = old;
    }
  }

  let added = 0;
  const functions = matched.map(([fn, old]) => {
    if (!old) added++;
    const id = old?.id ?? formatId(nextId++);
    const entry = {
      id,
      ...fn,
      layer: old?.layer ?? null,
      section: old?.section ?? null,
      description: old?.description ?? '',
      classifiedBy: old?.classifiedBy ?? null,
      classifiedHash: old?.classifiedHash ?? null,
    };
    return entry;
  });

  functions.sort((a, b) => idNumber(a.id) - idNumber(b.id));
  const pending = functions.filter((f) => f.classifiedBy !== 'llm' || f.classifiedHash !== f.hash);
  return {
    registry: { version: 1, nextId, functions },
    pending,
    added,
    removed: previous.functions.length - usedIds.size,
  };
}

function idNumber(id) {
  return Number(String(id).replace(/\D/g, '')) || 0;
}

// ---------------------------------------------------------------------------
// Heuristic classification (no LLM)
// ---------------------------------------------------------------------------

const BACKEND_DIRS = /(^|\/)(api|apis|server|servers|backend|routes?|routers?|controllers?|services?|models?|db|database|prisma|drizzle|repositories|repository|middlewares?|workers?|jobs?|cron|queues?|handlers?|resolvers?|graphql|trpc|actions)(\/|$)/i;
const BACKEND_FILES = /(^|\/)(route|server|middleware|schema)\.[jt]sx?$|\.server\.[jt]sx?$|\.(controller|service|model|repository|resolver|handler|router)\.[jt]s$/i;
const FRONTEND_DIRS = /(^|\/)(components?|pages|app|views?|screens?|hooks?|ui|layouts?|styles?|client|frontend|public|widgets?|features?|stores?|contexts?)(\/|$)/i;

// Folder/file names that say "where" but not "what": skipped when naming a section.
const GENERIC_SEGMENTS = new Set([
  'src', 'app', 'apps', 'lib', 'libs', 'pages', 'api', 'apis', 'server', 'client',
  'components', 'component', 'views', 'view', 'screens', 'ui', 'common', 'shared',
  'utils', 'util', 'helpers', 'helper', 'hooks', 'services', 'service', 'controllers',
  'controller', 'routes', 'route', 'routers', 'models', 'model', 'core', 'frontend',
  'backend', 'features', 'modules', 'module', 'index', 'main', 'layout', 'layouts',
  'packages', 'handlers', 'actions', 'stores', 'store', 'contexts', 'context', 'types',
  'page', 'default', 'widgets', 'containers', 'repositories', 'middleware', 'middlewares',
]);

/**
 * Guess layer and section from the file path (used without an LLM and
 * as a fallback for functions the LLM didn't return).
 *
 * @param {{file: string, kind?: string, name?: string}} fn
 * @returns {{layer: 'frontend'|'backend'|'shared', section: string}}
 */
export function heuristicClassify(fn) {
  const file = fn.file.replaceAll('\\', '/');
  let layer = 'shared';
  if (/(^|\/)(pages|app)\/api(\/|$)/i.test(file) || BACKEND_FILES.test(file) || BACKEND_DIRS.test(file)) {
    layer = 'backend';
  } else if (fn.kind === 'component' || fn.kind === 'hook' || /\.(jsx|tsx)$/.test(file) || FRONTEND_DIRS.test(file)) {
    layer = 'frontend';
  }
  return { layer, section: sectionFromPath(file) };
}

function sectionFromPath(file) {
  const parts = file.split('/');
  const base = parts.pop().replace(/\.[^.]+$/, '').replace(/\.(server|client|controller|service|model|route|router|handler)$/i, '');
  const candidates = [...parts, base]
    .map((p) => p.replace(/^[[(@_]+|[\])]+$/g, '').replace(/^\.\.\./, ''))
    .filter((p) => p && !GENERIC_SEGMENTS.has(p.toLowerCase()) && !/^\d+$/.test(p) && !/^(id|slug)$/i.test(p));
  const pick = candidates[0];
  return pick ? titleCase(pick) : 'General';
}

function titleCase(s) {
  return s
    .replace(/[-_.]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Normalize a section name coming from the LLM or the heuristic.
 * @param {string} s
 */
export function cleanSectionName(s) {
  const t = String(s ?? '').replace(/[\\/:*?"<>|#`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'General';
}

// ---------------------------------------------------------------------------
// Sections output
// ---------------------------------------------------------------------------

/** @param {string} section */
export function sectionSlug(section) {
  return section
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'general';
}

const LAYER_TITLE = { frontend: 'Frontend', backend: 'Backend', shared: 'Shared' };

/**
 * Group registry entries by layer → section.
 * @param {FunctionEntry[]} functions
 * @returns {Array<{layer: string, section: string, slug: string, file: string, functions: FunctionEntry[]}>}
 */
export function groupSections(functions) {
  const map = new Map();
  for (const f of functions) {
    const key = `${f.layer}/${sectionSlug(f.section)}`;
    if (!map.has(key)) {
      map.set(key, {
        layer: f.layer,
        section: f.section,
        slug: sectionSlug(f.section),
        file: `${COMPACT_DIR}/${SECTIONS_DIR}/${f.layer}/${sectionSlug(f.section)}.md`,
        functions: [],
      });
    }
    map.get(key).functions.push(f);
  }
  const order = (l) => LAYERS.indexOf(l);
  return [...map.values()].sort((a, b) =>
    order(a.layer) - order(b.layer) || a.section.localeCompare(b.section));
}

/**
 * Write .context-compact/sections/<layer>/<section>.md for every section,
 * and delete section files that no longer have functions. A "## Notes"
 * block written by hand is preserved when a file is regenerated.
 *
 * @param {string} projectRoot
 * @param {FunctionEntry[]} functions
 * @returns {Promise<ReturnType<typeof groupSections>>}
 */
export async function writeSections(projectRoot, functions) {
  const root = path.join(projectRoot, COMPACT_DIR, SECTIONS_DIR);
  const sections = groupSections(functions);
  const keep = new Set();

  for (const s of sections) {
    const abs = path.join(projectRoot, s.file);
    keep.add(path.normalize(abs));
    await mkdir(path.dirname(abs), { recursive: true });
    const notes = await readNotes(abs);
    await writeFile(abs, renderSection(s, notes), 'utf8');
  }

  // Remove stale section files (and empty layer dirs).
  for (const layer of await safeReaddir(root)) {
    const dir = path.join(root, layer);
    const files = await safeReaddir(dir);
    let left = 0;
    for (const f of files) {
      const abs = path.normalize(path.join(dir, f));
      if (f.endsWith('.md') && !keep.has(abs)) await rm(abs, { force: true });
      else left++;
    }
    if (left === 0) await rm(dir, { recursive: true, force: true });
  }
  return sections;
}

function renderSection(s, notes) {
  const lines = [
    `# ${LAYER_TITLE[s.layer] ?? s.layer} · ${s.section}`,
    '',
    `_${s.functions.length} function(s). Each #ID points to \`file\` + lines (L<start>-<end>); ` +
      'exact code: `storm functions show <ID>`._',
    '',
  ];
  const byFile = new Map();
  for (const f of [...s.functions].sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start)) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  for (const [file, fns] of byFile) {
    lines.push(`## \`${file}\``, '');
    for (const f of fns) {
      const desc = f.description ? ` — ${f.description}` : '';
      const exp = f.exported ? '' : ' _(internal)_';
      lines.push(`- **#${f.id}** \`${f.signature}\`${desc} · L${f.start}-${f.end}${exp}`);
    }
    lines.push('');
  }
  lines.push('## Notes', '', notes || '<!-- Manual notes: storm keeps this block when it regenerates the file. -->', '');
  return lines.join('\n');
}

async function readNotes(abs) {
  try {
    const text = await readFile(abs, 'utf8');
    const i = text.indexOf('\n## Notes\n');
    return i === -1 ? '' : text.slice(i + '\n## Notes\n'.length).trim();
  } catch {
    return '';
  }
}

async function safeReaddir(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * @callback FunctionClassifier
 * @param {FunctionEntry[]} pending
 * @param {{sections: Array<{layer: string, section: string}>}} ctx
 * @returns {Promise<Map<string, {layer: string, section: string, description: string}>>}
 *   Results by ID. Missing IDs fall back to the heuristic.
 */

/**
 * Update the registry and the section files from the freshly extracted
 * functions. With a `classifier` (LLM), only new/modified/heuristic-only
 * functions are sent to it; without one, those get a heuristic
 * classification and stay pending for the next run with an LLM.
 *
 * @param {string} projectRoot
 * @param {ExtractedFunction[]} extracted
 * @param {{classifier?: FunctionClassifier|null}} [opts]
 * @returns {Promise<{
 *   registry: FunctionRegistry,
 *   sections: ReturnType<typeof groupSections>,
 *   added: number, removed: number,
 *   classified: number, pendingAfter: number,
 *   warnings: string[],
 * }>}
 */
export async function updateFunctionIndex(projectRoot, extracted, opts = {}) {
  const warnings = [];
  const previous = await readRegistry(projectRoot);
  const { registry, pending, added, removed } = mergeRegistry(previous, extracted);

  let results = new Map();
  if (opts.classifier && pending.length) {
    const known = groupSections(registry.functions.filter((f) => f.classifiedBy === 'llm'))
      .map((s) => ({ layer: s.layer, section: s.section }));
    try {
      results = await opts.classifier(pending, { sections: known });
    } catch (err) {
      warnings.push(`No pude clasificar funciones con la IA: ${err.message}. Uso la heurística por ruta.`);
    }
  }

  let classified = 0;
  for (const f of pending) {
    const r = results.get(f.id);
    if (r) {
      f.layer = LAYERS.includes(r.layer) ? r.layer : heuristicClassify(f).layer;
      f.section = cleanSectionName(r.section);
      f.description = String(r.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || f.doc || '';
      f.classifiedBy = 'llm';
      f.classifiedHash = f.hash;
      classified++;
    } else if (!f.layer || f.classifiedBy !== 'llm') {
      // Heuristic only fills gaps; an older LLM classification of a
      // modified function is kept until the LLM sees it again.
      const h = heuristicClassify(f);
      f.layer = h.layer;
      f.section = h.section;
      f.description = f.doc ?? '';
      f.classifiedBy = 'heuristic';
      f.classifiedHash = null;
    }
  }

  await mkdir(path.join(projectRoot, COMPACT_DIR), { recursive: true });
  await atomicWriteJson(registryPath(projectRoot), registry);
  const sections = await writeSections(projectRoot, registry.functions);

  const pendingAfter = registry.functions.filter(
    (f) => f.classifiedBy !== 'llm' || f.classifiedHash !== f.hash).length;
  return { registry, sections, added, removed, classified, pendingAfter, warnings };
}
