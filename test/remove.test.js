/**
 * Tests for `storm project remove`: storm leaves an imported project and
 * the user's code/files stay exactly as they were.
 *
 * Run: node --test test/remove.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { writeImport } from '../src/commands/import.js';
import { planRemoval, removeStorm } from '../src/commands/remove.js';

const exists = (p) => stat(p).then(() => true, () => false);

async function importedProject(t, agent, files = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'storm-remove-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userFiles = {
    'package.json': '{"name":"app"}',
    'src/api/pacientes.js': 'export function listar() { return []; }\n',
    '.gitignore': 'node_modules\n',
    ...files,
  };
  for (const [rel, content] of Object.entries(userFiles)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content);
  }
  await writeImport({
    projectRoot: root,
    name: 'app',
    description: '',
    stackId: 'other',
    databaseId: 'other',
    model: { provider: agent === 'opencode' ? 'via-opencode' : 'via-claude-code', name: null },
    agent,
    branches: [{ path: 'src' }],
    skills: [],
    agents: [],
    overwriteClaudeMd: !files['CLAUDE.md'] && !files['AGENTS.md'],
  });
  return { root, userFiles };
}

async function listAll(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listAll(abs, base)));
    else out.push(path.relative(base, abs).replaceAll('\\', '/'));
  }
  return out.sort();
}

test('removeStorm (claude-code): only the user files remain, unchanged', async (t) => {
  const { root, userFiles } = await importedProject(t, 'claude-code');
  assert.ok(await exists(path.join(root, 'CLAUDE.md')));
  assert.ok(await exists(path.join(root, '.context-compact/functions.json')));

  await removeStorm(root);
  assert.deepEqual(await listAll(root), Object.keys(userFiles).sort());
  for (const [rel, content] of Object.entries(userFiles)) {
    assert.equal(await readFile(path.join(root, rel), 'utf8'), content, rel);
  }
});

test('removeStorm (opencode): cleans AGENTS.md, .opencode and opencode.json', async (t) => {
  const { root, userFiles } = await importedProject(t, 'opencode');
  assert.ok(await exists(path.join(root, 'AGENTS.md')));
  await removeStorm(root);
  assert.deepEqual(await listAll(root), Object.keys(userFiles).sort());
});

test('removeStorm keeps a hand-written CLAUDE.md and user settings in opencode.json', async (t) => {
  const { root } = await importedProject(t, 'opencode', {
    'CLAUDE.md': '# Mis notas\n',
    'opencode.json': JSON.stringify({ theme: 'dark' }),
  });
  const plan = await planRemoval(root);
  assert.ok(plan.keep.includes('CLAUDE.md'));
  await removeStorm(root);
  assert.equal(await readFile(path.join(root, 'CLAUDE.md'), 'utf8'), '# Mis notas\n');
  const native = JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8'));
  assert.equal(native.theme, 'dark');
  assert.equal(native.model, undefined);
  assert.equal(await exists(path.join(root, 'project.config.json')), false);
});

test('planRemoval refuses folders that are not storm projects', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'storm-remove-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(planRemoval(root), /no es un proyecto storm/);
});
