/**
 * Tests for src/core/stacks.js
 *
 * Run: node --test test/stacks.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STACKS,
  DATABASES,
  getStack,
  getDatabase,
  matchesAnyPattern,
  suggestBranchDescription,
} from '../src/core/stacks.js';

test('STACKS: every entry is well-formed', () => {
  assert.ok(STACKS.length > 5);
  const ids = new Set();
  for (const s of STACKS) {
    assert.ok(s.id, 'id required');
    assert.ok(s.label, 'label required');
    assert.ok(s.hint, 'hint required');
    assert.ok(Array.isArray(s.branchPatterns));
    assert.ok(Array.isArray(s.initialBranches));
    assert.ok(Array.isArray(s.branchHints));
    assert.ok(!ids.has(s.id), `duplicate id: ${s.id}`);
    ids.add(s.id);
  }
  // 'other' must be present as escape hatch.
  assert.ok(ids.has('other'));
});

test('DATABASES: every entry is well-formed', () => {
  assert.ok(DATABASES.length > 5);
  const ids = new Set();
  for (const d of DATABASES) {
    assert.ok(d.id);
    assert.ok(d.label);
    assert.ok(d.hint);
    assert.ok(!ids.has(d.id));
    ids.add(d.id);
  }
  assert.ok(ids.has('other'));
  assert.ok(ids.has('none'));
});

test('getStack returns null for unknown ids', () => {
  assert.equal(getStack('definitely-not-a-stack'), null);
  assert.ok(getStack('nextjs-app'));
});

test('getDatabase returns null for unknown ids', () => {
  assert.equal(getDatabase('not-a-db'), null);
  assert.ok(getDatabase('postgres'));
});

test('matchesAnyPattern: simple star matches one segment', () => {
  const patterns = ['src/api/*'];
  assert.equal(matchesAnyPattern('src/api/users', patterns), true);
  assert.equal(matchesAnyPattern('src/api/orders', patterns), true);
  // Deeper paths do NOT match — single * is one level only.
  assert.equal(matchesAnyPattern('src/api/users/v1', patterns), false);
  // Different prefix doesn't match.
  assert.equal(matchesAnyPattern('lib/api/users', patterns), false);
  // Same depth, different literal segment.
  assert.equal(matchesAnyPattern('src/lib/users', patterns), false);
});

test('matchesAnyPattern: leaf-level wildcard', () => {
  const patterns = ['app/*'];
  assert.equal(matchesAnyPattern('app/dashboard', patterns), true);
  assert.equal(matchesAnyPattern('app/api', patterns), true);
  assert.equal(matchesAnyPattern('app', patterns), false); // depth mismatch
});

test('matchesAnyPattern: multiple patterns', () => {
  const patterns = ['src/components/*', 'src/hooks/*'];
  assert.equal(matchesAnyPattern('src/components/Button', patterns), true);
  assert.equal(matchesAnyPattern('src/hooks/useAuth', patterns), true);
  assert.equal(matchesAnyPattern('src/utils/helpers', patterns), false);
});

test('suggestBranchDescription: exact match wins', () => {
  const stack = getStack('nextjs-app');
  const desc = suggestBranchDescription('app/api', stack);
  assert.match(desc, /Route handlers/i);
});

test('suggestBranchDescription: prefix match for deeper paths', () => {
  const stack = getStack('nextjs-app');
  const desc = suggestBranchDescription('app/api/payments', stack);
  // Should contain the parent description plus the suffix.
  assert.match(desc, /payments/);
  assert.ok(desc.length > 0);
});

test('suggestBranchDescription: no match returns empty string', () => {
  const stack = getStack('nextjs-app');
  const desc = suggestBranchDescription('totally/random/path', stack);
  assert.equal(desc, '');
});

test('"other" stack has empty patterns (no auto-detection)', () => {
  const other = getStack('other');
  assert.deepEqual(other.branchPatterns, []);
  assert.deepEqual(other.initialBranches, []);
});
