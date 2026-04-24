/**
 * Tests for src/commands/sync.js
 *
 * Creates a temp project on disk, drops some realistic source files
 * matching a stack's pattern, calls sync(), and verifies that branches
 * were registered correctly.
 *
 * Run: node --test test/commands.sync.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { sync } from '../src/commands/sync.js';
import { createProject } from '../src/commands/new.js';

async function tmpParent() {
  const dir = path.join(tmpdir(), `storm-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('sync: detects new branches under stack patterns', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    const r = await createProject({
      name: 'app',
      parentDir: dir,
      stackId: 'nextjs-app',
      stack: 'Next.js (App Router)',
      branches: [], // start with NO branches declared
    });

    // Simulate the AI creating a few service folders.
    const root = r.projectRoot;
    await mkdir(path.join(root, 'app/api/payments'), { recursive: true });
    await writeFile(path.join(root, 'app/api/payments/route.js'), '// stub\n');
    await mkdir(path.join(root, 'app/api/users'), { recursive: true });
    await writeFile(path.join(root, 'app/api/users/route.js'), '// stub\n');
    await mkdir(path.join(root, 'components/PaymentForm'), { recursive: true });
    await writeFile(path.join(root, 'components/PaymentForm/index.jsx'), '// stub\n');

    const report = await sync({ cwd: root, projectRoot: root, regenerate: false });

    const addedPaths = report.added.map((b) => b.path).sort();
    assert.deepEqual(
      addedPaths,
      ['app/api/payments', 'app/api/users', 'components/PaymentForm'],
    );

    // Each of the api branches should have a description from the hints.
    const apiBranch = report.added.find((b) => b.path === 'app/api/payments');
    assert.match(apiBranch.description, /Route handlers/i);
  } finally {
    await cleanup();
  }
});

test('sync: idempotent (calling twice does nothing the second time)', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    const r = await createProject({
      name: 'app',
      parentDir: dir,
      stackId: 'nextjs-app',
      branches: [],
    });
    await mkdir(path.join(r.projectRoot, 'lib/utils'), { recursive: true });
    await writeFile(path.join(r.projectRoot, 'lib/utils/x.js'), '// stub\n');

    const first = await sync({ cwd: r.projectRoot, projectRoot: r.projectRoot, regenerate: false });
    assert.equal(first.added.length, 1);

    const second = await sync({ cwd: r.projectRoot, projectRoot: r.projectRoot, regenerate: false });
    assert.equal(second.added.length, 0);
  } finally {
    await cleanup();
  }
});

test('sync: marks branch stale when its files vanish', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    const r = await createProject({
      name: 'app',
      parentDir: dir,
      stackId: 'nextjs-app',
      branches: [{ path: 'app/api/old', description: 'soon to be removed' }],
    });

    // The declared branch has no files on disk → should be marked stale.
    const report = await sync({ cwd: r.projectRoot, projectRoot: r.projectRoot, regenerate: false });
    assert.equal(report.markedStale.length, 1);
    assert.equal(report.markedStale[0].path, 'app/api/old');

    // Verify it persisted in the config.
    const config = JSON.parse(
      await readFile(path.join(r.projectRoot, 'project.config.json'), 'utf8'),
    );
    const stale = config.compact_context.branches.find((b) => b.path === 'app/api/old');
    assert.equal(stale.stale, true);
  } finally {
    await cleanup();
  }
});

test('sync: clears stale flag when files come back', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    const r = await createProject({
      name: 'app',
      parentDir: dir,
      stackId: 'nextjs-app',
      branches: [{ path: 'app/api/back', description: 'temporarily empty' }],
    });
    // First sync marks stale.
    await sync({ cwd: r.projectRoot, projectRoot: r.projectRoot, regenerate: false });

    // Now add a file.
    await mkdir(path.join(r.projectRoot, 'app/api/back'), { recursive: true });
    await writeFile(path.join(r.projectRoot, 'app/api/back/route.js'), '// stub\n');

    // Second sync should clear the stale flag.
    const report = await sync({ cwd: r.projectRoot, projectRoot: r.projectRoot, regenerate: false });
    assert.equal(report.clearedStale.length, 1);
    assert.equal(report.clearedStale[0].path, 'app/api/back');

    const config = JSON.parse(
      await readFile(path.join(r.projectRoot, 'project.config.json'), 'utf8'),
    );
    const branch = config.compact_context.branches.find((b) => b.path === 'app/api/back');
    assert.notEqual(branch.stale, true);
  } finally {
    await cleanup();
  }
});

test('sync: stack=other does nothing for new branches', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    const r = await createProject({
      name: 'app',
      parentDir: dir,
      stackId: 'other',
      branches: [],
    });
    await mkdir(path.join(r.projectRoot, 'src/whatever'), { recursive: true });
    await writeFile(path.join(r.projectRoot, 'src/whatever/x.js'), '// stub\n');

    const report = await sync({ cwd: r.projectRoot, projectRoot: r.projectRoot, regenerate: false });
    assert.equal(report.added.length, 0);
    // But it should warn about the missing stack patterns.
    assert.ok(report.warnings.length > 0);
  } finally {
    await cleanup();
  }
});

test('sync: deeper folders inside a matched dir do NOT become separate branches', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    const r = await createProject({
      name: 'app',
      parentDir: dir,
      stackId: 'nextjs-app',
      branches: [],
    });
    // app/api/payments matches `app/api/*`, but app/api/payments/utils
    // does NOT match `app/api/*` (depth mismatch).
    await mkdir(path.join(r.projectRoot, 'app/api/payments/utils'), { recursive: true });
    await writeFile(path.join(r.projectRoot, 'app/api/payments/route.js'), '// stub\n');
    await writeFile(path.join(r.projectRoot, 'app/api/payments/utils/x.js'), '// stub\n');

    const report = await sync({ cwd: r.projectRoot, projectRoot: r.projectRoot, regenerate: false });
    const added = report.added.map((b) => b.path);
    assert.ok(added.includes('app/api/payments'));
    assert.ok(!added.includes('app/api/payments/utils'));
  } finally {
    await cleanup();
  }
});
