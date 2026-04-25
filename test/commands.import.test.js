/**
 * Tests for src/commands/import.js
 *
 * We mock the LLM by intercepting fetch — the real network never gets called.
 *
 * Run: node --test test/commands.import.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { writeImport, detectConflicts } from '../src/commands/import.js';

async function tmpProject(setup) {
  const dir = path.join(tmpdir(), `storm-import-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  if (setup) await setup(dir);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

test('writeImport: scaffolds a fresh project', async () => {
  const { dir, cleanup } = await tmpProject(async (d) => {
    await writeFile(path.join(d, 'package.json'), '{"name":"foo"}');
  });
  try {
    const result = await writeImport({
      projectRoot: dir,
      name: 'foo',
      description: 'A foo project',
      stackId: 'nextjs-app',
      databaseId: 'postgres',
      model: { provider: 'ollama-cloud', model: 'kimi-k2.6:cloud' },
      branches: [
        { path: 'app/api', description: 'Routes' },
      ],
      skills: [
        { name: 'auth-reviewer', description: 'review auth' },
      ],
      agents: [
        { name: 'API Reviewer', slash: 'api-reviewer', description: 'reviews api code' },
      ],
    });

    assert.ok(result.createdFiles.includes('project.config.json'));
    assert.ok(result.createdFiles.includes('CLAUDE.md'));
    assert.ok(result.createdFiles.includes('TASKS.md'));
    assert.ok(result.createdFiles.some((f) => f.includes('auth-reviewer.md')));
    assert.ok(result.createdFiles.some((f) => f.includes('api-reviewer.md')));

    // Verify config persisted with stackId.
    const config = JSON.parse(await readFile(path.join(dir, 'project.config.json'), 'utf8'));
    assert.equal(config.stackId, 'nextjs-app');
    assert.equal(config.databaseId, 'postgres');

    // Verify CLAUDE.md mentions stack convention.
    const claudeMd = await readFile(path.join(dir, 'CLAUDE.md'), 'utf8');
    assert.match(claudeMd, /Convenciones de ramas/);
    assert.match(claudeMd, /app\/api/);
  } finally {
    await cleanup();
  }
});

test('writeImport: respects overwriteClaudeMd=false', async () => {
  const { dir, cleanup } = await tmpProject(async (d) => {
    await writeFile(path.join(d, 'CLAUDE.md'), '# Pre-existing\n\nHand-written.\n');
  });
  try {
    const result = await writeImport({
      projectRoot: dir,
      name: 'x',
      description: '',
      stackId: 'other',
      databaseId: 'none',
      branches: [],
      skills: [],
      agents: [],
      overwriteClaudeMd: false,
    });

    assert.ok(result.skippedFiles.includes('CLAUDE.md'));
    const claudeMd = await readFile(path.join(dir, 'CLAUDE.md'), 'utf8');
    assert.match(claudeMd, /Hand-written/);
  } finally {
    await cleanup();
  }
});

test('writeImport: respects overwriteConfig=false', async () => {
  const { dir, cleanup } = await tmpProject(async (d) => {
    await writeFile(path.join(d, 'project.config.json'), '{"version":1,"name":"old","stack":"old"}');
  });
  try {
    const result = await writeImport({
      projectRoot: dir,
      name: 'new',
      description: '',
      stackId: 'other',
      databaseId: 'none',
      branches: [],
      skills: [],
      agents: [],
      overwriteConfig: false,
    });
    assert.ok(result.skippedFiles.includes('project.config.json'));
    const config = JSON.parse(await readFile(path.join(dir, 'project.config.json'), 'utf8'));
    assert.equal(config.name, 'old');
  } finally {
    await cleanup();
  }
});

test('detectConflicts: identifies pre-existing storm files', async () => {
  const { dir, cleanup } = await tmpProject(async (d) => {
    await writeFile(path.join(d, 'CLAUDE.md'), '');
    await writeFile(path.join(d, 'project.config.json'), '{}');
    await mkdir(path.join(d, '.context-compact'), { recursive: true });
  });
  try {
    const c = await detectConflicts(dir);
    assert.equal(c.claudeMd, true);
    assert.equal(c.config, true);
    assert.equal(c.tasks, false); // not present
    assert.equal(c.contextDir, true);
  } finally {
    await cleanup();
  }
});

test('writeImport: does not overwrite existing skill files', async () => {
  const { dir, cleanup } = await tmpProject(async (d) => {
    await mkdir(path.join(d, '.claude/skills'), { recursive: true });
    await writeFile(
      path.join(d, '.claude/skills/auth-reviewer.md'),
      '# Existing skill\n',
    );
  });
  try {
    const result = await writeImport({
      projectRoot: dir,
      name: 'x',
      description: '',
      stackId: 'other',
      databaseId: 'none',
      branches: [],
      skills: [{ name: 'auth-reviewer', description: 'new desc' }],
      agents: [],
    });
    assert.ok(result.skippedFiles.some((f) => f.includes('auth-reviewer')));
    const body = await readFile(path.join(dir, '.claude/skills/auth-reviewer.md'), 'utf8');
    assert.match(body, /Existing skill/);
  } finally {
    await cleanup();
  }
});

test('writeImport: built-in slash commands are written', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    const result = await writeImport({
      projectRoot: dir,
      name: 'x',
      description: '',
      stackId: 'other',
      databaseId: 'none',
      branches: [],
      skills: [],
      agents: [],
    });
    assert.ok(result.createdFiles.some((f) => f.includes('refresh-compact.md')));
    assert.ok(result.createdFiles.some((f) => f.includes('task-add.md')));
    assert.ok(result.createdFiles.some((f) => f.includes('task-done.md')));
  } finally {
    await cleanup();
  }
});
