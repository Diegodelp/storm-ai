/**
 * Tests for src/commands/new.js
 * Run: node --test test/commands.new.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createProject } from '../src/commands/new.js';

async function tmpParent() {
  const dir = await mkdtemp(path.join(tmpdir(), 'storm-new-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('createProject: minimal input produces a valid scaffold', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    const r = await createProject({ name: 'My App', parentDir: dir });
    assert.equal(r.safeName, 'my-app');
    assert.equal(r.projectRoot, path.join(dir, 'my-app'));

    // Required files exist
    const configRaw = await readFile(
      path.join(r.projectRoot, 'project.config.json'),
      'utf8',
    );
    const config = JSON.parse(configRaw);
    assert.equal(config.name, 'my-app');

    const claude = await readFile(path.join(r.projectRoot, 'CLAUDE.md'), 'utf8');
    assert.match(claude, /# my-app/);

    const tasksMd = await readFile(path.join(r.projectRoot, 'TASKS.md'), 'utf8');
    assert.match(tasksMd, /## In progress/);

    const state = JSON.parse(
      await readFile(
        path.join(r.projectRoot, '.context-compact', 'task-state.json'),
        'utf8',
      ),
    );
    assert.equal(state.project.name, 'my-app');
    assert.equal(state.tasks.length, 0);
  } finally {
    await cleanup();
  }
});

test('createProject: built-in skills are always merged', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    const r = await createProject({
      name: 'proj',
      parentDir: dir,
      skills: [{ name: 'ui-components', description: 'UI stuff' }],
    });
    const config = JSON.parse(
      await readFile(path.join(r.projectRoot, 'project.config.json'), 'utf8'),
    );
    const names = config.skills.map((s) => s.name);
    assert.ok(names.includes('compact-route'));
    assert.ok(names.includes('refresh-compact'));
    assert.ok(names.includes('plan-systematic'));
    assert.ok(names.includes('ui-components'));
  } finally {
    await cleanup();
  }
});

test('createProject: user skills with the same name as a built-in are deduped', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    const r = await createProject({
      name: 'proj',
      parentDir: dir,
      skills: [{ name: 'compact-route', description: 'my override' }],
    });
    const config = JSON.parse(
      await readFile(path.join(r.projectRoot, 'project.config.json'), 'utf8'),
    );
    // Only one 'compact-route', and it's the built-in (no override).
    const routes = config.skills.filter((s) => s.name === 'compact-route');
    assert.equal(routes.length, 1);
    assert.equal(routes[0].builtin, true);
  } finally {
    await cleanup();
  }
});

test('createProject: branches produce .context-compact/<branch>.md files', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    const r = await createProject({
      name: 'proj',
      parentDir: dir,
      branches: [
        { path: 'src/auth', description: 'Auth' },
        { path: 'src/ui', description: 'UI' },
      ],
    });
    const authMd = await readFile(
      path.join(r.projectRoot, '.context-compact', 'src-auth.md'),
      'utf8',
    );
    assert.match(authMd, /# src\/auth/);
    assert.match(authMd, /Auth/);
    const uiMd = await readFile(
      path.join(r.projectRoot, '.context-compact', 'src-ui.md'),
      'utf8',
    );
    assert.match(uiMd, /# src\/ui/);
  } finally {
    await cleanup();
  }
});

test('createProject: slash commands are written to .claude/commands/', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    const r = await createProject({ name: 'proj', parentDir: dir });
    const taskAdd = await readFile(
      path.join(r.projectRoot, '.claude', 'commands', 'task-add.md'),
      'utf8',
    );
    assert.match(taskAdd, /\/task-add/);
    const refresh = await readFile(
      path.join(r.projectRoot, '.claude', 'commands', 'refresh-compact.md'),
      'utf8',
    );
    assert.match(refresh, /\/refresh-compact/);
  } finally {
    await cleanup();
  }
});

test('createProject: rejects existing dir without force', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    await createProject({ name: 'dup', parentDir: dir });
    await assert.rejects(
      () => createProject({ name: 'dup', parentDir: dir }),
      /already exists/,
    );
  } finally {
    await cleanup();
  }
});

test('createProject: writes agents when provided', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    const r = await createProject({
      name: 'proj',
      parentDir: dir,
      agents: [
        {
          name: 'Frontend Dev',
          slash: 'frontend-dev',
          description: 'Handles UI',
          tasks: ['Create components', 'Style pages'],
        },
      ],
    });
    const agent = await readFile(
      path.join(r.projectRoot, '.claude', 'agents', 'frontend-dev.md'),
      'utf8',
    );
    assert.match(agent, /\/frontend-dev/);
    assert.match(agent, /Create components/);
  } finally {
    await cleanup();
  }
});

test('createProject: empty name is rejected', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    await assert.rejects(
      () => createProject({ name: '', parentDir: dir }),
      /required/,
    );
  } finally {
    await cleanup();
  }
});

test('createProject: propagates model (provider + name) to config', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    const r = await createProject({
      name: 'proj',
      parentDir: dir,
      model: { provider: 'ollama-cloud', name: 'kimi-k2.6:cloud' },
    });
    const config = JSON.parse(
      await readFile(path.join(r.projectRoot, 'project.config.json'), 'utf8'),
    );
    assert.equal(config.model.provider, 'ollama-cloud');
    assert.equal(config.model.name, 'kimi-k2.6:cloud');
  } finally {
    await cleanup();
  }
});

test('createProject: default model when not provided', async () => {
  const { dir, cleanup } = await tmpParent();
  try {
    const r = await createProject({ name: 'proj', parentDir: dir });
    const config = JSON.parse(
      await readFile(path.join(r.projectRoot, 'project.config.json'), 'utf8'),
    );
    assert.ok(config.model);
    assert.ok(config.model.provider);
  } finally {
    await cleanup();
  }
});
