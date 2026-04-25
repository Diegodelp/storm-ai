/**
 * Tests for src/core/global-config.js
 *
 * We can't easily mock homedir() without deeper plumbing, so this test
 * uses a HOME=<tmpdir> override (Node respects this for os.homedir on
 * many platforms). Skipped on Windows where homedir doesn't honor HOME.
 *
 * Run: node --test test/global-config.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const skipOnWindows = process.platform === 'win32';

async function withFakeHome(fn) {
  const fake = path.join(tmpdir(), `storm-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

test('readGlobalConfig: returns empty config when missing', { skip: skipOnWindows }, async () => {
  await withFakeHome(async () => {
    // Have to dynamic-import so the module re-evaluates with new HOME.
    const mod = await import(`../src/core/global-config.js?cacheBust=${Date.now()}`);
    const cfg = await mod.readGlobalConfig();
    assert.deepEqual(cfg.defaultProvider, null);
  });
});

test('writeGlobalConfig + readGlobalConfig roundtrip', { skip: skipOnWindows }, async () => {
  await withFakeHome(async () => {
    const mod = await import(`../src/core/global-config.js?cacheBust=${Date.now()}`);
    await mod.setDefaultProvider({ provider: 'ollama-cloud', model: 'kimi-k2.6:cloud' });
    const got = await mod.getDefaultProvider();
    assert.equal(got.provider, 'ollama-cloud');
    assert.equal(got.model, 'kimi-k2.6:cloud');
  });
});

test('getDefaultProvider returns null when not set', { skip: skipOnWindows }, async () => {
  await withFakeHome(async () => {
    const mod = await import(`../src/core/global-config.js?cacheBust=${Date.now()}`);
    const got = await mod.getDefaultProvider();
    assert.equal(got, null);
  });
});
