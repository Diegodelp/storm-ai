import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { createConfig, readConfig, writeConfig } from '../src/core/config.js';
import { configureAgentForProject, syncAgentConfig } from '../src/core/agent-config.js';
import { listOllamaModels, CLOUD_MODELS } from '../src/core/providers.js';
import { applyTemplateToProject } from '../src/commands/new-from-template.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'storm-native-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const deps = {
  getHost: async () => 'http://remote:11434',
  listModels: async () => [{ name: 'qwen3.5:9b' }, { name: 'custom:latest' }, { name: 'kimi-k2.6:cloud' }],
};
const configFor = (agent, provider = 'ollama-local', name = null) => createConfig({ name: 'fixture', agent, model: { provider, name } });
const json = async (root, file) => parse(await readFile(path.join(root, file), 'utf8'));

test('Claude: detects an installed local model and configures routing and aliases', async (t) => {
  const root = await fixture(t);
  const config = configFor('claude-code');
  const result = await configureAgentForProject({ projectRoot: root, config }, deps);
  const settings = await json(root, '.claude/settings.local.json');
  assert.equal(config.model.name, 'qwen3.5:9b');
  assert.equal(settings.model, 'qwen3.5:9b');
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'http://remote:11434');
  assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, settings.model);
  assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, settings.model);
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'ollama');
  assert.equal(settings.env.ANTHROPIC_API_KEY, '');
  assert.deepEqual(result.warnings, []);
  assert.match(await readFile(path.join(root, '.gitignore'), 'utf8'), /settings\.local\.json/);
});

test('OpenCode: preserves JSONC comments/settings and registers all local models', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, '.opencode'));
  await writeFile(path.join(root, '.opencode/AGENTS.md'), '# Project instructions');
  await writeFile(path.join(root, 'opencode.jsonc'), `{
    // Keep the team's permissions
    "permission": { "edit": "ask" },
    "instructions": ["team.md"],
    "provider": { "anthropic": { "options": { "apiKey": "{env:ANTHROPIC_API_KEY}" } } },
  }`);
  const config = configFor('opencode');
  await configureAgentForProject({ projectRoot: root, config }, deps);
  const raw = await readFile(path.join(root, 'opencode.jsonc'), 'utf8');
  const settings = parse(raw);
  assert.match(raw, /Keep the team's permissions/);
  assert.deepEqual(settings.permission, { edit: 'ask' });
  assert.deepEqual(settings.instructions, ['team.md', '.opencode/AGENTS.md']);
  assert.equal(settings.model, 'ollama/qwen3.5:9b');
  assert.equal(settings.small_model, settings.model);
  assert.equal(settings.provider.ollama.npm, '@ai-sdk/openai-compatible');
  assert.equal(settings.provider.ollama.options.baseURL, 'http://remote:11434/v1');
  assert.deepEqual(Object.keys(settings.provider.ollama.models).sort(), ['custom:latest', 'qwen3.5:9b']);
  assert.equal(settings.provider.anthropic.options.apiKey, '{env:ANTHROPIC_API_KEY}');
  await assert.rejects(access(path.join(root, 'opencode.json')), { code: 'ENOENT' });
  // Repeated syncs do not rewrite files or duplicate instruction paths.
  const again = await configureAgentForProject({ projectRoot: root, config }, deps);
  assert.deepEqual(again.createdFiles, []);
  assert.equal(await readFile(path.join(root, 'opencode.jsonc'), 'utf8'), raw);
});

test('Ollama cloud: chooses detected cloud models and excludes installed local models', async (t) => {
  const root = await fixture(t);
  const config = configFor('opencode', 'ollama-cloud');
  await configureAgentForProject({ projectRoot: root, config }, deps);
  const settings = await json(root, 'opencode.json');
  assert.equal(settings.model, 'ollama/kimi-k2.6:cloud');
  const listed = Object.keys(settings.provider.ollama.models);
  assert.ok(!listed.includes('qwen3.5:9b') && !listed.includes('custom:latest'), 'no local models');
  // The whole curated cloud catalog is offered in OpenCode's picker, not only the detected one.
  assert.deepEqual(listed.sort(), CLOUD_MODELS.map((m) => m.name).sort());
  assert.equal(settings.provider.ollama.models['kimi-k2.6:cloud'].name, 'Kimi K2.6 (cloud)');
});

test('Ollama cloud: extra detected cloud models are listed next to the catalog', async (t) => {
  const root = await fixture(t);
  const config = configFor('opencode', 'ollama-cloud', 'gpt-oss:120b-cloud');
  await configureAgentForProject({ projectRoot: root, config }, {
    ...deps,
    listModels: async () => [{ name: 'gpt-oss:120b-cloud' }, { name: 'qwen3.5:9b' }],
  });
  const settings = await json(root, 'opencode.json');
  assert.equal(settings.model, 'ollama/gpt-oss:120b-cloud');
  assert.equal(Object.keys(settings.provider.ollama.models).length, CLOUD_MODELS.length + 1);
});

test('Ollama local: the cloud catalog is not added', async (t) => {
  const root = await fixture(t);
  await configureAgentForProject({ projectRoot: root, config: configFor('opencode') }, deps);
  const listed = Object.keys((await json(root, 'opencode.json')).provider.ollama.models);
  assert.ok(!listed.some((m) => m.endsWith(':cloud')));
});

test('explicit custom models are retained and :latest aliases are resolved', async (t) => {
  const root = await fixture(t);
  const config = configFor('opencode', 'ollama-local', 'custom');
  await configureAgentForProject({ projectRoot: root, config }, deps);
  assert.equal(config.model.name, 'custom:latest');
  assert.equal((await json(root, 'opencode.json')).model, 'ollama/custom:latest');
});

test('missing local models never select cloud; launch fails with an actionable error', async (t) => {
  const root = await fixture(t);
  const config = configFor('claude-code');
  const cloudOnly = { ...deps, listModels: async () => [{ name: 'model:cloud' }] };
  const result = await configureAgentForProject({ projectRoot: root, config }, cloudOnly);
  assert.match(result.warnings[0], /No se detectaron modelos locales/);
  assert.deepEqual(result.createdFiles, []);
  await assert.rejects(configureAgentForProject({ projectRoot: root, config, strict: true }, cloudOnly), /ollama pull/);
  config.model.name = 'model:cloud';
  await assert.rejects(configureAgentForProject({ projectRoot: root, config }, cloudOnly), /es cloud/);
  config.model.name = 'not-installed';
  await assert.rejects(configureAgentForProject({ projectRoot: root, config, strict: true }, deps), /no está instalado/);
});

for (const agent of ['claude-code', 'opencode']) {
  test(`${agent}: switching providers removes generated Ollama routing, retains user fields`, async (t) => {
    const root = await fixture(t);
    const target = agent === 'claude-code' ? '.claude/settings.local.json' : 'opencode.json';
    await mkdir(path.dirname(path.join(root, target)), { recursive: true });
    await writeFile(path.join(root, target), JSON.stringify({ permissions: { keep: true }, env: { USER_FLAG: 'keep' } }));
    const config = configFor(agent);
    await configureAgentForProject({ projectRoot: root, config }, deps);
    config.model = { provider: 'claude', name: 'claude-custom' };
    await configureAgentForProject({ projectRoot: root, config }, deps);
    const settings = await json(root, target);
    assert.deepEqual(settings.permissions, { keep: true });
    assert.deepEqual(settings.env, { USER_FLAG: 'keep' });
    assert.equal(settings.provider?.ollama, undefined);
    assert.equal(settings.small_model, undefined);
    assert.equal(settings.model, agent === 'claude-code' ? 'claude-custom' : 'anthropic/claude-custom');
  });
}

test('switching agents cleans previous generated settings but retains manual edits', async (t) => {
  const root = await fixture(t);
  const config = configFor('claude-code');
  await configureAgentForProject({ projectRoot: root, config }, deps);
  const settings = await json(root, '.claude/settings.local.json');
  settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'manual-choice';
  settings.hooks = { custom: [] };
  await writeFile(path.join(root, '.claude/settings.local.json'), JSON.stringify(settings));
  config.agent = 'opencode';
  await configureAgentForProject({ projectRoot: root, config }, deps);
  const old = await json(root, '.claude/settings.local.json');
  assert.equal(old.model, undefined);
  assert.deepEqual(old.env, { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'manual-choice' });
  assert.deepEqual(old.hooks, { custom: [] });
  assert.equal((await json(root, 'opencode.json')).model, 'ollama/qwen3.5:9b');
});

test('delegated OpenCode uses the native model without copying global credentials', async (t) => {
  const root = await fixture(t);
  const native = path.join(root, 'global.json');
  await writeFile(native, JSON.stringify({ model: 'vendor/custom-model', provider: { vendor: { options: { apiKey: 'secret-fixture' } } } }));
  const old = process.env.OPENCODE_CONFIG;
  process.env.OPENCODE_CONFIG = native;
  t.after(() => { if (old === undefined) delete process.env.OPENCODE_CONFIG; else process.env.OPENCODE_CONFIG = old; });
  const config = configFor('opencode', 'via-opencode');
  const result = await configureAgentForProject({ projectRoot: root, config }, deps);
  assert.equal(result.modelName, 'vendor/custom-model');
  assert.equal((await json(root, 'opencode.json')).model, 'vendor/custom-model');
  assert.equal(config.model.name, null);
  assert.doesNotMatch(await readFile(path.join(root, '.storm/agent-config.json'), 'utf8'), /secret-fixture/);
  assert.doesNotMatch(await readFile(path.join(root, 'opencode.json'), 'utf8'), /secret-fixture/);
});

test('invalid native JSONC is never overwritten', async (t) => {
  const root = await fixture(t);
  const raw = '{ "permission": invalid }';
  await writeFile(path.join(root, 'opencode.jsonc'), raw);
  await assert.rejects(configureAgentForProject({ projectRoot: root, config: configFor('opencode') }, deps), /Configuración inválida/);
  assert.equal(await readFile(path.join(root, 'opencode.jsonc'), 'utf8'), raw);
  await assert.rejects(access(path.join(root, '.storm/agent-config.json')), { code: 'ENOENT' });
});

test('delegation keeps a project-owned model across repeated syncs', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'opencode.json'), JSON.stringify({ model: 'provider/project-model' }));
  const config = configFor('opencode', 'via-opencode');
  for (let i = 0; i < 3; i++) {
    const result = await configureAgentForProject({ projectRoot: root, config }, deps);
    assert.equal(result.modelName, 'provider/project-model');
    assert.equal((await json(root, 'opencode.json')).model, 'provider/project-model');
  }
});

test('custom launch commands opt out of automatic native config', async (t) => {
  const root = await fixture(t);
  const config = configFor('opencode');
  config.launch.customCommand = 'custom-cli';
  const result = await configureAgentForProject({ projectRoot: root, config }, deps);
  assert.deepEqual(result.createdFiles, []);
});

test('Ollama model detection supports remote daemons and filters cloud entries', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(url, /\/api\/tags$/);
    return Response.json({ models: [
      { name: 'local:latest', size: 1e9 },
      { name: 'normal:cloud' },
      { name: 'remote:latest', remote_host: 'https://ollama.com' },
      { wrong: 'invalid' },
    ] });
  });
  assert.deepEqual((await listOllamaModels()).map((m) => m.name), ['local:latest']);
  assert.equal((await listOllamaModels({ includeCloud: true })).length, 3);
});

test('sync saves detected model into project.config.json', async (t) => {
  const root = await fixture(t);
  await writeConfig(root, configFor('claude-code'));
  t.mock.method(globalThis, 'fetch', async () => Response.json({ models: [{ name: 'installed:latest' }] }));
  await syncAgentConfig(root);
  assert.equal((await readConfig(root)).model.name, 'installed:latest');
});

test('templates configure the selected CLI/provider before the first launch', async (t) => {
  const root = await fixture(t);
  const cloneDir = path.join(root, 'template-repo');
  await mkdir(path.join(cloneDir, 'template'), { recursive: true });
  await writeConfig(path.join(cloneDir, 'template'), configFor('claude-code', 'claude'));
  t.mock.method(globalThis, 'fetch', async () => Response.json({ models: [{ name: 'installed:latest' }] }));
  const result = await applyTemplateToProject({
    projectName: 'app', parentDir: root, cloneDir,
    metadata: { initialTasks: [] }, skipPostInstall: true,
    agent: 'opencode', model: { provider: 'ollama-local', name: null },
  });
  assert.equal((await readConfig(result.projectRoot)).agent, 'opencode');
  assert.equal((await json(result.projectRoot, 'opencode.json')).model, 'ollama/installed:latest');
});
