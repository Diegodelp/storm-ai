/**
 * Tests for src/core/compact.js
 *
 * Requires @babel/parser (transitive via parser.js). Run after install with:
 *   node --test test/compact.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { refreshCompactContext } from '../src/core/compact.js';

async function setupProject() {
  const root = await mkdtemp(path.join(tmpdir(), 'storm-compact-'));
  const write = async (rel, content) => {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    return abs;
  };
  const cleanup = () => rm(root, { recursive: true, force: true });
  return { root, write, cleanup };
}

test('empty branches: all files go to _unassigned with warning', async () => {
  const { root, write, cleanup } = await setupProject();
  try {
    await write('src/app.js', 'export const x = 1;\n');
    const result = await refreshCompactContext(root, { branches: [] });
    assert.equal(result.filesScanned, 1);
    assert.equal(result.unassignedCount, 1);
    assert.ok(result.warnings.some((w) => /outside declared/.test(w)));
    const unassigned = await readFile(
      path.join(root, '.context-compact', '_unassigned.md'),
      'utf8',
    );
    assert.match(unassigned, /app\.js/);
  } finally {
    await cleanup();
  }
});

test('most-specific branch wins', async () => {
  const { root, write, cleanup } = await setupProject();
  try {
    await write('src/ui/home.tsx', 'export const Home = () => null;\n');
    await write('src/ui/settings/panel.tsx', 'export const Panel = () => null;\n');

    const result = await refreshCompactContext(root, {
      branches: [
        { path: 'src/ui', description: 'UI generic' },
        { path: 'src/ui/settings', description: 'Settings page' },
      ],
    });

    assert.equal(result.unassignedCount, 0);

    const ui = await readFile(path.join(root, '.context-compact', 'src-ui.md'), 'utf8');
    const settings = await readFile(
      path.join(root, '.context-compact', 'src-ui-settings.md'),
      'utf8',
    );
    assert.match(ui, /home\.tsx/);
    assert.doesNotMatch(ui, /panel\.tsx/);
    assert.match(settings, /panel\.tsx/);
  } finally {
    await cleanup();
  }
});

test('pinned files appear first', async () => {
  const { root, write, cleanup } = await setupProject();
  try {
    await write(
      'src/auth/tokens.js',
      `export const signAccess = () => {};
export const signRefresh = () => {};
export const verify = () => {};
`,
    );
    await write('src/auth/login.js', `export const login = () => {};\n`);

    await refreshCompactContext(root, {
      branches: [{ path: 'src/auth', description: 'Auth', pinned: ['login.js'] }],
    });

    const authMd = await readFile(
      path.join(root, '.context-compact', 'src-auth.md'),
      'utf8',
    );
    const loginIdx = authMd.indexOf('login.js');
    const tokensIdx = authMd.indexOf('tokens.js');
    assert.ok(loginIdx > 0 && tokensIdx > 0);
    assert.ok(loginIdx < tokensIdx, 'pinned login.js should precede tokens.js');
  } finally {
    await cleanup();
  }
});

test('ranking is deterministic across runs', async () => {
  const { root, write, cleanup } = await setupProject();
  try {
    await write('src/a/one.js', 'export const a = 1;\n');
    await write('src/a/two.js', 'export const b = 2;\n');
    await write('src/a/three.js', 'export const c = 3;\n');

    const opts = { branches: [{ path: 'src/a', description: '' }] };
    await refreshCompactContext(root, opts);
    const first = await readFile(path.join(root, '.context-compact', 'src-a.md'), 'utf8');

    await refreshCompactContext(root, opts);
    const second = await readFile(path.join(root, '.context-compact', 'src-a.md'), 'utf8');

    assert.equal(first, second);
  } finally {
    await cleanup();
  }
});

test('fan-in boosts imported files', async () => {
  const { root, write, cleanup } = await setupProject();
  try {
    await write('src/x/helpers.js', 'export const h = () => {};\n');
    await write('src/x/a.js', `import { h } from './helpers.js';\nexport const a = h;\n`);
    await write('src/x/b.js', `import { h } from './helpers.js';\nexport const b = h;\n`);
    await write('src/x/lonely.js', 'export const l = () => {};\n');

    await refreshCompactContext(root, {
      branches: [{ path: 'src/x', description: '' }],
    });

    const md = await readFile(path.join(root, '.context-compact', 'src-x.md'), 'utf8');
    const helpersIdx = md.indexOf('helpers.js');
    const lonelyIdx = md.indexOf('lonely.js');
    assert.ok(helpersIdx > 0 && lonelyIdx > 0);
    assert.ok(helpersIdx < lonelyIdx);
  } finally {
    await cleanup();
  }
});

test('barrel (index.ts) ranks higher', async () => {
  const { root, write, cleanup } = await setupProject();
  try {
    await write('src/b/stuff.ts', 'export const one = 1;\nexport const two = 2;\n');
    await write('src/b/index.ts', 'export { one } from "./stuff.js";\n');

    await refreshCompactContext(root, {
      branches: [{ path: 'src/b', description: '' }],
    });

    const md = await readFile(path.join(root, '.context-compact', 'src-b.md'), 'utf8');
    const indexIdx = md.indexOf('index.ts');
    const stuffIdx = md.indexOf('stuff.ts');
    assert.ok(indexIdx > 0 && stuffIdx > 0);
    assert.ok(indexIdx < stuffIdx);
  } finally {
    await cleanup();
  }
});

test('project-map truncates with "...and N more"', async () => {
  const { root, write, cleanup } = await setupProject();
  try {
    for (let i = 0; i < 15; i++) {
      await write(`src/big/file${i}.js`, `export const x${i} = ${i};\n`);
    }
    await refreshCompactContext(root, {
      branches: [{ path: 'src/big', description: '' }],
      mapFilesPerBranch: 5,
    });
    const map = await readFile(path.join(root, '.context-compact', 'project-map.md'), 'utf8');
    assert.match(map, /\.\.\.and 10 more/);
  } finally {
    await cleanup();
  }
});

test('notes are preserved across refreshes', async () => {
  const { root, write, cleanup } = await setupProject();
  try {
    await write('src/n/one.js', 'export const x = 1;\n');
    const opts = { branches: [{ path: 'src/n', description: '' }] };

    await refreshCompactContext(root, opts);
    const mdPath = path.join(root, '.context-compact', 'src-n.md');
    const before = await readFile(mdPath, 'utf8');

    const withNote = before.replace(
      /(## Notes\n<!-- [^>]+ -->\n)/,
      '$1\n- Decided to use bcrypt over argon2 (T-007).\n',
    );
    assert.notEqual(before, withNote);
    await writeFile(mdPath, withNote, 'utf8');

    await refreshCompactContext(root, opts);
    const after = await readFile(mdPath, 'utf8');
    assert.match(after, /bcrypt over argon2/);
  } finally {
    await cleanup();
  }
});

test('cross-branch dependencies are detected', async () => {
  const { root, write, cleanup } = await setupProject();
  try {
    await write(
      'src/auth/login.js',
      `import { db } from '../db/client.js';\nexport const login = () => db;\n`,
    );
    await write('src/db/client.js', `export const db = {};\n`);

    await refreshCompactContext(root, {
      branches: [
        { path: 'src/auth', description: '' },
        { path: 'src/db', description: '' },
      ],
    });

    const authMd = await readFile(
      path.join(root, '.context-compact', 'src-auth.md'),
      'utf8',
    );
    assert.match(authMd, /## Depends on/);
    assert.match(authMd, /src\/db/);
  } finally {
    await cleanup();
  }
});

test('recent activity reflects assigned tasks only', async () => {
  const { root, write, cleanup } = await setupProject();
  try {
    await write('src/auth/login.js', `export const login = () => {};\n`);

    await refreshCompactContext(root, {
      branches: [{ path: 'src/auth', description: '' }],
      tasks: [
        {
          id: 'T-001',
          title: 'Implement login',
          description: '',
          status: 'in_progress',
          branches: ['src/auth'],
          created_at: '2026-04-20T00:00:00Z',
          updated_at: '2026-04-20T00:00:00Z',
          completed_at: null,
          notes: [],
        },
        {
          id: 'T-002',
          title: 'Unrelated',
          description: '',
          status: 'done',
          branches: ['src/ui'],
          created_at: '2026-04-20T00:00:00Z',
          updated_at: '2026-04-20T00:00:00Z',
          completed_at: '2026-04-21T00:00:00Z',
          notes: [],
        },
      ],
    });

    const md = await readFile(path.join(root, '.context-compact', 'src-auth.md'), 'utf8');
    assert.match(md, /## Recent activity/);
    assert.match(md, /T-001.*Implement login/);
    assert.doesNotMatch(md, /T-002/);
  } finally {
    await cleanup();
  }
});

test('ignored dirs are skipped', async () => {
  const { root, write, cleanup } = await setupProject();
  try {
    await write('src/real.js', 'export const x = 1;\n');
    await write('node_modules/junk.js', 'export const junk = 1;\n');
    await write('dist/bundle.js', 'export const out = 1;\n');

    const result = await refreshCompactContext(root, {
      branches: [{ path: 'src', description: '' }],
    });

    assert.equal(result.filesScanned, 1);
  } finally {
    await cleanup();
  }
});

test('unsupported files (md) do not crash', async () => {
  const { root, write, cleanup } = await setupProject();
  try {
    await write('docs/README.md', '# Docs\nHello\n');
    await write('src/app.js', 'export const x = 1;\n');

    const result = await refreshCompactContext(root, {
      branches: [
        { path: 'docs', description: 'Documentation' },
        { path: 'src', description: 'Source' },
      ],
    });

    assert.equal(result.filesScanned, 2);
    const docsMd = await readFile(path.join(root, '.context-compact', 'docs.md'), 'utf8');
    assert.match(docsMd, /README\.md/);
  } finally {
    await cleanup();
  }
});
