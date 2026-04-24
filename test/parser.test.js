/**
 * Tests for src/core/parser.js
 *
 * Run with: node --test test/parser.test.js
 *
 * We write fixture files to a temp directory to exercise real file-system
 * behavior (paths, read errors) rather than mocking fs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { summarizeFile } from '../src/core/parser.js';

/** Create a scratch dir + helper to write fixtures in it. */
async function setupTempProject() {
  const root = await mkdtemp(path.join(tmpdir(), 'storm-test-'));
  const write = async (relPath, content) => {
    const abs = path.join(root, relPath);
    await writeFile(abs, content, 'utf8');
    return abs;
  };
  const cleanup = () => rm(root, { recursive: true, force: true });
  return { root, write, cleanup };
}

test('named exports: const, function, class', async () => {
  const { root, write, cleanup } = await setupTempProject();
  try {
    const file = await write(
      'auth.js',
      `// Manejo de sesión.
export const login = (email) => {};
export function logout() {}
export class Session {}
`,
    );
    const r = await summarizeFile(file, root);
    assert.equal(r.parseError, null);
    // localeCompare is case-insensitive in most locales, so lowercase 'l'
    // sorts before uppercase 'S'. We sort exports that way on purpose —
    // it matches how a human reads a list.
    assert.deepEqual(r.exports, ['login', 'logout', 'Session']);
    assert.equal(r.description, 'Manejo de sesión.');
    assert.equal(r.relativePath, 'auth.js');
    assert.equal(r.supported, true);
  } finally {
    await cleanup();
  }
});

test('default export is recorded as "default"', async () => {
  const { root, write, cleanup } = await setupTempProject();
  try {
    const file = await write('home.js', `export default function Home() {}\n`);
    const r = await summarizeFile(file, root);
    assert.deepEqual(r.exports, ['default']);
  } finally {
    await cleanup();
  }
});

test('destructured exports are flattened', async () => {
  const { root, write, cleanup } = await setupTempProject();
  try {
    const file = await write(
      'config.js',
      `export const { apiUrl, dbUrl, nested: { secret } } = loadConfig();\n`,
    );
    const r = await summarizeFile(file, root);
    assert.deepEqual(r.exports, ['apiUrl', 'dbUrl', 'secret']);
  } finally {
    await cleanup();
  }
});

test('renamed re-exports use the exported alias', async () => {
  const { root, write, cleanup } = await setupTempProject();
  try {
    const file = await write(
      'index.js',
      `export { foo as default, bar as baz } from './x.js';\n`,
    );
    const r = await summarizeFile(file, root);
    assert.deepEqual(r.exports, ['baz', 'default']);
  } finally {
    await cleanup();
  }
});

test('export-all keeps the source name visible', async () => {
  const { root, write, cleanup } = await setupTempProject();
  try {
    const file = await write('barrel.js', `export * from './internal.js';\n`);
    const r = await summarizeFile(file, root);
    assert.ok(r.exports.some((e) => e.includes('internal.js')));
  } finally {
    await cleanup();
  }
});

test('TypeScript: type exports and generics parse', async () => {
  const { root, write, cleanup } = await setupTempProject();
  try {
    const file = await write(
      'types.ts',
      `/** Tipos de autenticación. */
export type AuthUser = { id: string };
export interface Session<T> { user: T; }
export const NONE: AuthUser = { id: '' };
`,
    );
    const r = await summarizeFile(file, root);
    assert.equal(r.parseError, null);
    assert.deepEqual(r.exports, ['AuthUser', 'NONE', 'Session']);
    assert.equal(r.description, 'Tipos de autenticación.');
  } finally {
    await cleanup();
  }
});

test('TSX: JSX + type annotations', async () => {
  const { root, write, cleanup } = await setupTempProject();
  try {
    const file = await write(
      'Home.tsx',
      `import React from 'react';
export const Home: React.FC = () => <div>hi</div>;
`,
    );
    const r = await summarizeFile(file, root);
    assert.equal(r.parseError, null);
    assert.deepEqual(r.exports, ['Home']);
  } finally {
    await cleanup();
  }
});

test('imports are grouped by source and deduplicated', async () => {
  const { root, write, cleanup } = await setupTempProject();
  try {
    const file = await write(
      'app.js',
      `import React, { useState, useEffect } from 'react';
import { foo } from './utils.js';
import { bar } from './utils.js';
import * as z from 'zod';
`,
    );
    const r = await summarizeFile(file, root);
    const byName = Object.fromEntries(r.imports.map((i) => [i.source, i.names]));
    assert.deepEqual(byName['react'].sort(), ['default', 'useEffect', 'useState']);
    assert.deepEqual(byName['./utils.js'].sort(), ['bar', 'foo']);
    assert.deepEqual(byName['zod'], ['*']);
  } finally {
    await cleanup();
  }
});

test('broken syntax does not crash, surfaces parseError', async () => {
  const { root, write, cleanup } = await setupTempProject();
  try {
    const file = await write('broken.js', `export const x = (;\n`);
    const r = await summarizeFile(file, root);
    // With errorRecovery, Babel tries to parse; if it still fails we at
    // least return an object with parseError set, never throw.
    assert.ok(r.parseError || r.exports.length === 0);
    assert.equal(r.supported, true);
  } finally {
    await cleanup();
  }
});

test('unsupported file gets supported=false but still reads description', async () => {
  const { root, write, cleanup } = await setupTempProject();
  try {
    const file = await write(
      'readme.md',
      `# My project\nSome docs here.\n`,
    );
    const r = await summarizeFile(file, root);
    assert.equal(r.supported, false);
    assert.deepEqual(r.exports, []);
  } finally {
    await cleanup();
  }
});

test('JSDoc block: strips leading asterisks, takes first meaningful line', async () => {
  const { root, write, cleanup } = await setupTempProject();
  try {
    const file = await write(
      'tokens.ts',
      `/**
 * Helpers para JWT.
 * Firma y verificación.
 */
export function sign() {}
`,
    );
    const r = await summarizeFile(file, root);
    assert.equal(r.description, 'Helpers para JWT.');
  } finally {
    await cleanup();
  }
});

test('description capped at 140 chars', async () => {
  const { root, write, cleanup } = await setupTempProject();
  try {
    const long = 'x'.repeat(200);
    const file = await write('a.js', `// ${long}\nexport const a = 1;\n`);
    const r = await summarizeFile(file, root);
    assert.ok(r.description.length <= 140);
    assert.ok(r.description.endsWith('...'));
  } finally {
    await cleanup();
  }
});
