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
      agent: 'claude-code',
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
      agent: 'claude-code',
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
      agent: 'claude-code',
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
      agent: 'claude-code',
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
      agent: 'claude-code',
    });
    assert.ok(result.createdFiles.some((f) => f.includes('refresh-compact.md')));
    assert.ok(result.createdFiles.some((f) => f.includes('task-add.md')));
    assert.ok(result.createdFiles.some((f) => f.includes('task-done.md')));
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// First refresh after import must use the declared branches.
// Reproduces an OpenCode-reported bug: project-map.md came back with
// every file in `_unassigned` because writeImport was calling
// refreshCompactContext without passing branches.
// ---------------------------------------------------------------------------

test('writeImport: first compact context uses declared branches (no _unassigned dump)', async () => {
  const { dir, cleanup } = await tmpProject(async (d) => {
    // A small Next.js Pages Router-ish layout.
    await mkdir(path.join(d, 'pages/api'), { recursive: true });
    await mkdir(path.join(d, 'components'), { recursive: true });
    await writeFile(path.join(d, 'package.json'), '{"name":"foo"}');
    await writeFile(path.join(d, 'pages/index.js'), 'export default function Home() { return null; }');
    await writeFile(path.join(d, 'pages/api/users.js'), 'export default (req, res) => res.json([]);');
    await writeFile(path.join(d, 'components/Navbar.js'), 'export const Navbar = () => null;');
  });
  try {
    await writeImport({
      projectRoot: dir,
      name: 'next-app',
      description: '',
      stackId: 'nextjs-pages',
      databaseId: 'none',
      model: { provider: 'claude', name: null },
      branches: [
        { path: 'pages',         description: 'Page routes' },
        { path: 'pages/api',     description: 'API routes' },
        { path: 'components',    description: 'UI components' },
      ],
      skills: [],
      agents: [],
      agent: 'claude-code',
    });

    // The project-map.md should now mention the declared branches.
    const mapPath = path.join(dir, '.context-compact', 'project-map.md');
    const map = await readFile(mapPath, 'utf8');
    assert.match(map, /pages\/api/, 'expected pages/api branch in map');
    assert.match(map, /components/,  'expected components branch in map');

    // Crucially: it should NOT be a "everything in _unassigned" dump.
    // We accept some _unassigned (lockfiles etc) but not as the only branch.
    const onlyUnassigned =
      /Branches:\s*1\b/.test(map) && /_unassigned/.test(map);
    assert.equal(onlyUnassigned, false,
      'project-map collapsed to a single _unassigned branch — refresh did not use declared branches');
  } finally {
    await cleanup();
  }
});

test('writeImport: model shape is { provider, name }, not { provider, model }', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    await writeImport({
      projectRoot: dir,
      name: 'foo',
      description: '',
      stackId: 'other',
      databaseId: 'none',
      model: { provider: 'ollama-cloud', name: 'kimi-k2.6:cloud' },
      agent: 'claude-code',
      branches: [],
      skills: [],
      agents: [],
    });

    const cfg = JSON.parse(await readFile(path.join(dir, 'project.config.json'), 'utf8'));
    assert.equal(cfg.model.provider, 'ollama-cloud');
    assert.equal(cfg.model.name, 'kimi-k2.6:cloud');
    // The wrong key must NOT be there.
    assert.equal(cfg.model.model, undefined,
      'project.config.json wrote the legacy `model.model` key');
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Agent-aware scaffolding (commit 4)
// agent=claude-code  → CLAUDE.md at root, .claude/commands/ generated
// agent=opencode     → .opencode/AGENTS.md, no .claude/commands/
// ---------------------------------------------------------------------------

test('writeImport with agent=claude-code: writes CLAUDE.md and .claude/commands/', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    await writeImport({
      projectRoot: dir,
      name: 'foo',
      description: '',
      stackId: 'other',
      databaseId: 'none',
      model: { provider: 'claude', name: null },
      agent: 'claude-code',
      branches: [],
      skills: [],
      agents: [],
    });
    assert.ok(await exists(path.join(dir, 'CLAUDE.md')),
      'CLAUDE.md should exist for claude-code');
    assert.equal(await exists(path.join(dir, '.opencode/AGENTS.md')), false,
      '.opencode/AGENTS.md should NOT exist for claude-code');
    assert.ok(await exists(path.join(dir, '.claude/commands')),
      '.claude/commands/ should exist for claude-code');
  } finally {
    await cleanup();
  }
});

test('writeImport with agent=opencode: writes .opencode/AGENTS.md, no .claude/commands/', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    await writeImport({
      projectRoot: dir,
      name: 'foo',
      description: '',
      stackId: 'other',
      databaseId: 'none',
      model: { provider: 'claude', name: null },
      agent: 'opencode',
      branches: [],
      skills: [],
      agents: [],
    });
    assert.ok(await exists(path.join(dir, '.opencode/AGENTS.md')),
      '.opencode/AGENTS.md should exist for opencode');
    assert.equal(await exists(path.join(dir, 'CLAUDE.md')), false,
      'CLAUDE.md should NOT exist for opencode');
    assert.equal(await exists(path.join(dir, '.claude/commands')), false,
      '.claude/commands/ should NOT exist for opencode');
  } finally {
    await cleanup();
  }
});


// ---------------------------------------------------------------------------
// OpenCode scaffolding (commit 5+6)
//
// agent=opencode → write .opencode/AGENTS.md + .opencode/commands/*.md
// + .opencode/agents/*.md, AND AGENTS.md must index them.
// ---------------------------------------------------------------------------

test('writeImport with agent=opencode: writes .opencode/commands/ and .opencode/agents/', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    await writeImport({
      projectRoot: dir,
      name: 'foo',
      description: '',
      stackId: 'other',
      databaseId: 'none',
      model: { provider: 'claude', name: null },
      agent: 'opencode',
      branches: [],
      skills: [],
      agents: [],
    });

    // The .opencode/commands/ directory must exist with multiple files.
    const taskAdd = path.join(dir, '.opencode/commands/task-add.md');
    const taskDone = path.join(dir, '.opencode/commands/task-done.md');
    const refresh = path.join(dir, '.opencode/commands/refresh.md');
    assert.ok(await exists(taskAdd),  'task-add.md should exist');
    assert.ok(await exists(taskDone), 'task-done.md should exist');
    assert.ok(await exists(refresh),  'refresh.md should exist');

    // The .opencode/agents/ directory must have the builtins.
    const taskRunner = path.join(dir, '.opencode/agents/task-runner.md');
    const planner = path.join(dir, '.opencode/agents/planner.md');
    assert.ok(await exists(taskRunner), 'task-runner.md should exist');
    assert.ok(await exists(planner),    'planner.md should exist');

    // No claude scaffold for opencode users.
    assert.equal(await exists(path.join(dir, '.claude')), false,
      '.claude/ should NOT exist for opencode');
    assert.equal(await exists(path.join(dir, 'CLAUDE.md')), false,
      'CLAUDE.md should NOT exist for opencode');
  } finally {
    await cleanup();
  }
});

test('writeImport with agent=opencode: AGENTS.md indexes commands and agents', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    await writeImport({
      projectRoot: dir,
      name: 'foo',
      description: '',
      stackId: 'other',
      databaseId: 'none',
      model: { provider: 'claude', name: null },
      agent: 'opencode',
      branches: [],
      skills: [],
      agents: [],
    });

    const agentsMd = await readFile(path.join(dir, '.opencode/AGENTS.md'), 'utf8');
    // The index points to the per-command files so OpenCode (which only
    // auto-loads AGENTS.md) tells the LLM these references exist.
    assert.match(agentsMd, /Storm CLI commands/i);
    assert.match(agentsMd, /\.opencode\/commands\/task-add\.md/);
    assert.match(agentsMd, /\.opencode\/commands\/task-done\.md/);
    assert.match(agentsMd, /Storm roles/i);
    assert.match(agentsMd, /\.opencode\/agents\/task-runner\.md/);
  } finally {
    await cleanup();
  }
});

test('writeImport with agent=claude-code: AGENTS.md index NOT included', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    await writeImport({
      projectRoot: dir,
      name: 'foo',
      description: '',
      stackId: 'other',
      databaseId: 'none',
      model: { provider: 'claude', name: null },
      agent: 'claude-code',
      branches: [],
      skills: [],
      agents: [],
    });

    const claudeMd = await readFile(path.join(dir, 'CLAUDE.md'), 'utf8');
    // The OpenCode-specific index block should NOT appear in CLAUDE.md
    // — claude-code uses its own .claude/commands/ directly.
    assert.equal(/Storm CLI commands/i.test(claudeMd), false,
      'OpenCode index should not appear in CLAUDE.md');
  } finally {
    await cleanup();
  }
});
