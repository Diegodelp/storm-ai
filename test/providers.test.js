/**
 * Tests for src/core/providers.js and src/commands/launch.js
 *
 * We can't fully test detectOllama/listOllamaModels here because they
 * shell out to the real `ollama` binary. We test:
 *   - CLOUD_MODELS / LOCAL_RECOMMENDED structure
 *   - buildCommand() logic (pure function)
 *
 * The `ollama list` parser has its own test using fixture strings.
 *
 * Run: node --test test/providers.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CLOUD_MODELS, LOCAL_RECOMMENDED, PROVIDERS, getProvider } from '../src/core/providers.js';
import { buildCommand } from '../src/commands/launch.js';

test('CLOUD_MODELS entries are well-formed and end in :cloud', () => {
  assert.ok(CLOUD_MODELS.length > 0);
  for (const m of CLOUD_MODELS) {
    assert.ok(m.name, 'name required');
    assert.ok(m.label, 'label required');
    assert.ok(m.hint, 'hint required');
    assert.ok(m.name.endsWith(':cloud'), `${m.name} should end with :cloud`);
  }
});

test('LOCAL_RECOMMENDED entries are well-formed and do NOT end in :cloud', () => {
  assert.ok(LOCAL_RECOMMENDED.length > 0);
  for (const m of LOCAL_RECOMMENDED) {
    assert.ok(m.name);
    assert.ok(m.label);
    assert.ok(m.hint);
    assert.ok(!m.name.endsWith(':cloud'), `${m.name} should not end with :cloud`);
  }
});

test('buildCommand for ollama-cloud: uses `ollama launch claude --model`', () => {
  const r = buildCommand({ provider: 'ollama-cloud', modelName: 'kimi-k2.6:cloud' });
  assert.equal(r.command, 'ollama');
  assert.deepEqual(r.args, ['launch', 'claude', '--model', 'kimi-k2.6:cloud']);
});

test('buildCommand for ollama-local: same as cloud', () => {
  const r = buildCommand({ provider: 'ollama-local', modelName: 'glm-4.7-flash' });
  assert.equal(r.command, 'ollama');
  assert.deepEqual(r.args, ['launch', 'claude', '--model', 'glm-4.7-flash']);
});

test('buildCommand for claude provider: runs `claude` directly', () => {
  const r = buildCommand({ provider: 'claude', modelName: null });
  assert.equal(r.command, 'claude');
  assert.deepEqual(r.args, []);
});

test('buildCommand for unknown provider throws (no fallback)', () => {
  // The new agent-aware launcher throws when the provider is unknown,
  // because there's no launch template for it. Users who need this
  // should configure a custom launch command via `storm config`.
  assert.throws(
    () => buildCommand({ provider: 'some-future-thing', modelName: null }),
    /no tiene un launch template/,
  );
});

test('buildCommand throws when ollama provider has no model', () => {
  assert.throws(
    () => buildCommand({ provider: 'ollama-cloud', modelName: null }),
    /requiere un model name/,
  );
  assert.throws(
    () => buildCommand({ provider: 'ollama-local', modelName: null }),
    /requiere un model name/,
  );
});

// ---------------------------------------------------------------------------
// PROVIDERS catalog (canonical list used by every wizard)
// ---------------------------------------------------------------------------

test('PROVIDERS: every entry is well-formed', () => {
  for (const p of PROVIDERS) {
    assert.ok(p.id && typeof p.id === 'string',           `${p.id ?? '?'}: missing id`);
    assert.ok(p.label && typeof p.label === 'string',     `${p.id}: missing label`);
    assert.ok(p.hint && typeof p.hint === 'string',       `${p.id}: missing hint`);
    assert.equal(typeof p.hasModelPicker, 'boolean',      `${p.id}: hasModelPicker not boolean`);
    // requiresCli is null OR a non-empty string
    assert.ok(
      p.requiresCli === null || (typeof p.requiresCli === 'string' && p.requiresCli.length > 0),
      `${p.id}: bad requiresCli`,
    );
  }
});

test('PROVIDERS: includes the 5 expected providers', () => {
  const ids = PROVIDERS.map((p) => p.id);
  assert.ok(ids.includes('ollama-cloud'));
  assert.ok(ids.includes('ollama-local'));
  assert.ok(ids.includes('claude'));
  assert.ok(ids.includes('via-claude-code'));
  assert.ok(ids.includes('via-opencode'));
});

test('PROVIDERS: via-* require their CLI', () => {
  const viaClaude = PROVIDERS.find((p) => p.id === 'via-claude-code');
  const viaOpencode = PROVIDERS.find((p) => p.id === 'via-opencode');
  assert.equal(viaClaude.requiresCli, 'claude');
  assert.equal(viaOpencode.requiresCli, 'opencode');
});

test('PROVIDERS: only ollama-* show a model picker', () => {
  for (const p of PROVIDERS) {
    if (p.id === 'ollama-cloud' || p.id === 'ollama-local') {
      assert.equal(p.hasModelPicker, true, `${p.id} should have a model picker`);
    } else {
      assert.equal(p.hasModelPicker, false, `${p.id} should NOT have a model picker`);
    }
  }
});

test('getProvider: returns null for unknown ids', () => {
  assert.equal(getProvider('nope'), null);
  assert.equal(getProvider(''), null);
});

test('getProvider: returns the entry by id', () => {
  const p = getProvider('via-opencode');
  assert.ok(p);
  assert.equal(p.label, 'Via OpenCode CLI');
});
