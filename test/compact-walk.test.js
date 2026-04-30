/**
 * Tests for walkProject() — the directory walker that backs the
 * compact context refresh.
 *
 * These tests verify the bug fix: walkProject must NOT descend into
 * node_modules, must respect .gitignore, must obey extra ignored paths
 * from the config, and must cap depth.
 *
 * Run: node --test test/compact-walk.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { walkProject } from '../src/core/walk.js';

async function tmpProject() {
  const dir = path.join(tmpdir(), `storm-walk-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('walkProject: never descends into node_modules', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'src/index.js'), '// real code');

    // Simulated heavy node_modules.
    for (let i = 0; i < 20; i++) {
      const nm = path.join(dir, 'node_modules', `pkg-${i}`);
      await mkdir(nm, { recursive: true });
      await writeFile(path.join(nm, 'index.js'), '// noise');
    }

    const result = await walkProject(dir);
    const files = result.files.map((p) => path.relative(dir, p).replace(/\\/g, '/'));
    assert.ok(files.includes('src/index.js'));
    assert.ok(!files.some((f) => f.startsWith('node_modules')),
      `Expected no node_modules entries; got ${files.filter((f) => f.startsWith('node_modules')).slice(0, 3).join(', ')}`);
  } finally {
    await cleanup();
  }
});

test('walkProject: skips .git, dist, build, .next, etc by default', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    for (const skipped of ['.git', 'dist', 'build', '.next', 'coverage', 'target']) {
      await mkdir(path.join(dir, skipped), { recursive: true });
      await writeFile(path.join(dir, skipped, 'x.js'), '// junk');
    }
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'src/x.js'), '// real');

    const result = await walkProject(dir);
    const rels = result.files.map((p) => path.relative(dir, p).replace(/\\/g, '/'));

    assert.ok(rels.includes('src/x.js'));
    assert.equal(rels.length, 1);
  } finally {
    await cleanup();
  }
});

test('walkProject: respects compact_context.ignored_paths', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    await mkdir(path.join(dir, 'old-vendor'), { recursive: true });
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'old-vendor/lib.js'), '// to skip');
    await writeFile(path.join(dir, 'src/main.js'), '// keep');

    const result = await walkProject(dir, { extraIgnoredDirs: ['old-vendor'] });
    const rels = result.files.map((p) => path.relative(dir, p).replace(/\\/g, '/'));

    assert.ok(rels.includes('src/main.js'));
    assert.ok(!rels.some((f) => f.startsWith('old-vendor')));
  } finally {
    await cleanup();
  }
});

test('walkProject: respects .gitignore directory patterns', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await mkdir(path.join(dir, 'temp'), { recursive: true });
    await mkdir(path.join(dir, 'legacy'), { recursive: true });
    await writeFile(path.join(dir, 'src/app.js'), '// real');
    await writeFile(path.join(dir, 'temp/junk.js'), '// noise');
    await writeFile(path.join(dir, 'legacy/old.js'), '// also noise');

    await writeFile(path.join(dir, '.gitignore'), 'temp/\nlegacy/\n');

    const result = await walkProject(dir);
    const rels = result.files.map((p) => path.relative(dir, p).replace(/\\/g, '/'));

    assert.ok(rels.includes('src/app.js'));
    assert.ok(!rels.some((f) => f.startsWith('temp')),
      `temp/ should be ignored, got: ${rels.filter((f) => f.startsWith('temp')).join(', ')}`);
    assert.ok(!rels.some((f) => f.startsWith('legacy')),
      `legacy/ should be ignored, got: ${rels.filter((f) => f.startsWith('legacy')).join(', ')}`);
  } finally {
    await cleanup();
  }
});

test('walkProject: respects .gitignore file extension patterns', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    await writeFile(path.join(dir, 'app.js'), '// real');
    await writeFile(path.join(dir, 'debug.log'), '// to skip');
    await writeFile(path.join(dir, 'error.log'), '// to skip');
    await writeFile(path.join(dir, '.gitignore'), '*.log\n');

    const result = await walkProject(dir);
    const rels = result.files.map((p) => path.basename(p));

    assert.ok(rels.includes('app.js'));
    assert.ok(!rels.includes('debug.log'));
    assert.ok(!rels.includes('error.log'));
  } finally {
    await cleanup();
  }
});

test('walkProject: respects .gitignore comments and blank lines', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    await writeFile(path.join(dir, 'app.js'), '');
    await mkdir(path.join(dir, 'sensitive'), { recursive: true });
    await writeFile(path.join(dir, 'sensitive/x.js'), '');

    await writeFile(
      path.join(dir, '.gitignore'),
      '# this is a comment\n\n# another comment\nsensitive/\n\n',
    );

    const result = await walkProject(dir);
    const rels = result.files.map((p) => path.relative(dir, p).replace(/\\/g, '/'));

    assert.ok(rels.includes('app.js'));
    assert.ok(!rels.some((f) => f.startsWith('sensitive')));
  } finally {
    await cleanup();
  }
});

test('walkProject: skips dotfiles and dotdirs (other than already-handled IGNORED_DIRS)', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    await writeFile(path.join(dir, '.eslintrc.js'), '');
    await writeFile(path.join(dir, '.env'), '');
    await mkdir(path.join(dir, '.vscode'), { recursive: true });
    await writeFile(path.join(dir, '.vscode/settings.json'), '');
    await writeFile(path.join(dir, 'app.js'), '');

    const result = await walkProject(dir);
    const rels = result.files.map((p) => path.basename(p));

    assert.ok(rels.includes('app.js'));
    assert.ok(!rels.some((f) => f.startsWith('.')));
  } finally {
    await cleanup();
  }
});

test('walkProject: stops at MAX_WALK_DEPTH and warns', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    let current = dir;
    for (let i = 0; i < 18; i++) {
      current = path.join(current, `lvl-${i}`);
      await mkdir(current, { recursive: true });
      await writeFile(path.join(current, 'a.js'), '');
    }

    const result = await walkProject(dir);

    // Some warning about depth must be present.
    assert.ok(result.warnings.some((w) => /profundidad/i.test(w)),
      `Expected a depth warning. Got: ${result.warnings.join(' | ')}`);

    // We should have collected fewer than 18 files (MAX_WALK_DEPTH = 12).
    assert.ok(result.files.length < 18,
      `Expected fewer than 18 files; got ${result.files.length}`);
  } finally {
    await cleanup();
  }
});

test('walkProject: combines ignored_paths + .gitignore additively', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await mkdir(path.join(dir, 'fromConfig'), { recursive: true });
    await mkdir(path.join(dir, 'fromGitignore'), { recursive: true });
    await writeFile(path.join(dir, 'src/x.js'), '');
    await writeFile(path.join(dir, 'fromConfig/y.js'), '');
    await writeFile(path.join(dir, 'fromGitignore/z.js'), '');

    await writeFile(path.join(dir, '.gitignore'), 'fromGitignore/\n');

    const result = await walkProject(dir, {
      extraIgnoredDirs: ['fromConfig'],
    });
    const rels = result.files.map((p) => path.relative(dir, p).replace(/\\/g, '/'));

    assert.ok(rels.includes('src/x.js'));
    assert.ok(!rels.some((f) => f.startsWith('fromConfig')));
    assert.ok(!rels.some((f) => f.startsWith('fromGitignore')));
  } finally {
    await cleanup();
  }
});

test('walkProject: ignores package-lock.json, pnpm-lock.yaml, etc', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    await writeFile(path.join(dir, 'package-lock.json'), '{}');
    await writeFile(path.join(dir, 'pnpm-lock.yaml'), '');
    await writeFile(path.join(dir, 'app.js'), '');

    const result = await walkProject(dir);
    const names = result.files.map((p) => path.basename(p));

    assert.ok(names.includes('app.js'));
    assert.ok(!names.includes('package-lock.json'));
    assert.ok(!names.includes('pnpm-lock.yaml'));
  } finally {
    await cleanup();
  }
});
