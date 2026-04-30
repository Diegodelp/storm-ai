/**
 * Tests for src/core/templates.js
 *
 * We mock fetch for the registry tests. cloneTemplate is not tested
 * here because it shells out to git — we cover the substitution logic
 * (the most important part) using a fake "cloned" directory.
 *
 * Run: node --test test/templates.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  applyTemplate,
  readTemplateMetadata,
  fetchTemplateRegistry,
} from '../src/core/templates.js';

async function tmpDir() {
  const dir = path.join(tmpdir(), `storm-tpl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('applyTemplate: substitutes {{VARS}} in text files', async () => {
  const clone = await tmpDir();
  const project = await tmpDir();
  try {
    await mkdir(path.join(clone.dir, 'template'), { recursive: true });
    await writeFile(
      path.join(clone.dir, 'template', 'package.json'),
      '{"name":"{{PROJECT_NAME}}","description":"App for {{TARGET_USER}}"}',
    );
    await writeFile(
      path.join(clone.dir, 'template', 'README.md'),
      '# {{PROJECT_NAME_TITLE}}\n\nFor {{TARGET_USER}}.',
    );

    const result = await applyTemplate({
      cloneDir: clone.dir,
      projectRoot: project.dir,
      variables: {
        PROJECT_NAME: 'my-app',
        PROJECT_NAME_TITLE: 'My App',
        TARGET_USER: 'developers',
      },
    });

    assert.equal(result.filesWritten, 2);

    const pkg = await readFile(path.join(project.dir, 'package.json'), 'utf8');
    assert.match(pkg, /"name":"my-app"/);
    assert.match(pkg, /App for developers/);

    const readme = await readFile(path.join(project.dir, 'README.md'), 'utf8');
    assert.match(readme, /# My App/);
    assert.match(readme, /For developers\./);
  } finally {
    await clone.cleanup();
    await project.cleanup();
  }
});

test('applyTemplate: leaves unknown {{KEY}} placeholders alone', async () => {
  const clone = await tmpDir();
  const project = await tmpDir();
  try {
    await mkdir(path.join(clone.dir, 'template'), { recursive: true });
    await writeFile(
      path.join(clone.dir, 'template', 'config.js'),
      'const x = "{{KNOWN}}"; const y = "{{NEVER_DEFINED}}";',
    );

    await applyTemplate({
      cloneDir: clone.dir,
      projectRoot: project.dir,
      variables: { KNOWN: 'real-value' },
    });

    const out = await readFile(path.join(project.dir, 'config.js'), 'utf8');
    assert.match(out, /"real-value"/);
    assert.match(out, /\{\{NEVER_DEFINED\}\}/);
  } finally {
    await clone.cleanup();
    await project.cleanup();
  }
});

test('applyTemplate: copies binary files without modifying them', async () => {
  const clone = await tmpDir();
  const project = await tmpDir();
  try {
    await mkdir(path.join(clone.dir, 'template'), { recursive: true });
    // Create a fake "binary" — random bytes including {{ which we don't want to touch.
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x7b, 0x7b, 0xff, 0x00]);
    await writeFile(path.join(clone.dir, 'template', 'logo.png'), binary);

    await applyTemplate({
      cloneDir: clone.dir,
      projectRoot: project.dir,
      variables: { ANYTHING: 'x' },
    });

    const copied = await readFile(path.join(project.dir, 'logo.png'));
    assert.deepEqual(Array.from(copied), Array.from(binary));
  } finally {
    await clone.cleanup();
    await project.cleanup();
  }
});

test('applyTemplate: respects nested directories', async () => {
  const clone = await tmpDir();
  const project = await tmpDir();
  try {
    const t = path.join(clone.dir, 'template');
    await mkdir(path.join(t, 'src/components/ui'), { recursive: true });
    await writeFile(
      path.join(t, 'src/components/ui/Button.jsx'),
      'export const Button = () => <>Hello {{PROJECT_NAME}}</>;',
    );

    await applyTemplate({
      cloneDir: clone.dir,
      projectRoot: project.dir,
      variables: { PROJECT_NAME: 'foo' },
    });

    const out = await readFile(
      path.join(project.dir, 'src/components/ui/Button.jsx'),
      'utf8',
    );
    assert.match(out, /Hello foo/);
  } finally {
    await clone.cleanup();
    await project.cleanup();
  }
});

test('applyTemplate: substitutes vars in filenames', async () => {
  const clone = await tmpDir();
  const project = await tmpDir();
  try {
    const t = path.join(clone.dir, 'template');
    await mkdir(t, { recursive: true });
    await writeFile(path.join(t, '{{PROJECT_NAME}}.md'), '# Doc');

    await applyTemplate({
      cloneDir: clone.dir,
      projectRoot: project.dir,
      variables: { PROJECT_NAME: 'guide' },
    });

    const stat = await readFile(path.join(project.dir, 'guide.md'), 'utf8');
    assert.match(stat, /# Doc/);
  } finally {
    await clone.cleanup();
    await project.cleanup();
  }
});

test('applyTemplate: skips existing files in dest', async () => {
  const clone = await tmpDir();
  const project = await tmpDir();
  try {
    await mkdir(path.join(clone.dir, 'template'), { recursive: true });
    await writeFile(path.join(clone.dir, 'template', 'README.md'), '# from template');

    // Pre-existing file in dest:
    await writeFile(path.join(project.dir, 'README.md'), '# i was here first');

    const result = await applyTemplate({
      cloneDir: clone.dir,
      projectRoot: project.dir,
      variables: {},
    });

    assert.ok(result.filesSkipped.includes('README.md'));
    const out = await readFile(path.join(project.dir, 'README.md'), 'utf8');
    assert.match(out, /i was here first/);
  } finally {
    await clone.cleanup();
    await project.cleanup();
  }
});

test('applyTemplate: copies .storm/ alongside template/', async () => {
  const clone = await tmpDir();
  const project = await tmpDir();
  try {
    await mkdir(path.join(clone.dir, 'template'), { recursive: true });
    await mkdir(path.join(clone.dir, '.storm/.context-compact'), { recursive: true });
    await writeFile(path.join(clone.dir, 'template', 'app.js'), 'const a = 1;');
    await writeFile(
      path.join(clone.dir, '.storm/.context-compact/app.md'),
      '# Branch app',
    );

    await applyTemplate({
      cloneDir: clone.dir,
      projectRoot: project.dir,
      variables: {},
    });

    const code = await readFile(path.join(project.dir, 'app.js'), 'utf8');
    assert.equal(code, 'const a = 1;');

    const compact = await readFile(
      path.join(project.dir, '.context-compact/app.md'),
      'utf8',
    );
    assert.match(compact, /Branch app/);
  } finally {
    await clone.cleanup();
    await project.cleanup();
  }
});

test('readTemplateMetadata: parses valid storm-template.json', async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    await writeFile(
      path.join(dir, 'storm-template.json'),
      JSON.stringify({
        version: 1,
        name: 'foo',
        label: 'Foo Template',
        description: 'A template',
        stackId: 'nextjs-app',
        variables: [{ key: 'X', prompt: 'Value of X' }],
        postInstall: ['pnpm install'],
        initialTasks: [{ title: 'First task' }],
      }),
    );
    const meta = await readTemplateMetadata(dir);
    assert.equal(meta.name, 'foo');
    assert.equal(meta.stackId, 'nextjs-app');
    assert.equal(meta.variables.length, 1);
    assert.equal(meta.postInstall[0], 'pnpm install');
    assert.equal(meta.initialTasks[0].title, 'First task');
  } finally {
    await cleanup();
  }
});

test('readTemplateMetadata: throws if missing file', async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    await assert.rejects(() => readTemplateMetadata(dir), /storm-template\.json/);
  } finally {
    await cleanup();
  }
});

test('readTemplateMetadata: throws if name is missing', async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    await writeFile(
      path.join(dir, 'storm-template.json'),
      JSON.stringify({ stackId: 'other' }),
    );
    await assert.rejects(() => readTemplateMetadata(dir), /name/);
  } finally {
    await cleanup();
  }
});

test('readTemplateMetadata: filters malformed variables/tasks', async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    await writeFile(
      path.join(dir, 'storm-template.json'),
      JSON.stringify({
        name: 'foo',
        stackId: 'other',
        variables: [
          { key: 'GOOD', prompt: 'ok' },
          { prompt: 'no key, dropped' },
          'string-not-object',
          null,
        ],
        initialTasks: [
          { title: 'good' },
          { description: 'no title' },
          'wrong type',
        ],
      }),
    );
    const meta = await readTemplateMetadata(dir);
    assert.equal(meta.variables.length, 1);
    assert.equal(meta.variables[0].key, 'GOOD');
    assert.equal(meta.initialTasks.length, 1);
    assert.equal(meta.initialTasks[0].title, 'good');
  } finally {
    await cleanup();
  }
});

test('fetchTemplateRegistry: returns [] on network error', async () => {
  // Save & override fetch to simulate failure.
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const r = await fetchTemplateRegistry();
    assert.deepEqual(r, []);
  } finally {
    globalThis.fetch = orig;
  }
});

test('fetchTemplateRegistry: returns [] on 404', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  try {
    const r = await fetchTemplateRegistry();
    assert.deepEqual(r, []);
  } finally {
    globalThis.fetch = orig;
  }
});

test('fetchTemplateRegistry: filters malformed entries', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      templates: [
        { id: 'good', repo: 'user/repo', label: 'Good', description: '' },
        { id: 'no-repo', label: 'Missing repo' },
        { repo: 'user/repo2' }, // no id
        null,
        'string',
      ],
    }),
  });
  try {
    const r = await fetchTemplateRegistry();
    assert.equal(r.length, 1);
    assert.equal(r[0].id, 'good');
  } finally {
    globalThis.fetch = orig;
  }
});
