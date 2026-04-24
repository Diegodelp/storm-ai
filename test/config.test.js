/**
 * Tests for src/core/config.js
 * Run with: node --test test/config.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readConfig, writeConfig, createConfig, ConfigError } from '../src/core/config.js';

async function tmpRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'storm-config-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('createConfig fills sane defaults', () => {
  const c = createConfig({ name: 'my-app' });
  assert.equal(c.version, 1);
  assert.equal(c.name, 'my-app');
  assert.deepEqual(c.skills, []);
  assert.deepEqual(c.agents, []);
  assert.equal(c.compact_context.enabled, true);
  assert.equal(c.compact_context.auto_refresh_threshold, 5);
  assert.equal(c.compact_context.map_files_per_branch, 10);
  assert.equal(c.compact_context.watcher.enabled, false);
  assert.match(c.compact_context.watcher.comment, /v0\.2/);
});

test('createConfig rejects empty name', () => {
  assert.throws(() => createConfig({ name: '   ' }), ConfigError);
});

test('round-trip: write then read preserves data', async () => {
  const { root, cleanup } = await tmpRoot();
  try {
    const orig = createConfig({
      name: 'test',
      description: 'Test project',
      stack: 'Next.js',
      skills: [{ name: 'ui-components', builtin: false }],
      branches: [{ path: 'src/auth', description: 'Auth stuff', pinned: ['index.ts'] }],
    });
    await writeConfig(root, orig);
    const back = await readConfig(root);
    assert.equal(back.name, 'test');
    assert.equal(back.stack, 'Next.js');
    assert.equal(back.skills[0].name, 'ui-components');
    assert.equal(back.compact_context.branches[0].path, 'src/auth');
    assert.deepEqual(back.compact_context.branches[0].pinned, ['index.ts']);
  } finally {
    await cleanup();
  }
});

test('readConfig throws friendly error when missing', async () => {
  const { root, cleanup } = await tmpRoot();
  try {
    await assert.rejects(() => readConfig(root), /storm new/);
  } finally {
    await cleanup();
  }
});

test('readConfig rejects invalid JSON', async () => {
  const { root, cleanup } = await tmpRoot();
  try {
    await writeFile(path.join(root, 'project.config.json'), '{ not valid', 'utf8');
    await assert.rejects(() => readConfig(root), /not valid JSON/);
  } finally {
    await cleanup();
  }
});

test('branch paths are normalized (trailing slash, backslashes)', async () => {
  const { root, cleanup } = await tmpRoot();
  try {
    await writeFile(
      path.join(root, 'project.config.json'),
      JSON.stringify({
        version: 1,
        name: 'x',
        compact_context: {
          branches: [{ path: 'src\\auth/' }],
        },
      }),
      'utf8',
    );
    const c = await readConfig(root);
    assert.equal(c.compact_context.branches[0].path, 'src/auth');
  } finally {
    await cleanup();
  }
});

test('duplicate branch paths are rejected', async () => {
  const { root, cleanup } = await tmpRoot();
  try {
    await writeFile(
      path.join(root, 'project.config.json'),
      JSON.stringify({
        version: 1,
        name: 'x',
        compact_context: {
          branches: [{ path: 'src/ui' }, { path: 'src/ui' }],
        },
      }),
      'utf8',
    );
    await assert.rejects(() => readConfig(root), /Duplicate branch/);
  } finally {
    await cleanup();
  }
});

test('duplicate skills are rejected', () => {
  assert.throws(
    () => createConfig({
      name: 'x',
      skills: [{ name: 'ui' }, { name: 'ui' }],
    }),
    /Duplicate skill/,
  );
});

test('newer config version is rejected', async () => {
  const { root, cleanup } = await tmpRoot();
  try {
    await writeFile(
      path.join(root, 'project.config.json'),
      JSON.stringify({ version: 99, name: 'x' }),
      'utf8',
    );
    await assert.rejects(() => readConfig(root), /newer/);
  } finally {
    await cleanup();
  }
});

test('auto_refresh_threshold must be positive integer', async () => {
  const { root, cleanup } = await tmpRoot();
  try {
    await writeFile(
      path.join(root, 'project.config.json'),
      JSON.stringify({
        version: 1,
        name: 'x',
        compact_context: { auto_refresh_threshold: 0 },
      }),
      'utf8',
    );
    await assert.rejects(() => readConfig(root), /positive integer/);
  } finally {
    await cleanup();
  }
});

test('unknown top-level fields are preserved (forward-compat)', async () => {
  const { root, cleanup } = await tmpRoot();
  try {
    await writeFile(
      path.join(root, 'project.config.json'),
      JSON.stringify({
        version: 1,
        name: 'x',
        experimental_feature: { foo: 'bar' },
      }),
      'utf8',
    );
    const c = await readConfig(root);
    assert.deepEqual(c.experimental_feature, { foo: 'bar' });
  } finally {
    await cleanup();
  }
});

test('writeConfig outputs without BOM', async () => {
  const { root, cleanup } = await tmpRoot();
  try {
    const c = createConfig({ name: 'x' });
    await writeConfig(root, c);
    const raw = await (await import('node:fs/promises')).readFile(
      path.join(root, 'project.config.json'),
    );
    // First three bytes must NOT be EF BB BF.
    assert.notEqual(raw[0], 0xef);
  } finally {
    await cleanup();
  }
});
