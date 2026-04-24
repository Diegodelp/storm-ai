/**
 * Tests for src/commands/task.js, refresh.js, and branch.js
 * Run: node --test test/commands.ops.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createProject } from '../src/commands/new.js';
import * as task from '../src/commands/task.js';
import { refresh } from '../src/commands/refresh.js';
import * as branch from '../src/commands/branch.js';

async function seedProject(opts = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), 'storm-ops-'));
  const r = await createProject({
    name: 'test',
    parentDir: parent,
    branches: opts.branches ?? [
      { path: 'src/auth', description: 'Auth' },
      { path: 'src/ui', description: 'UI' },
    ],
  });
  return { root: r.projectRoot, cleanup: () => rm(parent, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// task commands
// ---------------------------------------------------------------------------

test('task.add: creates a task with branches', async () => {
  const { root, cleanup } = await seedProject();
  try {
    const { task: t } = await task.add({
      cwd: root,
      title: 'Implement login',
      description: 'Email + password',
      branches: ['src/auth'],
    });
    assert.equal(t.id, 'T-001');
    assert.equal(t.status, 'pending');
    assert.deepEqual(t.branches, ['src/auth']);
  } finally {
    await cleanup();
  }
});

test('task.start / task.done: full lifecycle', async () => {
  const { root, cleanup } = await seedProject();
  try {
    await task.add({ cwd: root, title: 'x' });
    const started = await task.start({ cwd: root, id: 'T-001' });
    assert.equal(started.task.status, 'in_progress');
    const done = await task.done({ cwd: root, id: 'T-001' });
    assert.equal(done.task.status, 'done');
    assert.ok(done.task.completed_at);
    assert.equal(done.shouldRefresh, false); // threshold default is 5
  } finally {
    await cleanup();
  }
});

test('task.done: shouldRefresh fires at threshold', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'storm-ops-'));
  try {
    const r = await createProject({ name: 'test', parentDir: parent });
    // Lower the threshold by editing the config. We write directly to
    // test the behavior; the CLI would expose this via `storm config set`.
    const { readConfig, writeConfig } = await import('../src/core/config.js');
    const cfg = await readConfig(r.projectRoot);
    cfg.compact_context.auto_refresh_threshold = 2;
    await writeConfig(r.projectRoot, cfg);
    // The counter lives in task-state.json, not config, so we also need
    // to sync it there on next mutation. We do that via a task add.
    const { readState, writeState } = await import('../src/core/tasks.js');
    const st = await readState(r.projectRoot);
    st.counters.auto_refresh_threshold = 2;
    await writeState(r.projectRoot, st);

    await task.add({ cwd: r.projectRoot, title: 'a' });
    await task.add({ cwd: r.projectRoot, title: 'b' });

    const r1 = await task.done({ cwd: r.projectRoot, id: 'T-001' });
    assert.equal(r1.shouldRefresh, false);
    const r2 = await task.done({ cwd: r.projectRoot, id: 'T-002' });
    assert.equal(r2.shouldRefresh, true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('task.list: filters by status', async () => {
  const { root, cleanup } = await seedProject();
  try {
    await task.add({ cwd: root, title: 'a' });
    await task.add({ cwd: root, title: 'b' });
    await task.done({ cwd: root, id: 'T-001' });
    const listed = await task.list({ cwd: root, status: 'done' });
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0].id, 'T-001');
  } finally {
    await cleanup();
  }
});

test('task.note: appends note to task', async () => {
  const { root, cleanup } = await seedProject();
  try {
    await task.add({ cwd: root, title: 'x' });
    await task.note({ cwd: root, id: 'T-001', content: 'Testing a note' });
    const { tasks } = await task.list({ cwd: root });
    assert.equal(tasks[0].notes.length, 1);
    assert.match(tasks[0].notes[0].content, /Testing/);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

test('refresh: resets counter and returns stats', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'storm-ops-'));
  try {
    const r = await createProject({
      name: 'test',
      parentDir: parent,
      branches: [{ path: 'src/auth', description: 'Auth' }],
    });

    // Force counter > 0
    const { readState, writeState } = await import('../src/core/tasks.js');
    const st = await readState(r.projectRoot);
    st.counters.done_since_refresh = 3;
    await writeState(r.projectRoot, st);

    const res = await refresh({ cwd: r.projectRoot });
    assert.equal(res.counterBefore, 3);

    const stAfter = await readState(r.projectRoot);
    assert.equal(stAfter.counters.done_since_refresh, 0);
    assert.ok(stAfter.counters.last_refresh_at);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// branch
// ---------------------------------------------------------------------------

test('branch.add: appends a branch and refreshes compact', async () => {
  const { root, cleanup } = await seedProject({ branches: [] });
  try {
    const res = await branch.add({
      cwd: root,
      path: 'src/auth',
      description: 'Auth',
    });
    assert.equal(res.branch, 'src/auth');
    const authMd = await readFile(
      path.join(root, '.context-compact', 'src-auth.md'),
      'utf8',
    );
    assert.match(authMd, /# src\/auth/);
  } finally {
    await cleanup();
  }
});

test('branch.add: rejects duplicate', async () => {
  const { root, cleanup } = await seedProject();
  try {
    await assert.rejects(
      () => branch.add({ cwd: root, path: 'src/auth' }),
      /already exists/,
    );
  } finally {
    await cleanup();
  }
});

test('branch.remove: warns about tasks still referencing it', async () => {
  const { root, cleanup } = await seedProject();
  try {
    await task.add({ cwd: root, title: 'x', branches: ['src/auth'] });
    const res = await branch.remove({ cwd: root, path: 'src/auth' });
    assert.ok(res.warnings.some((w) => /still reference/.test(w)));
  } finally {
    await cleanup();
  }
});

test('branch.pin: adds pins and refreshes', async () => {
  const { root, cleanup } = await seedProject();
  try {
    const res = await branch.pin({
      cwd: root,
      path: 'src/auth',
      files: ['index.ts', 'login.ts'],
    });
    assert.deepEqual(res.pinned, ['index.ts', 'login.ts']);
  } finally {
    await cleanup();
  }
});

test('branch.unpin: removes specific files', async () => {
  const { root, cleanup } = await seedProject();
  try {
    await branch.pin({
      cwd: root,
      path: 'src/auth',
      files: ['index.ts', 'login.ts'],
    });
    const res = await branch.unpin({
      cwd: root,
      path: 'src/auth',
      files: ['login.ts'],
    });
    assert.deepEqual(res.pinned, ['index.ts']);
  } finally {
    await cleanup();
  }
});

test('branch.list: returns current branches', async () => {
  const { root, cleanup } = await seedProject();
  try {
    const res = await branch.list({ cwd: root });
    assert.equal(res.branches.length, 2);
    assert.deepEqual(
      res.branches.map((b) => b.path).sort(),
      ['src/auth', 'src/ui'],
    );
  } finally {
    await cleanup();
  }
});
