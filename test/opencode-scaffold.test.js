/**
 * Tests for src/core/opencode-scaffold.js
 *
 * Verifies that the canonical command and agent specs are well-formed
 * and that the index renders correctly. The actual file-writing happens
 * in commands/import.js and commands/new.js — those are tested in their
 * own files.
 *
 * Run: node --test test/opencode-scaffold.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_OPENCODE_COMMANDS,
  BUILTIN_OPENCODE_AGENTS,
  renderOpencodeCommand,
  renderOpencodeAgent,
  renderOpencodeIndex,
} from '../src/core/opencode-scaffold.js';

test('BUILTIN_OPENCODE_COMMANDS: every entry is well-formed', () => {
  assert.ok(BUILTIN_OPENCODE_COMMANDS.length >= 5,
    'Expected at least 5 command specs');
  for (const cmd of BUILTIN_OPENCODE_COMMANDS) {
    assert.match(cmd.id, /^[a-z][a-z0-9-]*$/,
      `${cmd.id ?? '?'}: id should be kebab-case`);
    assert.ok(cmd.title && cmd.title.length > 0, `${cmd.id}: missing title`);
    assert.ok(cmd.summary && cmd.summary.length > 0, `${cmd.id}: missing summary`);
    assert.ok(cmd.body && cmd.body.length > 100,
      `${cmd.id}: body should be substantial (>100 chars)`);
    // Each command body must include at least one storm CLI invocation
    // — these files are instructions for the LLM on how to call storm.
    assert.match(cmd.body, /storm\s+\w+/,
      `${cmd.id}: body must mention an actual storm command`);
  }
});

test('BUILTIN_OPENCODE_COMMANDS: includes the core task lifecycle', () => {
  const ids = BUILTIN_OPENCODE_COMMANDS.map((c) => c.id);
  // The minimum vocabulary the LLM needs to use storm productively.
  assert.ok(ids.includes('task-add'));
  assert.ok(ids.includes('task-start'));
  assert.ok(ids.includes('task-done'));
  assert.ok(ids.includes('refresh'));
  assert.ok(ids.includes('sync'));
});

test('BUILTIN_OPENCODE_COMMANDS: ids are unique', () => {
  const ids = BUILTIN_OPENCODE_COMMANDS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate command id');
});

test('BUILTIN_OPENCODE_AGENTS: every entry is well-formed', () => {
  assert.ok(BUILTIN_OPENCODE_AGENTS.length >= 2,
    'Expected at least 2 agent specs');
  for (const ag of BUILTIN_OPENCODE_AGENTS) {
    assert.match(ag.id, /^[a-z][a-z0-9-]*$/,
      `${ag.id ?? '?'}: id should be kebab-case`);
    assert.ok(ag.title && ag.title.length > 0, `${ag.id}: missing title`);
    assert.ok(ag.summary && ag.summary.length > 0, `${ag.id}: missing summary`);
    assert.ok(ag.body && ag.body.length > 100, `${ag.id}: body too short`);
  }
});

test('renderOpencodeCommand: includes the body and has a knowledge-base banner', () => {
  const out = renderOpencodeCommand({
    id: 'test-cmd',
    title: 'Test',
    summary: 'A test command',
    body: '# Test command\n\nDo `storm test` to test things.\n',
  });
  // Banner: tells the reader that OpenCode does NOT execute this file.
  assert.match(out, /not executed|knowledge base|reference document/i);
  // Body content shows up.
  assert.match(out, /Do `storm test`/);
});

test('renderOpencodeAgent: includes the body', () => {
  const out = renderOpencodeAgent({
    id: 'test-agent',
    title: 'Test Agent',
    summary: '',
    body: '# Test\n\nDo important things.\n',
  });
  assert.match(out, /Do important things/);
});

test('renderOpencodeIndex: lists every command and agent with correct paths', () => {
  const idx = renderOpencodeIndex();
  // Every command should appear in the commands index, with its id used
  // to build the relative path .opencode/commands/<id>.md.
  for (const cmd of BUILTIN_OPENCODE_COMMANDS) {
    assert.ok(
      idx.commands.includes(`.opencode/commands/${cmd.id}.md`),
      `command ${cmd.id} not in index`,
    );
    assert.ok(
      idx.commands.includes(cmd.summary),
      `command ${cmd.id} summary not in index`,
    );
  }
  for (const ag of BUILTIN_OPENCODE_AGENTS) {
    assert.ok(
      idx.agents.includes(`.opencode/agents/${ag.id}.md`),
      `agent ${ag.id} not in index`,
    );
  }
});
