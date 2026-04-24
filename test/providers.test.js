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

import { CLOUD_MODELS, LOCAL_RECOMMENDED } from '../src/core/providers.js';
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

test('buildCommand for unknown provider falls back to claude', () => {
  const r = buildCommand({ provider: 'some-future-thing', modelName: null });
  assert.equal(r.command, 'claude');
});

test('buildCommand throws when ollama provider has no model', () => {
  assert.throws(
    () => buildCommand({ provider: 'ollama-cloud', modelName: null }),
    /requires a model/,
  );
  assert.throws(
    () => buildCommand({ provider: 'ollama-local', modelName: null }),
    /requires a model/,
  );
});
