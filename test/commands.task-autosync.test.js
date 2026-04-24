/**
 * Test that `storm task done` auto-runs sync.
 *
 * Run: node --test test/commands.task-autosync.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createProject } from '../src/commands/new.js';
import * as taskCmd from '../src/commands/task.js';

async function tmpParent() {
  const dir = path.join(tmpdir(), `storm-task-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('done() runs sync and reports new branches', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    const r = await createProject({
      name: 'app',
      parentDir: dir,
      stackId: 'nextjs-app',
      branches: [],
    });

    // Create a task.
    const added = await taskCmd.add({
      cwd: r.projectRoot,
      title: 'Add payments endpoint',
      branches: [],
    });
    const taskId = added.task.id;

    // Simulate the AI creating a new directory while working.
    await mkdir(path.join(r.projectRoot, 'app/api/payments'), { recursive: true });
    await writeFile(path.join(r.projectRoot, 'app/api/payments/route.js'), '// stub\n');

    // Mark the task done.
    const result = await taskCmd.done({ cwd: r.projectRoot, id: taskId });

    // sync should have run and reported the new branch.
    assert.ok(result.sync, 'expected result.sync to be present');
    const addedPaths = result.sync.added.map((b) => b.path);
    assert.ok(
      addedPaths.includes('app/api/payments'),
      `expected app/api/payments in added, got: ${addedPaths.join(', ')}`,
    );
  } finally {
    await cleanup();
  }
});

test('done() with auto_sync=false does NOT run sync', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    const r = await createProject({
      name: 'app',
      parentDir: dir,
      stackId: 'nextjs-app',
      branches: [],
    });

    // Disable auto_sync directly in the config file.
    const { readConfig, writeConfig } = await import('../src/core/config.js');
    const config = await readConfig(r.projectRoot);
    config.compact_context.auto_sync = false;
    await writeConfig(r.projectRoot, config);

    const added = await taskCmd.add({
      cwd: r.projectRoot,
      title: 'No sync this time',
      branches: [],
    });

    await mkdir(path.join(r.projectRoot, 'app/api/orphan'), { recursive: true });
    await writeFile(path.join(r.projectRoot, 'app/api/orphan/route.js'), '// stub\n');

    const result = await taskCmd.done({ cwd: r.projectRoot, id: added.task.id });

    // No sync field on the result.
    assert.equal(result.sync, undefined);
  } finally {
    await cleanup();
  }
});
