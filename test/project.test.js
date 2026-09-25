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

test('createProject: incompatible global default falls back to the agent native provider', { skip }, async () => {
  await resetGlobal();
  await setDefaultProvider({ provider: 'via-opencode', model: null });
  await withProject({ agent: 'claude-code' }, async (root) => {
    const s = await getProjectSettings(root);
    assert.equal(s.provider, 'via-claude-code');
    assert.doesNotThrow(() => resolveLaunch({ config: { model: { provider: s.provider, name: null }, agent: s.agent } }));
  });
});

test('createProject: explicit incompatible provider is rejected', { skip }, async () => {
  await resetGlobal();
  const parentDir = await mkdtemp(path.join(tmpdir(), 'storm-proj-'));
  try {
    await assert.rejects(
      () => createProject({ name: 'x', parentDir, agent: 'claude-code', model: { provider: 'via-opencode', name: null } }),
      /no puede lanzar Claude Code/,
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

test('updateProjectSettings: switching agent rescaffolds and adapts the provider', { skip }, async () => {
  await resetGlobal();
  await withProject({ agent: 'claude-code', model: { provider: 'via-claude-code', name: null } }, async (root) => {
    const r = await updateProjectSettings(root, { agent: 'opencode' });
    assert.equal(r.after.agent, 'opencode');
    assert.equal(r.after.provider, 'via-opencode');
    assert.ok(r.scaffold.createdFiles.includes('AGENTS.md'));
    assert.ok(await exists(path.join(root, 'AGENTS.md')));
    assert.ok(await exists(path.join(root, '.opencode', 'commands')));
    assert.ok(await exists(path.join(root, 'CLAUDE.md')), 'old instructions file is kept');
    assert.ok(r.notes.some((n) => n.includes('CLAUDE.md')));

    const launch = resolveLaunch({ config: await readConfig(root) });
    assert.deepEqual([launch.command, launch.args], ['opencode', []]);
  });
});

test('updateProjectSettings: switching agent keeps a compatible provider/model', { skip }, async () => {
  await resetGlobal();
  await withProject({ agent: 'claude-code', model: { provider: 'ollama-cloud', name: 'glm-5:cloud' } }, async (root) => {
    const r = await updateProjectSettings(root, { agent: 'opencode' });
    assert.equal(r.after.provider, 'ollama-cloud');
    assert.equal(r.after.model, 'glm-5:cloud');
    const launch = resolveLaunch({ config: await readConfig(root) });
    assert.deepEqual(launch.args, ['launch', 'opencode', '--model', 'glm-5:cloud']);
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
      () => updateProjectSettings(root, { provider: 'ollama-local' }),
      /necesita un modelo/,
    );
    const r = await updateProjectSettings(root, { provider: 'ollama-local', model: 'qwen3.5:9b' });
    assert.equal(r.after.model, 'qwen3.5:9b');
    const r2 = await updateProjectSettings(root, { provider: 'claude' });
    assert.equal(r2.after.model, null);
  });
});

test('updateProjectSettings: rejects incompatible or invalid combinations', { skip }, async () => {
  await resetGlobal();
  await withProject({ agent: 'claude-code', model: { provider: 'claude', name: null } }, async (root) => {
    await assert.rejects(() => updateProjectSettings(root, { provider: 'via-opencode' }), /no se puede lanzar/);
    await assert.rejects(() => updateProjectSettings(root, { provider: 'nope' }), /Provider desconocido/);
    await assert.rejects(() => updateProjectSettings(root, { agent: 'aider' }), /launchCommand/);
    // Nothing was written.
    assert.deepEqual(await getProjectSettings(root), {
      provider: 'claude', model: null, agent: 'claude-code', launchCommand: null,
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

  const known = resolveLaunch({ config: { ...base, agent: 'claude-code' }, globalConfig, env: {} });
  assert.equal(known.command, 'ollama');

  const custom = resolveLaunch({ config: { ...base, agent: 'aider' }, globalConfig, env: {} });
  assert.deepEqual([custom.command, custom.args], ['aider', ['--model', 'glm-5:cloud']]);

  const own = resolveLaunch({
    config: { ...base, agent: 'claude-code', launch: { customCommand: 'my-wrapper {{model}}' } },
    globalConfig,
    env: {},
  });
  assert.deepEqual([own.command, own.args], ['my-wrapper', ['glm-5:cloud']]);
});

test('resolveLaunch: passes the global ollamaHost unless OLLAMA_HOST is set', () => {
  const config = { model: { provider: 'ollama-local', name: 'qwen3.5:9b' }, agent: 'opencode' };
  const globalConfig = { ollamaHost: 'http://gpu-box:11434' };
  assert.deepEqual(resolveLaunch({ config, globalConfig, env: {} }).env, { OLLAMA_HOST: 'http://gpu-box:11434' });
  assert.deepEqual(resolveLaunch({ config, globalConfig, env: { OLLAMA_HOST: 'http://x:1' } }).env, {});
});

test('createProject: a global ollama provider without model is ignored', { skip }, async () => {
  await resetGlobal();
  await setDefaultProvider({ provider: 'ollama-cloud', model: null });
  await withProject({ agent: 'opencode' }, async (root) => {
    const s = await getProjectSettings(root);
    assert.equal(s.provider, 'claude');
    assert.doesNotThrow(() => resolveLaunch({ config: { model: { provider: s.provider, name: s.model }, agent: s.agent } }));
  });
});
