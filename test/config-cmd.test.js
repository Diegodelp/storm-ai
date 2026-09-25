/**
 * Tests for src/commands/config.js
 *
 * As with global-config.test.js we need to mock HOME, which Windows
 * ignores — so the tests skip on win32.
 *
 * Run: node --test test/config-cmd.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const skipOnWindows = process.platform === 'win32';

async function withFakeHome(fn) {
  const fake = path.join(tmpdir(), `storm-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(fake, { recursive: true });
  const prev = process.env.HOME;
  process.env.HOME = fake;
  try {
    return await fn(fake);
  } finally {
    process.env.HOME = prev;
    await rm(fake, { recursive: true, force: true });
  }
}

test('getConfigValue + setConfigValue: round-trip provider', { skip: skipOnWindows }, async () => {
  await withFakeHome(async () => {
    const mod = await import(`../src/commands/config.js?cb=${Date.now()}`);
    await mod.setConfigValue('provider', 'ollama-cloud');
    const r = await mod.getConfigValue('provider');
    assert.equal(r.value, 'ollama-cloud');
  });
});

test('setConfigValue: unknown key throws', { skip: skipOnWindows }, async () => {
  await withFakeHome(async () => {
    const mod = await import(`../src/commands/config.js?cb=${Date.now()}`);
    await assert.rejects(
      () => mod.setConfigValue('unknownThing', 'x'),
      /Clave desconocida/,
    );
  });
});

test('getConfigValue: agent has default claude-code when unset', { skip: skipOnWindows }, async () => {
  await withFakeHome(async () => {
    const mod = await import(`../src/commands/config.js?cb=${Date.now()}`);
    const r = await mod.getConfigValue('agent');
    assert.equal(r.value, 'claude-code');
  });
});

test('setConfigValue: agent and read back', { skip: skipOnWindows }, async () => {
  await withFakeHome(async () => {
    const mod = await import(`../src/commands/config.js?cb=${Date.now()}`);
    await mod.setConfigValue('agent', 'opencode');
    const r = await mod.getConfigValue('agent');
    assert.equal(r.value, 'opencode');
  });
});

test('setConfigValue: launchCommand persists', { skip: skipOnWindows }, async () => {
  await withFakeHome(async () => {
    const mod = await import(`../src/commands/config.js?cb=${Date.now()}`);
    await mod.setConfigValue('launchCommand', 'aider --model {{model}}');
    const r = await mod.getConfigValue('launchCommand');
    assert.equal(r.value, 'aider --model {{model}}');
  });
});

test('setConfigValue: launchCommand=null clears it', { skip: skipOnWindows }, async () => {
  await withFakeHome(async () => {
    const mod = await import(`../src/commands/config.js?cb=${Date.now()}`);
    await mod.setConfigValue('launchCommand', 'aider');
    await mod.setConfigValue('launchCommand', null);
    const r = await mod.getConfigValue('launchCommand');
    assert.equal(r.value, null);
  });
});

test('setConfigValue: ollamaHost defaults sensibly', { skip: skipOnWindows }, async () => {
  await withFakeHome(async () => {
    const mod = await import(`../src/commands/config.js?cb=${Date.now()}`);
    const r = await mod.getConfigValue('ollamaHost');
    assert.equal(r.value, 'http://127.0.0.1:11434');
    await mod.setConfigValue('ollamaHost', 'http://my-server:8080');
    const r2 = await mod.getConfigValue('ollamaHost');
    assert.equal(r2.value, 'http://my-server:8080');
  });
});

test('readAllConfig: returns the merged shape', { skip: skipOnWindows }, async () => {
  await withFakeHome(async () => {
    const mod = await import(`../src/commands/config.js?cb=${Date.now()}`);
    await mod.setConfigValue('provider', 'ollama-cloud');
    await mod.setConfigValue('model', 'kimi-k2.6:cloud');
    await mod.setConfigValue('agent', 'opencode');

    const cfg = await mod.readAllConfig();
    assert.equal(cfg.defaultProvider.provider, 'ollama-cloud');
    assert.equal(cfg.defaultProvider.model, 'kimi-k2.6:cloud');
    assert.equal(cfg.defaultAgent, 'opencode');
  });
});

test('resetConfig: wipes back to defaults', { skip: skipOnWindows }, async () => {
  await withFakeHome(async () => {
    const mod = await import(`../src/commands/config.js?cb=${Date.now()}`);
    await mod.setConfigValue('agent', 'opencode');
    await mod.resetConfig();
    const r = await mod.getConfigValue('agent');
    assert.equal(r.value, 'claude-code');
  });
});

// ---------------------------------------------------------------------------
// Provider/model consistency
// ---------------------------------------------------------------------------

test('setConfigValue: changing provider clears the old model', { skip: skipOnWindows }, async () => {
  await withFakeHome(async () => {
    const mod = await import(`../src/commands/config.js?cb=${Date.now()}`);
    await mod.setConfigValue('provider', 'ollama-cloud');
    await mod.setConfigValue('model', 'kimi-k2.6:cloud');
    await mod.setConfigValue('provider', 'via-opencode');
    assert.equal((await mod.getConfigValue('provider')).value, 'via-opencode');
    assert.equal((await mod.getConfigValue('model')).value, null);
  });
});

test('setConfigValue: re-setting the same provider keeps the model', { skip: skipOnWindows }, async () => {
  await withFakeHome(async () => {
    const mod = await import(`../src/commands/config.js?cb=${Date.now()}`);
    await mod.setConfigValue('provider', 'ollama-cloud');
    await mod.setConfigValue('model', 'kimi-k2.6:cloud');
    await mod.setConfigValue('provider', 'ollama-cloud');
    assert.equal((await mod.getConfigValue('model')).value, 'kimi-k2.6:cloud');
  });
});

test('setConfigValue: rejects unknown providers and mismatched models', { skip: skipOnWindows }, async () => {
  await withFakeHome(async () => {
    const mod = await import(`../src/commands/config.js?cb=${Date.now()}`);
    await assert.rejects(() => mod.setConfigValue('provider', 'openai'), /Provider desconocido/);
    await assert.rejects(() => mod.setConfigValue('model', 'kimi-k2.6:cloud'), /Primero elegí un provider/);
    await mod.setConfigValue('provider', 'claude');
    await assert.rejects(() => mod.setConfigValue('model', 'kimi-k2.6:cloud'), /no usa un modelo/);
    await mod.setConfigValue('provider', 'ollama-cloud');
    await assert.rejects(() => mod.setConfigValue('model', 'qwen3.5:9b'), /no es un modelo cloud/);
  });
});

test('setConfigValue: unset provider clears it', { skip: skipOnWindows }, async () => {
  await withFakeHome(async () => {
    const mod = await import(`../src/commands/config.js?cb=${Date.now()}`);
    await mod.setConfigValue('provider', 'ollama-cloud');
    await mod.setConfigValue('provider', null);
    const cfg = await mod.readAllConfig();
    assert.equal(cfg.defaultProvider, null);
  });
});

test('setProviderAndModel: saves both or nothing', { skip: skipOnWindows }, async () => {
  await withFakeHome(async () => {
    const mod = await import(`../src/commands/config.js?cb=${Date.now()}`);
    await mod.setProviderAndModel('ollama-local', 'qwen3.5:9b');
    await assert.rejects(() => mod.setProviderAndModel('ollama-cloud', 'qwen3.5:9b'));
    const cfg = await mod.readAllConfig();
    assert.deepEqual(cfg.defaultProvider, { provider: 'ollama-local', model: 'qwen3.5:9b' });
  });
});
