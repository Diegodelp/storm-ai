/**
 * AST parser for JS/TS files.
 *
 * Extracts:
 *   - Public exports (named, default, re-exports, type-only)
 *   - Leading description (first comment block at top of file)
 *   - Imports grouped by source (used later for inter-branch dependencies)
 *
 * Non-goals:
 *   - Type inference, call graph analysis, dead code detection.
 *   - Evaluating computed exports (e.g., `export { foo as bar }` is fine,
 *     but `export default someComputedThing()` is recorded as "default" only).
 *
 * Files that fail to parse are returned with empty exports and the error
 * captured in `parseError`, so the refresh never crashes because of one
 * broken file.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';

// @babel/traverse is a CJS module; its default export lives under .default
// when imported from ESM.
const traverse = _traverse.default ?? _traverse;

/**
 * @typedef {Object} FileSummary
 * @property {string} path                    Absolute path to the file.
 * @property {string} relativePath            Path relative to the project root.
 * @property {string|null} description        First comment-line or null.
 * @property {string[]} exports               Public export names. 'default' is used for default exports.
 * @property {Array<{source: string, names: string[]}>} imports
 * @property {string|null} parseError         Error message if parsing failed.
 * @property {boolean} supported              true for JS/TS; false for other languages.
 */

const SUPPORTED_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);
const TS_EXTS = new Set(['.ts', '.tsx']);
const JSX_EXTS = new Set(['.jsx', '.tsx']);

/**
 * Public: summarize a single file.
 *
 * @param {string} absolutePath
 * @param {string} projectRoot
 * @returns {Promise<FileSummary>}
 */
export async function summarizeFile(absolutePath, projectRoot) {
  const ext = path.extname(absolutePath).toLowerCase();
  const relativePath = path.relative(projectRoot, absolutePath).replaceAll('\\', '/');

  const base = {
    path: absolutePath,
    relativePath,
    description: null,
    exports: [],
    imports: [],
    parseError: null,
    supported: SUPPORTED_EXTS.has(ext),
  };

  if (!base.supported) {
    // For non-JS/TS files we still try to read a leading comment,
    // but we don't attempt to parse exports.
    try {
      const source = await readFile(absolutePath, 'utf8');
      base.description = extractLeadingCommentFromSource(source);
    } catch {
      // Binary or unreadable: leave description null.
    }
    return base;
  }

  let source;
  try {
    source = await readFile(absolutePath, 'utf8');
  } catch (err) {
    return { ...base, parseError: `read failed: ${err.message}` };
  }

  let ast;
  try {
    ast = parse(source, {
      sourceType: 'module',
      allowImportExportEverywhere: false,
      allowReturnOutsideFunction: false,
      errorRecovery: true,
      plugins: buildPluginList(ext),
    });
  } catch (err) {
    return {
      ...base,
      description: extractLeadingCommentFromSource(source),
      parseError: `parse failed: ${err.message}`,
    };
  }

  return {
    ...base,
    description: extractLeadingComment(ast, source),
    exports: extractExports(ast),
    imports: extractImports(ast),
  };
}

/**
 * Build the @babel/parser plugin list based on file extension.
 * @param {string} ext
 * @returns {string[]}
 */
function buildPluginList(ext) {
  const plugins = [];
  if (TS_EXTS.has(ext)) plugins.push('typescript');
  if (JSX_EXTS.has(ext)) plugins.push('jsx');
  // Modern syntax features that are widely used and should always parse.
  plugins.push('decorators-legacy', 'classProperties', 'topLevelAwait');
  return plugins;
}

/**
 * Extract the first line of the first leading comment in the file.
 * Uses the AST's comment arrays to find the topmost comment.
 *
 * @param {import('@babel/parser').ParseResult} ast
 * @param {string} source
 * @returns {string|null}
 */
function extractLeadingComment(ast, source) {
  // Babel exposes comments at ast.comments (when errorRecovery) or
  // inside program.body[0].leadingComments.
  const comments = ast.comments ?? [];
  if (comments.length === 0) {
    return extractLeadingCommentFromSource(source);
  }

  // We want only comments that appear BEFORE the first real statement.
  const firstStmt = ast.program?.body?.[0];
  const firstStmtStart = firstStmt?.start ?? Infinity;
  const leading = comments.filter((c) => c.end <= firstStmtStart);

  if (leading.length === 0) return null;
  return normalizeCommentText(leading[0].value);
}

/**
 * Fallback comment extractor that works on raw source (when AST failed or
 * for non-JS files). Handles `//`, `/* *\/`, `/** *\/` at the top.
 *
 * @param {string} source
 * @returns {string|null}
 */
function extractLeadingCommentFromSource(source) {
  const trimmed = source.trimStart();

  if (trimmed.startsWith('//')) {
    const end = trimmed.indexOf('\n');
    const line = end === -1 ? trimmed : trimmed.slice(0, end);
    return normalizeCommentText(line.replace(/^\/\/+/, ''));
  }

  if (trimmed.startsWith('/*')) {
    const end = trimmed.indexOf('*/');
    if (end === -1) return null;
    const body = trimmed.slice(2, end);
    return normalizeCommentText(body);
  }

  // Hash comments (shell scripts, Python-like). First line only.
  if (trimmed.startsWith('#')) {
    const end = trimmed.indexOf('\n');
    const line = end === -1 ? trimmed : trimmed.slice(0, end);
    return normalizeCommentText(line.replace(/^#+/, ''));
  }

  return null;
}

/**
 * Normalize a raw comment value to a single short description line.
 * - Strips leading `*` on each line (JSDoc style).
 * - Returns only the first non-empty line.
 * - Caps length to 140 chars to keep the compact map readable.
 *
 * @param {string} raw
 * @returns {string|null}
 */
function normalizeCommentText(raw) {
  if (!raw) return null;
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\*+\s?/, '').trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const first = lines[0];
  return first.length > 140 ? first.slice(0, 137) + '...' : first;
}

/**
 * Extract all public export names from an AST.
 * Returns a sorted, deduplicated list. Uses 'default' for default exports.
 *
 * @param {import('@babel/parser').ParseResult} ast
 * @returns {string[]}
 */
function extractExports(ast) {
  const names = new Set();

  traverse(ast, {
    ExportNamedDeclaration(path) {
      const { declaration, specifiers } = path.node;
      if (declaration) {
        // export const x = ..., export function y() {}, export class Z {}
        if (declaration.type === 'VariableDeclaration') {
          for (const decl of declaration.declarations) {
            collectBindingNames(decl.id, names);
          }
        } else if (declaration.id?.name) {
          names.add(declaration.id.name);
        }
      }
      // export { a, b as c } from './x'
      for (const spec of specifiers ?? []) {
        if (spec.exported?.name) names.add(spec.exported.name);
        else if (spec.exported?.value) names.add(spec.exported.value);
      }
    },

    ExportDefaultDeclaration() {
      names.add('default');
    },

    // export * from './foo' — we can't know the names without resolving;
    // mark as re-export so the consumer knows there's more.
    ExportAllDeclaration(path) {
      const source = path.node.source?.value ?? '?';
      names.add(`* from '${source}'`);
    },
  });

  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Recursively collect identifier names from a binding pattern
 * (handles destructuring: const { a, b: { c } } = ...).
 *
 * @param {Object} node
 * @param {Set<string>} out
 */
function collectBindingNames(node, out) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier':
      out.add(node.name);
      return;
    case 'ObjectPattern':
      for (const prop of node.properties) {
        if (prop.type === 'RestElement') collectBindingNames(prop.argument, out);
        else collectBindingNames(prop.value, out);
      }
      return;
    case 'ArrayPattern':
      for (const el of node.elements) collectBindingNames(el, out);
      return;
    case 'AssignmentPattern':
      collectBindingNames(node.left, out);
      return;
    case 'RestElement':
      collectBindingNames(node.argument, out);
      return;
  }
}

/**
 * Extract imports grouped by source module.
 *
 * @param {import('@babel/parser').ParseResult} ast
 * @returns {Array<{source: string, names: string[]}>}
 */
function extractImports(ast) {
  /** @type {Map<string, Set<string>>} */
  const bySource = new Map();

  traverse(ast, {
    ImportDeclaration(path) {
      const source = path.node.source.value;
      if (!bySource.has(source)) bySource.set(source, new Set());
      const set = bySource.get(source);
      for (const spec of path.node.specifiers) {
        if (spec.type === 'ImportDefaultSpecifier') set.add('default');
        else if (spec.type === 'ImportNamespaceSpecifier') set.add('*');
        else if (spec.imported?.name) set.add(spec.imported.name);
        else if (spec.imported?.value) set.add(spec.imported.value);
      }
    },
  });

  return [...bySource.entries()]
    .map(([source, set]) => ({ source, names: [...set].sort() }))
    .sort((a, b) => a.source.localeCompare(b.source));
}
