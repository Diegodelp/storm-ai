/**
 * Tests for the function index: extraction, stable IDs, heuristic and
 * LLM classification, section files, and `storm functions show`.
 *
 * Run: node --test test/functions.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  extractFunctions,
  mergeRegistry,
  heuristicClassify,
  normalizeId,
  updateFunctionIndex,
  readRegistry,
} from '../src/core/functions.js';
import { makeLlmClassifier, parseClassification } from '../src/core/function-classifier.js';
import { parseSource, summarizeFile } from '../src/core/parser.js';
import { refreshCompactContext } from '../src/core/compact.js';
import { showFunction, listFunctions } from '../src/commands/functions.js';

const exists = (p) => stat(p).then(() => true, () => false);

function extract(code, file = 'src/a.tsx') {
  return extractFunctions(parseSource(code, file), code, file, { jsx: /x$/.test(file) });
}

async function tmpProject(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'storm-fn-'));
  await writeFile(path.join(root, 'project.config.json'), JSON.stringify({ name: 'demo' }));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content);
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function extractProject(root, files) {
  const out = [];
  for (const rel of files) out.push(...(await summarizeFile(path.join(root, rel), root)).functions);
  return out;
}

/** Fake classifier: records what it was asked, answers from the path. */
function fakeClassifier(section = 'Pacientes') {
  const calls = [];
  const fn = async (pending) => {
    calls.push(pending.map((f) => f.id));
    return new Map(pending.map((f) => [f.id, {
      layer: f.file.includes('api') ? 'backend' : 'frontend',
      section,
      description: `Hace ${f.name}`,
    }]));
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

test('extractFunctions: finds declarations, arrows, default, components, hooks and methods', () => {
  const fns = extract(`
/** Trae los paths */
export async function getStaticPaths() {
  return { paths: [], fallback: false };
}
const helper = (x) => x * 2;
export default function PacientesPage() { return <div>{[1].map((i) => <p>{i}</p>)}</div>; }
export const usePacientes = () => [];
class Repo { find(id) { return id; } save = async (p) => p; constructor() {} }
export const api = { list() { return 1; }, get: async (id) => id };
`);
  const byName = Object.fromEntries(fns.map((f) => [f.name, f]));
  assert.deepEqual(Object.keys(byName).sort(), [
    'PacientesPage', 'Repo.find', 'Repo.save', 'api.get', 'api.list',
    'getStaticPaths', 'helper', 'usePacientes',
  ]);
  assert.deepEqual([byName.getStaticPaths.start, byName.getStaticPaths.end], [3, 5]);
  assert.equal(byName.getStaticPaths.doc, 'Trae los paths');
  assert.equal(byName.getStaticPaths.signature, 'async getStaticPaths()');
  assert.equal(byName.getStaticPaths.exported, true);
  assert.equal(byName.helper.exported, false);
  assert.equal(byName.PacientesPage.kind, 'component');
  assert.equal(byName.usePacientes.kind, 'hook');
  assert.equal(byName['Repo.find'].kind, 'method');
  assert.ok(!fns.some((f) => f.name.includes('constructor')), 'constructors are skipped');
  assert.ok(fns.every((f) => f.key === `src/a.tsx::${f.name}`));
});

test('extractFunctions: inline callbacks are not indexed', () => {
  const fns = extract('export function a(xs) { return xs.map((x) => x).filter(function (y) { return y; }); }', 'a.js');
  assert.deepEqual(fns.map((f) => f.name), ['a']);
});

test('normalizeId accepts the usual spellings', () => {
  for (const v of ['1', '001', 'ID-001', '#ID-001', 'id-1', 'ID1']) assert.equal(normalizeId(v), 'ID-001');
  assert.equal(normalizeId('abc'), null);
});

// ---------------------------------------------------------------------------
// Stable IDs
// ---------------------------------------------------------------------------

test('mergeRegistry: IDs survive edits, line moves and file moves; new ones get the next ID', () => {
  const v1 = [
    ...extract('export function a() { return 1; }\nexport function b() { return 2; }', 'src/x.js'),
  ];
  const r1 = mergeRegistry({ version: 1, nextId: 1, functions: [] }, v1);
  assert.deepEqual(r1.registry.functions.map((f) => [f.id, f.name]), [['ID-001', 'a'], ['ID-002', 'b']]);
  for (const f of r1.registry.functions) Object.assign(f, { classifiedBy: 'llm', classifiedHash: f.hash, layer: 'shared', section: 'X' });

  // a() moves down and changes its body; b() moves to another file untouched; c() is new.
  const v2 = [
    ...extract('\n\nexport function a() { return 42; }', 'src/x.js'),
    ...extract('export function b() { return 2; }', 'src/y.js'),
    ...extract('export function c() { return 3; }', 'src/z.js'),
  ];
  const r2 = mergeRegistry(r1.registry, v2);
  const byName = Object.fromEntries(r2.registry.functions.map((f) => [f.name, f]));
  assert.equal(byName.a.id, 'ID-001');
  assert.equal(byName.a.start, 3);
  assert.equal(byName.b.id, 'ID-002');
  assert.equal(byName.b.file, 'src/y.js');
  assert.equal(byName.b.section, 'X', 'moved function keeps its classification');
  assert.equal(byName.c.id, 'ID-003');
  assert.deepEqual(r2.pending.map((f) => f.name).sort(), ['a', 'c'], 'only modified + new need the AI');
  assert.equal(r2.added, 1);

  // Deleting a() drops it; its ID is never reused.
  const r3 = mergeRegistry(r2.registry, v2.filter((f) => f.name !== 'a'));
  assert.equal(r3.removed, 1);
  const r4 = mergeRegistry(r3.registry, [...v2.filter((f) => f.name !== 'a'), ...extract('export function d() {}', 'src/w.js')]);
  assert.equal(r4.registry.functions.find((f) => f.name === 'd').id, 'ID-004');
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test('heuristicClassify: layer and section from the path', () => {
  assert.deepEqual(heuristicClassify({ file: 'pages/api/pacientes/[id].ts' }), { layer: 'backend', section: 'Pacientes' });
  assert.deepEqual(heuristicClassify({ file: 'src/app/api/turnos/route.ts' }), { layer: 'backend', section: 'Turnos' });
  assert.deepEqual(heuristicClassify({ file: 'src/components/pacientes/Lista.tsx', kind: 'component' }), { layer: 'frontend', section: 'Pacientes' });
  assert.deepEqual(heuristicClassify({ file: 'src/services/facturacion.service.ts' }), { layer: 'backend', section: 'Facturacion' });
  assert.deepEqual(heuristicClassify({ file: 'src/utils/format-date.ts' }), { layer: 'shared', section: 'Format Date' });
  assert.deepEqual(heuristicClassify({ file: 'index.js' }), { layer: 'shared', section: 'General' });
});

test('parseClassification: tolerates fences and wrappers, ignores unknown IDs', () => {
  const text = 'Claro:\n```json\n[{"id":"#id-001","layer":"Backend","section":"Pacientes","description":"Trae pacientes"},' +
    '{"id":"ID-999","layer":"frontend","section":"X","description":""}]\n```';
  assert.deepEqual(parseClassification(text, new Set(['ID-001'])), [
    { id: 'ID-001', layer: 'backend', section: 'Pacientes', description: 'Trae pacientes' },
  ]);
  const wrapped = '{"functions":[{"id":"ID-002","layer":"weird","section":"","description":"x"}]}';
  assert.deepEqual(parseClassification(wrapped), [{ id: 'ID-002', layer: 'shared', section: 'General', description: 'x' }]);
  assert.throws(() => parseClassification('no json'), /JSON válido/);
});

test('makeLlmClassifier: batches the pending functions and shares known sections', async () => {
  const prompts = [];
  const classifier = makeLlmClassifier({
    provider: 'ollama-cloud',
    batchSize: 2,
    complete: async ({ prompt }) => {
      prompts.push(prompt);
      const items = JSON.parse(prompt.split('Functions (JSON):\n')[1].split('\n')[0]);
      return JSON.stringify(items.map((i) => ({ id: i.id, layer: 'frontend', section: 'Pacientes', description: `d ${i.name}` })));
    },
  });
  const pending = ['a', 'b', 'c'].map((n, i) => ({ id: `ID-00${i + 1}`, name: n, kind: 'function', file: 'f.js', signature: `${n}()`, snippet: '' }));
  const out = await classifier(pending, { sections: [{ layer: 'backend', section: 'Turnos' }] });
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /- backend: Turnos/);
  assert.equal(out.size, 3);
  assert.equal(out.get('ID-003').description, 'd c');
});

test('makeLlmClassifier: throws only when every batch fails', async () => {
  const classifier = makeLlmClassifier({ provider: 'x', complete: async () => { throw new Error('sin red'); } });
  await assert.rejects(classifier([{ id: 'ID-001', name: 'a', file: 'a.js', signature: 'a()', snippet: '' }], {}), /sin red/);
});

// ---------------------------------------------------------------------------
// Index + section files
// ---------------------------------------------------------------------------

test('updateFunctionIndex: writes sections, only sends new/changed functions to the AI, keeps notes', async () => {
  const { root, cleanup } = await tmpProject({
    'pages/api/pacientes.js': 'export async function getPacientes() { return []; }\nexport function borrar(id) { return id; }',
    'components/Lista.jsx': 'export default function Lista() { return null; }',
  });
  try {
    const files = ['pages/api/pacientes.js', 'components/Lista.jsx'];
    const c = fakeClassifier();
    const r1 = await updateFunctionIndex(root, await extractProject(root, files), { classifier: c.fn });
    assert.deepEqual(c.calls, [['ID-001', 'ID-002', 'ID-003']]);
    assert.equal(r1.pendingAfter, 0);

    const backend = path.join(root, '.context-compact/sections/backend/pacientes.md');
    const md = await readFile(backend, 'utf8');
    assert.match(md, /^# Backend · Pacientes/);
    assert.match(md, /\*\*#ID-001\*\* `async getPacientes\(\)` — Hace getPacientes · L1-1/);
    assert.ok(await exists(path.join(root, '.context-compact/sections/frontend/pacientes.md')));

    // Hand-written notes survive; only the edited function goes back to the AI.
    await writeFile(backend, md.replace(/## Notes[\s\S]*$/, '## Notes\n\nNo tocar borrar().\n'));
    await writeFile(path.join(root, 'pages/api/pacientes.js'),
      'export async function getPacientes() { return [1]; }\nexport function borrar(id) { return id; }');
    await updateFunctionIndex(root, await extractProject(root, files), { classifier: c.fn });
    assert.deepEqual(c.calls[1], ['ID-001']);
    assert.match(await readFile(backend, 'utf8'), /No tocar borrar\(\)/);

    // Without AI, new functions get the heuristic and stay pending.
    await writeFile(path.join(root, 'components/Lista.jsx'),
      'export default function Lista() { return null; }\nexport function Fila() { return null; }');
    const r3 = await updateFunctionIndex(root, await extractProject(root, files), {});
    assert.equal(r3.pendingAfter, 1);
    const fila = (await readRegistry(root)).functions.find((f) => f.name === 'Fila');
    assert.deepEqual([fila.id, fila.layer, fila.classifiedBy], ['ID-004', 'frontend', 'heuristic']);

    // A section with no functions left is deleted.
    await rm(path.join(root, 'components/Lista.jsx'));
    await updateFunctionIndex(root, await extractProject(root, ['pages/api/pacientes.js']), { classifier: c.fn });
    assert.equal(await exists(path.join(root, '.context-compact/sections/frontend')), false);
  } finally {
    await cleanup();
  }
});

test('updateFunctionIndex: AI failure falls back to the heuristic with a warning', async () => {
  const { root, cleanup } = await tmpProject({ 'src/api/turnos.js': 'export function listar() {}' });
  try {
    const r = await updateFunctionIndex(root, await extractProject(root, ['src/api/turnos.js']), {
      classifier: async () => { throw new Error('timeout'); },
    });
    assert.match(r.warnings[0], /timeout/);
    assert.equal(r.registry.functions[0].section, 'Turnos');
    assert.equal(r.pendingAfter, 1);
  } finally {
    await cleanup();
  }
});

test('refreshCompactContext: builds the index and lists sections in project-map.md', async () => {
  const { root, cleanup } = await tmpProject({
    'src/api/pacientes.ts': 'export async function getPacientes(filtro: string) { return []; }',
  });
  try {
    const c = fakeClassifier();
    const r = await refreshCompactContext(root, { branches: [{ path: 'src' }], classifier: c.fn });
    assert.deepEqual(r.functions, { total: 1, added: 1, removed: 0, classified: 1, pending: 0, sections: 1 });
    const map = await readFile(path.join(root, '.context-compact/project-map.md'), 'utf8');
    assert.match(map, /## Sections \(function index\)/);
    assert.match(map, /\*\*Pacientes\*\* \(1\) → `\.context-compact\/sections\/backend\/pacientes\.md`/);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// storm functions show / list
// ---------------------------------------------------------------------------

test('showFunction prints the exact code and follows functions that moved lines', async () => {
  const { root, cleanup } = await tmpProject({
    'src/api/pacientes.js': '// header\nexport function getPacientes() {\n  return [];\n}\n',
  });
  try {
    await refreshCompactContext(root, { branches: [] });
    let r = await showFunction({ cwd: root, id: '#1' });
    assert.equal(r.code, 'export function getPacientes() {\n  return [];\n}');
    assert.equal(r.moved, false);

    await writeFile(path.join(root, 'src/api/pacientes.js'),
      '// header\n\n\nexport function getPacientes() {\n  return [];\n}\n');
    r = await showFunction({ cwd: root, id: 'ID-001' });
    assert.deepEqual([r.start, r.end, r.moved], [4, 6, true]);
    assert.match(r.code, /^export function getPacientes/);

    await assert.rejects(showFunction({ cwd: root, id: 'ID-099' }), /No existe ID-099/);
    assert.equal((await listFunctions({ cwd: root, filter: 'pacientes' })).length, 1);
    assert.equal((await listFunctions({ cwd: root, filter: 'nada' })).length, 0);
  } finally {
    await cleanup();
  }
});
