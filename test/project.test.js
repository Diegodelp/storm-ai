/**
 * Tests for per-project launch settings:
 *   - src/commands/project.js   (storm project get/set)
 *   - src/commands/launch.js    (resolveLaunch precedence)
 *   - createProject defaults from the global config
 *
 * HOME points to a tmp dir so the global config is isolated. Skipped on
 * Windows, where os.homedir() ignores HOME.
 *
 * Run: node --test test/project.test.js
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { createProject } from '../src/commands/new.js';
import { getProjectSettings, updateProjectSettings } from '../src/commands/project.js';
import { resolveLaunch } from '../src/commands/launch.js';
import { readConfig } from '../src/core/config.js';
import { setDefaultProvider, setDefaultAgent, setDefaultLaunchCommand, writeGlobalConfig } from '../src/core/global-config.js';

const skip = process.platform === 'win32';
let fakeHome;
let prevHome;

before(async () => {
  fakeHome = await mkdtemp(path.join(tmpdir(), 'storm-proj-home-'));
  prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

after(async () => {
  process.env.HOME = prevHome;
  await rm(fakeHome, { recursive: true, force: true });
});

async function resetGlobal() {
  await writeGlobalConfig({ defaultProvider: null, defaultAgent: 'claude-code', defaultLaunchCommand: null });
}

async function withProject(input, fn) {
  const parentDir = await mkdtemp(path.join(tmpdir(), 'storm-proj-'));
  try {
    const r = await createProject({ name: 'demo', parentDir, ...input });
    return await fn(r.projectRoot);
  } finally {
    await rm(parentDir, { recursive: true, force: true });
  }
}

const exists = (p) => stat(p).then(() => true, () => false);

// ---------------------------------------------------------------------------
// createProject defaults
// ---------------------------------------------------------------------------

test('createProject: uses the global default provider when compatible', { skip }, async () => {
  await resetGlobal();
  await setDefaultProvider({ provider: 'ollama-cloud', model: 'kimi-k2.6:cloud' });
  await setDefaultAgent('opencode');
  await withProject({}, async (root) => {
    const s = await getProjectSettings(root);
    assert.deepEqual(s, { provider: 'ollama-cloud', model: 'kimi-k2.6:cloud', agent: 'opencode', launchCommand: null });
    assert.ok(await exists(path.join(root, 'AGENTS.md')), 'OpenCode reads AGENTS.md from the root');
  });
});

test('createProject: a via-* default of the other CLI is kept (launches the chosen agent)', { skip }, async () => {
  await resetGlobal();
  await setDefaultProvider({ provider: 'via-opencode', model: null });
  await withProject({ agent: 'claude-code' }, async (root) => {
    const s = await getProjectSettings(root);
    assert.equal(s.provider, 'via-opencode');
    const launch = resolveLaunch({ config: await readConfig(root) });
    assert.equal(launch.command, 'claude');
  });
});

test('createProject: invalid explicit provider/model is rejected', { skip }, async () => {
  await resetGlobal();
  const parentDir = await mkdtemp(path.join(tmpdir(), 'storm-proj-'));
  try {
    await assert.rejects(
      () => createProject({ name: 'x', parentDir, agent: 'claude-code', model: { provider: 'nope', name: null } }),
      /Provider desconocido/,
    );
    await assert.rejects(
      () => createProject({ name: 'y', parentDir, agent: 'opencode', model: { provider: 'ollama-local', name: 'kimi-k2.6:cloud' } }),
      /es un modelo cloud/,
    );
  } finally {
    await rm(parentDir, { recursive: true, force: true });
  }
});

test('createProject: global launchCommand is copied only for custom agents', { skip }, async () => {
  await resetGlobal();
  await setDefaultLaunchCommand('aider --model {{model}}');
  await withProject({ agent: 'claude-code' }, async (root) => {
    assert.equal((await getProjectSettings(root)).launchCommand, null);
  });
  await withProject({ agent: 'aider' }, async (root) => {
    assert.equal((await getProjectSettings(root)).launchCommand, 'aider --model {{model}}');
  });
});

// ---------------------------------------------------------------------------
// updateProjectSettings
// ---------------------------------------------------------------------------

test('updateProjectSettings: switching agent rescaffolds and keeps the provider', { skip }, async () => {
  await resetGlobal();
  await withProject({ agent: 'claude-code', model: { provider: 'via-claude-code', name: null } }, async (root) => {
    const r = await updateProjectSettings(root, { agent: 'opencode' });
    assert.equal(r.after.agent, 'opencode');
    assert.equal(r.after.provider, 'via-claude-code');
    assert.ok(r.scaffold.createdFiles.includes('AGENTS.md'));
    assert.ok(await exists(path.join(root, 'AGENTS.md')));
    assert.ok(await exists(path.join(root, '.opencode', 'commands')));
    assert.ok(await exists(path.join(root, 'CLAUDE.md')), 'old instructions file is kept');
    assert.ok(r.notes.some((n) => n.includes('CLAUDE.md')));

    const launch = resolveLaunch({ config: await readConfig(root) });
    assert.equal(launch.command, 'opencode');
  });
});

test('updateProjectSettings: switching agent keeps the Ollama model and re-syncs native config', { skip }, async () => {
  await resetGlobal();
  await withProject({ agent: 'claude-code', model: { provider: 'ollama-cloud', name: 'glm-5:cloud' } }, async (root) => {
    const r = await updateProjectSettings(root, { agent: 'opencode' });
    assert.equal(r.after.provider, 'ollama-cloud');
    assert.equal(r.after.model, 'glm-5:cloud');
    const native = JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8'));
    assert.equal(native.model, 'ollama/glm-5:cloud');
    const launch = resolveLaunch({ config: await readConfig(root) });
    assert.deepEqual([launch.command, launch.args], ['opencode', ['--model', 'ollama/glm-5:cloud']]);
  });
});

test('updateProjectSettings: does not overwrite an existing instructions file', { skip }, async () => {
  await resetGlobal();
  await withProject({ agent: 'opencode', model: { provider: 'via-opencode', name: null } }, async (root) => {
    const before = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    await updateProjectSettings(root, { agent: 'claude-code' });
    const r = await updateProjectSettings(root, { agent: 'opencode' });
    assert.ok(r.scaffold.skippedFiles.includes('AGENTS.md'));
    assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), before);
  });
});

test('updateProjectSettings: changing provider clears the model', { skip }, async () => {
  await resetGlobal();
  await withProject({ agent: 'claude-code', model: { provider: 'ollama-cloud', name: 'glm-5:cloud' } }, async (root) => {
    await assert.rejects(
      () => updateProjectSettings(root, { provider: 'ollama-local', model: 'glm-5:cloud' }),
      /es un modelo cloud/,
    );
    const r = await updateProjectSettings(root, { provider: 'ollama-local', model: 'qwen3.5:9b' });
    assert.equal(r.after.model, 'qwen3.5:9b');
    const r2 = await updateProjectSettings(root, { provider: 'via-claude-code' });
    assert.equal(r2.after.model, null);
    assert.equal((await getProjectSettings(root)).model, null);
  });
});

test('updateProjectSettings: rejects invalid combinations without writing', { skip }, async () => {
  await resetGlobal();
  await withProject({ agent: 'claude-code', model: { provider: 'via-claude-code', name: null } }, async (root) => {
    await assert.rejects(() => updateProjectSettings(root, { provider: 'nope' }), /Provider desconocido/);
    await assert.rejects(() => updateProjectSettings(root, { model: 'kimi-k2.6:cloud' }), /no usa un modelo/);
    await assert.rejects(() => updateProjectSettings(root, { agent: 'aider' }), /launchCommand/);
    assert.deepEqual(await getProjectSettings(root), {
      provider: 'via-claude-code', model: null, agent: 'claude-code', launchCommand: null,
    });
    const r = await updateProjectSettings(root, { agent: 'aider', launchCommand: 'aider --model {{model}}' });
    assert.equal(r.after.agent, 'aider');
  });
});

// ---------------------------------------------------------------------------
// resolveLaunch precedence
// ---------------------------------------------------------------------------

test('resolveLaunch: project command > agent template; global command only for custom agents', () => {
  const base = { model: { provider: 'ollama-cloud', name: 'glm-5:cloud' } };
  const globalConfig = { defaultLaunchCommand: 'aider --model {{model}}' };

  const known = resolveLaunch({ config: { ...base, agent: 'claude-code' }, globalConfig });
  assert.deepEqual([known.command, known.args], ['claude', ['--model', 'glm-5:cloud']]);

  const custom = resolveLaunch({ config: { ...base, agent: 'aider' }, globalConfig });
  assert.deepEqual([custom.command, custom.args], ['aider', ['--model', 'glm-5:cloud']]);

  const own = resolveLaunch({
    config: { ...base, agent: 'claude-code', launch: { customCommand: 'my-wrapper {{model}}' } },
    globalConfig,
  });
  assert.deepEqual([own.command, own.args], ['my-wrapper', ['glm-5:cloud']]);
});

test('resolveLaunch: exports OLLAMA_HOST only for Ollama providers', () => {
  const ollama = { model: { provider: 'ollama-local', name: 'qwen3.5:9b' }, agent: 'opencode' };
  const host = 'http://gpu-box:11434';
  assert.deepEqual(resolveLaunch({ config: ollama, ollamaHost: host }).env, { OLLAMA_HOST: host });
  const claude = { model: { provider: 'claude', name: null }, agent: 'opencode' };
  assert.deepEqual(resolveLaunch({ config: claude, ollamaHost: host }).env, {});
});

test('resolveLaunch: uses the resolved model over the stored one', () => {
  const config = { model: { provider: 'ollama-cloud', name: null }, agent: 'claude-code' };
  const r = resolveLaunch({ config, modelName: 'kimi-k2.6:cloud' });
  assert.deepEqual(r.args, ['--model', 'kimi-k2.6:cloud']);
});

test('createProject: without a global default, uses the agent own via-* provider', { skip }, async () => {
  await resetGlobal();
  await withProject({ agent: 'opencode' }, async (root) => {
    assert.equal((await getProjectSettings(root)).provider, 'via-opencode');
    const native = JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8'));
    assert.equal(native.model, undefined, 'OpenCode keeps its own model choice');
  });
  await withProject({ agent: 'claude-code' }, async (root) => {
    assert.equal((await getProjectSettings(root)).provider, 'via-claude-code');
  });
});
