/**
 * Tests for src/core/agents.js
 *
 * Run: node --test test/agents.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENTS,
  getAgent,
  buildAgentLaunchCommand,
} from '../src/core/agents.js';

test('AGENTS catalog: every entry is well-formed', () => {
  assert.ok(AGENTS.length >= 2, 'expected at least claude-code + opencode');
  const ids = new Set();
  for (const a of AGENTS) {
    assert.ok(a.id, 'id required');
    assert.ok(a.label, 'label required');
    assert.ok(a.detectCommand, 'detectCommand required');
    assert.ok(a.launchTemplates, 'launchTemplates required');
    assert.ok(a.install, 'install required');
    assert.ok(!ids.has(a.id), `duplicate agent id: ${a.id}`);
    ids.add(a.id);
  }
  assert.ok(ids.has('claude-code'));
  assert.ok(ids.has('opencode'));
});

test('getAgent: returns null for unknown ids', () => {
  assert.equal(getAgent('not-real'), null);
  assert.ok(getAgent('claude-code'));
  assert.ok(getAgent('opencode'));
});

test('buildAgentLaunchCommand: claude-code + ollama-cloud uses ollama launch claude', () => {
  const r = buildAgentLaunchCommand({
    provider: 'ollama-cloud',
    agentId: 'claude-code',
    modelName: 'kimi-k2.6:cloud',
  });
  assert.equal(r.command, 'ollama');
  assert.deepEqual(r.args, ['launch', 'claude', '--model', 'kimi-k2.6:cloud']);
});

test('buildAgentLaunchCommand: claude-code + ollama-local same shape', () => {
  const r = buildAgentLaunchCommand({
    provider: 'ollama-local',
    agentId: 'claude-code',
    modelName: 'qwen3.5:9b',
  });
  assert.equal(r.command, 'ollama');
  assert.deepEqual(r.args, ['launch', 'claude', '--model', 'qwen3.5:9b']);
});

test('buildAgentLaunchCommand: claude-code + claude provider runs `claude` directly', () => {
  const r = buildAgentLaunchCommand({
    provider: 'claude',
    agentId: 'claude-code',
    modelName: null,
  });
  assert.equal(r.command, 'claude');
  assert.deepEqual(r.args, []);
});

test('buildAgentLaunchCommand: opencode + ollama-cloud uses ollama launch opencode', () => {
  const r = buildAgentLaunchCommand({
    provider: 'ollama-cloud',
    agentId: 'opencode',
    modelName: 'glm-4.7:cloud',
  });
  assert.equal(r.command, 'ollama');
  assert.deepEqual(r.args, ['launch', 'opencode', '--model', 'glm-4.7:cloud']);
});

test('buildAgentLaunchCommand: opencode + ollama-local also uses ollama launch opencode', () => {
  const r = buildAgentLaunchCommand({
    provider: 'ollama-local',
    agentId: 'opencode',
    modelName: 'qwen3-coder',
  });
  assert.equal(r.command, 'ollama');
  assert.deepEqual(r.args, ['launch', 'opencode', '--model', 'qwen3-coder']);
});

test('buildAgentLaunchCommand: opencode + claude provider runs `opencode` directly', () => {
  const r = buildAgentLaunchCommand({
    provider: 'claude',
    agentId: 'opencode',
    modelName: null,
  });
  assert.equal(r.command, 'opencode');
  assert.deepEqual(r.args, []);
});

test('buildAgentLaunchCommand: throws when ollama provider has no model', () => {
  assert.throws(
    () => buildAgentLaunchCommand({
      provider: 'ollama-cloud',
      agentId: 'claude-code',
      modelName: null,
    }),
    /requiere un model name/,
  );
});

test('buildAgentLaunchCommand: throws on unknown agent without customCommand', () => {
  assert.throws(
    () => buildAgentLaunchCommand({
      provider: 'ollama-cloud',
      agentId: 'totally-fake',
      modelName: 'x',
    }),
    /Agent desconocido/,
  );
});

test('buildAgentLaunchCommand: customCommand overrides everything', () => {
  const r = buildAgentLaunchCommand({
    provider: 'ollama-cloud',
    agentId: 'whatever',
    modelName: 'kimi-k2.6:cloud',
    customCommand: 'aider --model {{model}} --no-auto-commits',
  });
  assert.equal(r.command, 'aider');
  assert.deepEqual(r.args, ['--model', 'kimi-k2.6:cloud', '--no-auto-commits']);
});

test('buildAgentLaunchCommand: customCommand respects quoted strings', () => {
  const r = buildAgentLaunchCommand({
    provider: 'claude',
    agentId: 'claude-code',
    modelName: null,
    customCommand: 'python -m my_agent --provider "ollama cloud"',
  });
  assert.equal(r.command, 'python');
  assert.deepEqual(r.args, ['-m', 'my_agent', '--provider', 'ollama cloud']);
});

test('buildAgentLaunchCommand: customCommand with no {{model}} works fine', () => {
  const r = buildAgentLaunchCommand({
    provider: 'claude',
    agentId: 'whatever',
    modelName: null,
    customCommand: 'gemini',
  });
  assert.equal(r.command, 'gemini');
  assert.deepEqual(r.args, []);
});

test('buildAgentLaunchCommand: empty customCommand throws', () => {
  assert.throws(
    () => buildAgentLaunchCommand({
      provider: 'claude',
      agentId: 'x',
      modelName: null,
      customCommand: '   ',
    }),
    /vacío/,
  );
});
