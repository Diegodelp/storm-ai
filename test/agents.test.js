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

test('buildAgentLaunchCommand: claude-code + ollama-cloud launches claude with native settings', () => {
  const r = buildAgentLaunchCommand({
    provider: 'ollama-cloud',
    agentId: 'claude-code',
    modelName: 'kimi-k2.6:cloud',
  });
  assert.equal(r.command, 'claude');
  assert.deepEqual(r.args, ['--model', 'kimi-k2.6:cloud']);
});

test('buildAgentLaunchCommand: claude-code + ollama-local same shape', () => {
  const r = buildAgentLaunchCommand({
    provider: 'ollama-local',
    agentId: 'claude-code',
    modelName: 'qwen3.5:9b',
  });
  assert.equal(r.command, 'claude');
  assert.deepEqual(r.args, ['--model', 'qwen3.5:9b']);
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

test('buildAgentLaunchCommand: opencode + ollama-cloud launches opencode with native settings', () => {
  const r = buildAgentLaunchCommand({
    provider: 'ollama-cloud',
    agentId: 'opencode',
    modelName: 'glm-4.7:cloud',
  });
  assert.equal(r.command, 'opencode');
  assert.deepEqual(r.args, ['--model', 'ollama/glm-4.7:cloud']);
});

test('buildAgentLaunchCommand: opencode + ollama-local also launches opencode with native settings', () => {
  const r = buildAgentLaunchCommand({
    provider: 'ollama-local',
    agentId: 'opencode',
    modelName: 'qwen3-coder',
  });
  assert.equal(r.command, 'opencode');
  assert.deepEqual(r.args, ['--model', 'ollama/qwen3-coder']);
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

test('buildAgentLaunchCommand: via-* providers launch the independently selected agent', () => {
  for (const provider of ['via-claude-code', 'via-opencode']) {
    for (const [agentId, command] of [['claude-code', 'claude'], ['opencode', 'opencode']]) {
      assert.deepEqual(buildAgentLaunchCommand({ provider, agentId, modelName: null }), { command, args: [] });
    }
  }
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

// ---------------------------------------------------------------------------
// Provider ↔ agent compatibility
// ---------------------------------------------------------------------------

import {
  getCompatibleProviders,
  isProviderCompatible,
  resolveLaunchModel,
  getInstructionsFile,
} from '../src/core/agents.js';
import { PROVIDERS } from '../src/core/providers.js';

test('buildAgentLaunchCommand: via-* provider launches its own CLI', () => {
  assert.deepEqual(
    buildAgentLaunchCommand({ provider: 'via-claude-code', agentId: 'claude-code', modelName: null }),
    { command: 'claude', args: [] },
  );
  assert.deepEqual(
    buildAgentLaunchCommand({ provider: 'via-opencode', agentId: 'opencode', modelName: null }),
    { command: 'opencode', args: [] },
  );
});

test('buildAgentLaunchCommand: via-* of the other CLI still launches the selected agent', () => {
  // via-* only picks the CLI used for import analysis; launch uses the agent.
  assert.equal(
    buildAgentLaunchCommand({ provider: 'via-opencode', agentId: 'claude-code', modelName: null }).command,
    'claude',
  );
  assert.equal(
    buildAgentLaunchCommand({ provider: 'via-claude-code', agentId: 'opencode', modelName: null }).command,
    'opencode',
  );
});

test('buildAgentLaunchCommand: unknown provider throws a clear error', () => {
  assert.throws(
    () => buildAgentLaunchCommand({ provider: 'nope', agentId: 'claude-code', modelName: null }),
    /no se puede lanzar con el provider "nope"/,
  );
});

test('every known agent: its providers exist and its nativeProvider is compatible', () => {
  const ids = new Set(PROVIDERS.map((p) => p.id));
  for (const a of AGENTS) {
    for (const p of getCompatibleProviders(a.id)) assert.ok(ids.has(p), `${a.id}: unknown provider ${p}`);
    assert.ok(isProviderCompatible(a.nativeProvider, a.id), `${a.id}: nativeProvider not compatible`);
  }
});

test('custom agents accept any provider', () => {
  assert.equal(getCompatibleProviders('aider'), null);
  assert.equal(isProviderCompatible('via-opencode', 'aider'), true);
});

test('resolveLaunchModel: keeps compatible models, falls back to the native provider', () => {
  assert.deepEqual(
    resolveLaunchModel({ provider: 'ollama-cloud', name: 'kimi-k2.6:cloud' }, 'opencode'),
    { model: { provider: 'ollama-cloud', name: 'kimi-k2.6:cloud' }, adjusted: false },
  );
  // Every built-in provider drives both agents today; an unknown one falls back.
  assert.deepEqual(
    resolveLaunchModel({ provider: 'some-future-thing', name: 'x' }, 'claude-code'),
    { model: { provider: 'via-claude-code', name: null }, adjusted: true },
  );
});

test('getInstructionsFile: CLAUDE.md for Claude Code, root AGENTS.md otherwise', () => {
  assert.equal(getInstructionsFile('claude-code'), 'CLAUDE.md');
  assert.equal(getInstructionsFile('opencode'), 'AGENTS.md');
  assert.equal(getInstructionsFile('aider'), 'AGENTS.md');
});
