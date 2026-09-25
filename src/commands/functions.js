/**
 * `storm functions` — query the function index (see core/functions.js).
 *
 *   storm functions show <ID>      file, lines, section and the exact code
 *   storm functions list [filter]  every function, optionally filtered by
 *                                  layer/section/name/file text
 *
 * `show` is what agents use to read ONE function without opening the whole
 * file: the section .md gives the ID, this gives the code. If the file
 * changed since the last refresh, the function is looked up again by name
 * so the lines are still right.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { requireProjectRoot } from '../core/paths.js';
import { readRegistry, normalizeId, extractFunctions } from '../core/functions.js';
import { parseSource } from '../core/parser.js';

/**
 * @param {{cwd: string, id: string}} input
 * @returns {Promise<{entry: import('../core/functions.js').FunctionEntry, code: string, start: number, end: number, moved: boolean}>}
 */
export async function showFunction(input) {
  const root = await requireProjectRoot(input.cwd);
  const id = normalizeId(input.id);
  if (!id) throw new Error(`ID inválido: "${input.id}". Formato: ID-001 (o 1, #ID-001).`);
  const registry = await readRegistry(root);
  const entry = registry.functions.find((f) => f.id === id);
  if (!entry) {
    throw new Error(`No existe ${id} en el índice. Corré \`storm refresh\` si la función es nueva.`);
  }

  let source;
  try {
    source = await readFile(path.join(root, entry.file), 'utf8');
  } catch {
    throw new Error(`${id} apunta a ${entry.file}, que ya no existe. Corré \`storm refresh\`.`);
  }

  // Re-locate by key in case lines moved since the last refresh.
  let start = entry.start;
  let end = entry.end;
  let moved = false;
  const ast = parseSource(source, entry.file);
  if (ast) {
    const current = extractFunctions(ast, source, entry.file, { jsx: /\.(jsx?|tsx|mjs|cjs)$/.test(entry.file) })
      .find((f) => f.key === entry.key);
    if (current && (current.start !== start || current.end !== end)) {
      ({ start, end } = current);
      moved = true;
    }
  }

  const code = source.split(/\r?\n/).slice(start - 1, end).join('\n');
  return { entry, code, start, end, moved };
}

/**
 * @param {{cwd: string, filter?: string}} input
 * @returns {Promise<import('../core/functions.js').FunctionEntry[]>}
 */
export async function listFunctions(input) {
  const root = await requireProjectRoot(input.cwd);
  const { functions } = await readRegistry(root);
  const q = input.filter?.trim().toLowerCase();
  if (!q) return functions;
  return functions.filter((f) =>
    [f.id, f.name, f.file, f.layer, f.section, f.description]
      .some((v) => String(v ?? '').toLowerCase().includes(q)));
}
