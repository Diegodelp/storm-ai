/**
 * Tests for src/commands/skill.js
 *
 * Run: node --test test/commands.skill.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addSkill, listSkills, removeSkill } from '../src/commands/skill.js';
import { createProject } from '../src/commands/new.js';

async function tmpParent() {
  const dir = path.join(tmpdir(), `storm-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('addSkill: creates the .md file and tracks it in config', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    const r = await createProject({ name: 'app', parentDir: dir });

    const result = await addSkill({
      cwd: r.projectRoot,
      projectRoot: r.projectRoot,
      name: 'auth-flow-reviewer',
      description: 'Revisa el flujo de auth',
      branches: ['src/auth'],
    });

    assert.equal(result.created, true);
    assert.equal(result.slug, 'auth-flow-reviewer');

    // File must exist.
    const stats = await stat(result.file);
    assert.ok(stats.isFile());

    // Body should contain the description and the branch.
    const body = await readFile(result.file, 'utf8');
    assert.match(body, /auth-flow-reviewer/);
    assert.match(body, /Revisa el flujo de auth/);
    assert.match(body, /src\/auth/);

    // Config should track it as non-builtin.
    const skills = await listSkills({ projectRoot: r.projectRoot });
    const ours = skills.find((s) => s.name === 'auth-flow-reviewer');
    assert.ok(ours);
    assert.equal(ours.builtin, false);
  } finally {
    await cleanup();
  }
});

test('addSkill: idempotent on repeated names', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    const r = await createProject({ name: 'app', parentDir: dir });

    const a = await addSkill({
      cwd: r.projectRoot,
      projectRoot: r.projectRoot,
      name: 'mySkill',
      description: 'first',
    });
    assert.equal(a.created, true);

    const b = await addSkill({
      cwd: r.projectRoot,
      projectRoot: r.projectRoot,
      name: 'mySkill',
      description: 'second',
    });
    // Same slug, no recreation.
    assert.equal(b.created, false);
    assert.equal(b.slug, a.slug);
  } finally {
    await cleanup();
  }
});

test('listSkills: includes built-ins', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    const r = await createProject({
      name: 'app',
      parentDir: dir,
      skills: [
        { name: 'plan-systematic' },
        { name: 'compact-route' },
        { name: 'refresh-compact' },
      ],
    });

    const skills = await listSkills({ projectRoot: r.projectRoot });
    const builtins = skills.filter((s) => s.builtin);
    assert.ok(builtins.length >= 3);
  } finally {
    await cleanup();
  }
});

test('removeSkill: deletes a custom skill', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    const r = await createProject({ name: 'app', parentDir: dir });
    const added = await addSkill({
      cwd: r.projectRoot,
      projectRoot: r.projectRoot,
      name: 'temp-skill',
    });

    const removed = await removeSkill({
      projectRoot: r.projectRoot,
      name: 'temp-skill',
    });
    assert.equal(removed.removed, true);

    // File should be gone.
    let exists = true;
    try { await stat(added.file); } catch { exists = false; }
    assert.equal(exists, false);

    // Not in config any more.
    const skills = await listSkills({ projectRoot: r.projectRoot });
    assert.ok(!skills.find((s) => s.name === 'temp-skill'));
  } finally {
    await cleanup();
  }
});

test('removeSkill: protects built-ins', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    const r = await createProject({
      name: 'app',
      parentDir: dir,
      skills: [{ name: 'plan-systematic' }],
    });

    const result = await removeSkill({
      projectRoot: r.projectRoot,
      name: 'plan-systematic',
    });
    assert.equal(result.removed, false);
    assert.match(result.reason, /built-in/);
  } finally {
    await cleanup();
  }
});

test('removeSkill: returns error for unknown skill', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    const r = await createProject({ name: 'app', parentDir: dir });
    const result = await removeSkill({
      projectRoot: r.projectRoot,
      name: 'never-existed',
    });
    assert.equal(result.removed, false);
    assert.match(result.reason, /No existe/);
  } finally {
    await cleanup();
  }
});
