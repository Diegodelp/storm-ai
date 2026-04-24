/**
 * Tests for src/core/tasks.js
 * Run with: node --test test/tasks.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  addTask,
  setStatus,
  addNote,
  markRefreshed,
  listTasks,
  readState,
  VALID_STATUSES,
  TaskStateError,
} from '../src/core/tasks.js';

/**
 * Set up a temp project with a valid task-state.json.
 */
async function setupProject({ branches = [], threshold = 5 } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'storm-tasks-'));
  const initial = {
    version: 1,
    project: { name: 'test', created_at: new Date().toISOString() },
    counters: {
      done_since_refresh: 0,
      auto_refresh_threshold: threshold,
      last_refresh_at: null,
    },
    branches_index: branches,
    tasks: [],
  };
  await mkdir(path.join(root, '.context-compact'), { recursive: true });
  await writeFile(
    path.join(root, '.context-compact', 'task-state.json'),
    JSON.stringify(initial, null, 2),
    'utf8',
  );
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('addTask: creates T-001 on empty project', async () => {
  const { root, cleanup } = await setupProject();
  try {
    const t = await addTask(root, { title: 'First thing' });
    assert.equal(t.id, 'T-001');
    assert.equal(t.status, 'pending');
    assert.equal(t.completed_at, null);
    assert.deepEqual(t.branches, []);
  } finally {
    await cleanup();
  }
});

test('addTask: sequential IDs', async () => {
  const { root, cleanup } = await setupProject();
  try {
    const a = await addTask(root, { title: 'A' });
    const b = await addTask(root, { title: 'B' });
    const c = await addTask(root, { title: 'C' });
    assert.equal(a.id, 'T-001');
    assert.equal(b.id, 'T-002');
    assert.equal(c.id, 'T-003');
  } finally {
    await cleanup();
  }
});

test('addTask: empty title is rejected', async () => {
  const { root, cleanup } = await setupProject();
  try {
    await assert.rejects(() => addTask(root, { title: '   ' }), TaskStateError);
  } finally {
    await cleanup();
  }
});

test('addTask: validates branches against index', async () => {
  const { root, cleanup } = await setupProject({ branches: ['src/auth', 'src/ui'] });
  try {
    // Valid
    const ok = await addTask(root, { title: 'ok', branches: ['src/auth'] });
    assert.deepEqual(ok.branches, ['src/auth']);

    // Typo
    await assert.rejects(
      () => addTask(root, { title: 'bad', branches: ['src/autth'] }),
      /Unknown branch/,
    );
  } finally {
    await cleanup();
  }
});

test('setStatus: pending -> in_progress -> done updates timestamps', async () => {
  const { root, cleanup } = await setupProject();
  try {
    const t = await addTask(root, { title: 'x' });
    assert.equal(t.status, 'pending');

    const { task: started } = await setStatus(root, t.id, 'in_progress');
    assert.equal(started.status, 'in_progress');
    assert.equal(started.completed_at, null);

    const { task: finished } = await setStatus(root, t.id, 'done');
    assert.equal(finished.status, 'done');
    assert.ok(finished.completed_at); // timestamp set
  } finally {
    await cleanup();
  }
});

test('setStatus: invalid status throws', async () => {
  const { root, cleanup } = await setupProject();
  try {
    const t = await addTask(root, { title: 'x' });
    await assert.rejects(() => setStatus(root, t.id, 'blocked'), TaskStateError);
  } finally {
    await cleanup();
  }
});

test('setStatus: unknown id throws', async () => {
  const { root, cleanup } = await setupProject();
  try {
    await assert.rejects(() => setStatus(root, 'T-999', 'done'), /not found/);
  } finally {
    await cleanup();
  }
});

test('counter: only increments on pending -> done transition', async () => {
  const { root, cleanup } = await setupProject({ threshold: 5 });
  try {
    const t = await addTask(root, { title: 'x' });

    await setStatus(root, t.id, 'done');
    let s = await readState(root);
    assert.equal(s.counters.done_since_refresh, 1);

    // Going done -> done again should NOT re-increment.
    await setStatus(root, t.id, 'done');
    s = await readState(root);
    assert.equal(s.counters.done_since_refresh, 1);

    // Going done -> cancelled should not decrement either (we only count
    // forward transitions). We accept some counter drift — simpler.
    await setStatus(root, t.id, 'cancelled');
    s = await readState(root);
    assert.equal(s.counters.done_since_refresh, 1);
  } finally {
    await cleanup();
  }
});

test('shouldRefresh fires at threshold', async () => {
  const { root, cleanup } = await setupProject({ threshold: 3 });
  try {
    const a = await addTask(root, { title: 'a' });
    const b = await addTask(root, { title: 'b' });
    const c = await addTask(root, { title: 'c' });

    const r1 = await setStatus(root, a.id, 'done');
    assert.equal(r1.shouldRefresh, false);

    const r2 = await setStatus(root, b.id, 'done');
    assert.equal(r2.shouldRefresh, false);

    const r3 = await setStatus(root, c.id, 'done');
    assert.equal(r3.shouldRefresh, true);
  } finally {
    await cleanup();
  }
});

test('markRefreshed resets counter and sets timestamp', async () => {
  const { root, cleanup } = await setupProject({ threshold: 2 });
  try {
    const a = await addTask(root, { title: 'a' });
    const b = await addTask(root, { title: 'b' });
    await setStatus(root, a.id, 'done');
    await setStatus(root, b.id, 'done');

    await markRefreshed(root);
    const s = await readState(root);
    assert.equal(s.counters.done_since_refresh, 0);
    assert.ok(s.counters.last_refresh_at);
  } finally {
    await cleanup();
  }
});

test('addNote appends to the task notes array', async () => {
  const { root, cleanup } = await setupProject();
  try {
    const t = await addTask(root, { title: 'x' });
    await addNote(root, t.id, 'Decidimos usar JWT sin cookies.');
    await addNote(root, t.id, 'Revisar rate limit en login.');
    const s = await readState(root);
    const task = s.tasks.find((x) => x.id === t.id);
    assert.equal(task.notes.length, 2);
    assert.match(task.notes[0].content, /JWT/);
  } finally {
    await cleanup();
  }
});

test('listTasks filters by status and branch', async () => {
  const { root, cleanup } = await setupProject({ branches: ['src/auth', 'src/ui'] });
  try {
    const a = await addTask(root, { title: 'a', branches: ['src/auth'] });
    const b = await addTask(root, { title: 'b', branches: ['src/ui'] });
    await addTask(root, { title: 'c' });
    await setStatus(root, a.id, 'done');

    const done = await listTasks(root, { status: 'done' });
    assert.equal(done.length, 1);

    const auth = await listTasks(root, { branch: 'src/auth' });
    assert.equal(auth.length, 1);
    assert.equal(auth[0].title, 'a');

    // combined
    const authDone = await listTasks(root, { status: 'done', branch: 'src/auth' });
    assert.equal(authDone.length, 1);
  } finally {
    await cleanup();
  }
});

test('TASKS.md is regenerated with all status sections', async () => {
  const { root, cleanup } = await setupProject();
  try {
    const a = await addTask(root, { title: 'Implement login' });
    const b = await addTask(root, { title: 'Build home page' });
    await setStatus(root, a.id, 'in_progress');
    await setStatus(root, b.id, 'done');

    const md = await readFile(path.join(root, 'TASKS.md'), 'utf8');
    assert.match(md, /## In progress/);
    assert.match(md, /Implement login/);
    assert.match(md, /## Done/);
    assert.match(md, /Build home page/);
    assert.match(md, /## Pending\n_None_/);
  } finally {
    await cleanup();
  }
});

test('readState on missing file throws a friendly error', async () => {
  const empty = await mkdtemp(path.join(tmpdir(), 'storm-empty-'));
  try {
    await assert.rejects(() => readState(empty), /storm project/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test('VALID_STATUSES contains exactly the four agreed states', () => {
  assert.deepEqual([...VALID_STATUSES].sort(), [
    'cancelled',
    'done',
    'in_progress',
    'pending',
  ]);
});
