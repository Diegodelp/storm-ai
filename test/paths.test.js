/**
 * Tests for src/core/paths.js
 * Run with: node --test test/paths.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  findProjectRoot,
  requireProjectRoot,
  safeName,
  projectPaths,
  fileExists,
} from '../src/core/paths.js';

test('findProjectRoot: finds marker in current dir', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'storm-paths-'));
  try {
    await writeFile(path.join(root, 'project.config.json'), '{}', 'utf8');
    const found = await findProjectRoot(root);
    assert.equal(found, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('findProjectRoot: walks up from subdirectory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'storm-paths-'));
  try {
    await writeFile(path.join(root, 'project.config.json'), '{}', 'utf8');
    const deep = path.join(root, 'src', 'components', 'header');
    await mkdir(deep, { recursive: true });
    const found = await findProjectRoot(deep);
    assert.equal(found, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('findProjectRoot: returns null when no marker found', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'storm-paths-nomarker-'));
  try {
    const found = await findProjectRoot(root);
    assert.equal(found, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('requireProjectRoot: throws with a "storm new" hint', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'storm-paths-req-'));
  try {
    await assert.rejects(() => requireProjectRoot(root), /storm new/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('safeName: lowercases and replaces spaces with dashes', () => {
  assert.equal(safeName('My Cool App'), 'my-cool-app');
});

test('safeName: strips symbols', () => {
  assert.equal(safeName('Hello! @World #2'), 'hello-world-2');
});

test('safeName: handles reserved Windows names', () => {
  assert.equal(safeName('con'), 'con-app');
  assert.equal(safeName('PRN'), 'prn-app');
  assert.equal(safeName('aux'), 'aux-app');
});

test('safeName: caps at 60 chars, trims trailing dash', () => {
  const n = safeName('a'.repeat(100));
  assert.ok(n.length <= 60);
  assert.ok(!n.endsWith('-'));
});

test('safeName: empty input becomes "untitled"', () => {
  assert.equal(safeName(''), 'untitled');
  assert.equal(safeName('   '), 'untitled');
  assert.equal(safeName('!!!'), 'untitled');
});

test('projectPaths returns consistent absolute paths', () => {
  const root = '/tmp/my-project';
  assert.equal(projectPaths.config(root), path.join(root, 'project.config.json'));
  assert.equal(projectPaths.taskState(root), path.join(root, '.context-compact', 'task-state.json'));
  assert.equal(
    projectPaths.branchMd(root, 'src/auth'),
    path.join(root, '.context-compact', 'src-auth.md'),
  );
});

test('fileExists: returns true/false correctly', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'storm-paths-fe-'));
  try {
    const p = path.join(root, 'x.txt');
    assert.equal(await fileExists(p), false);
    await writeFile(p, 'hi', 'utf8');
    assert.equal(await fileExists(p), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
