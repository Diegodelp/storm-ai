/**
 * Tests for src/core/analyze.js
 *
 * Run: node --test test/analyze.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { scanProject, buildAnalysisPrompt } from '../src/core/analyze.js';

async function tmpProject() {
  const dir = path.join(tmpdir(), `storm-analyze-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('scanProject: finds package.json and README', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'foo', dependencies: { next: '15' } }));
    await writeFile(path.join(dir, 'README.md'), '# Foo\nA project.');

    const scan = await scanProject({ cwd: dir, mode: 'shallow' });

    const fileNames = scan.files.map((f) => f.name);
    assert.ok(fileNames.includes('package.json'));
    assert.ok(fileNames.includes('README.md'));
    assert.match(scan.files.find((f) => f.name === 'package.json').content, /next/);
  } finally {
    await cleanup();
  }
});

test('scanProject: tree listing includes directories with trailing slash', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    await mkdir(path.join(dir, 'src/components'), { recursive: true });
    await writeFile(path.join(dir, 'src/components/Button.jsx'), '// Button');

    const scan = await scanProject({ cwd: dir, mode: 'shallow' });
    assert.ok(scan.treeListing.some((p) => p === 'src/'));
    assert.ok(scan.treeListing.some((p) => p === 'src/components/'));
    assert.ok(scan.treeListing.some((p) => p === 'src/components/Button.jsx'));
  } finally {
    await cleanup();
  }
});

test('scanProject: ignores node_modules and .git', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    await mkdir(path.join(dir, 'node_modules/foo'), { recursive: true });
    await mkdir(path.join(dir, '.git/objects'), { recursive: true });
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'src/x.js'), '');

    const scan = await scanProject({ cwd: dir, mode: 'shallow' });
    assert.ok(!scan.treeListing.some((p) => p.startsWith('node_modules')));
    assert.ok(!scan.treeListing.some((p) => p.startsWith('.git')));
    assert.ok(scan.treeListing.some((p) => p.startsWith('src')));
  } finally {
    await cleanup();
  }
});

test('scanProject: shallow mode does NOT include sample code', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    await writeFile(path.join(dir, 'package.json'), '{}');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'src/index.js'), 'console.log("hi");');

    const scan = await scanProject({ cwd: dir, mode: 'shallow' });
    assert.deepEqual(scan.sampleCode, []);
  } finally {
    await cleanup();
  }
});

test('scanProject: deep mode reads code samples', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    await writeFile(path.join(dir, 'package.json'), '{}');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'src/index.js'), 'export const main = () => 42;');
    await writeFile(path.join(dir, 'src/route.js'), 'export const route = "/";');

    const scan = await scanProject({ cwd: dir, mode: 'deep' });
    assert.ok(scan.sampleCode.length > 0);
    // Should have read at least one of the source files.
    const allContent = scan.sampleCode.map((s) => s.content).join('');
    assert.match(allContent, /export/);
  } finally {
    await cleanup();
  }
});

test('buildAnalysisPrompt: includes stack ids and database ids', async () => {
  const { dir, cleanup } = await tmpProject();
  try {
    await writeFile(path.join(dir, 'package.json'), '{"name":"x"}');
    const scan = await scanProject({ cwd: dir, mode: 'shallow' });
    const prompt = buildAnalysisPrompt(scan);

    // Should mention all the stack ids the LLM is allowed to choose.
    assert.match(prompt, /nextjs-app/);
    assert.match(prompt, /express-prisma/);
    assert.match(prompt, /postgres/);
    assert.match(prompt, /mongodb/);
    // Should ask for STRICT JSON.
    assert.match(prompt, /STRICT JSON/i);
    // Should include the package.json content.
    assert.match(prompt, /package\.json/);
  } finally {
    await cleanup();
  }
});
