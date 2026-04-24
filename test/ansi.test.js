/**
 * Tests for src/ui/ansi.js
 * Run: node --test test/ansi.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// We import dynamically AFTER setting NO_COLOR for the stripping tests.
import { stripAnsi, visibleLength, gradientColor, centerLine } from '../src/ui/ansi.js';

test('stripAnsi removes CSI sequences', () => {
  const withColors = '\x1b[38;2;255;0;0mred\x1b[0m plain \x1b[1mbold\x1b[0m';
  assert.equal(stripAnsi(withColors), 'red plain bold');
});

test('visibleLength ignores escape codes', () => {
  const s = '\x1b[31mhello\x1b[0m';
  assert.equal(visibleLength(s), 5);
  assert.equal(visibleLength('plain'), 5);
  assert.equal(visibleLength(''), 0);
});

test('gradientColor returns correct endpoints', () => {
  const start = gradientColor(0);
  const end = gradientColor(1);
  assert.deepEqual(start, [58, 182, 255]);
  assert.deepEqual(end, [255, 187, 145]);
});

test('gradientColor interpolates between stops', () => {
  const mid = gradientColor(0.5);
  // At t=0.5 we're exactly on the middle stop (violet-ish).
  assert.deepEqual(mid, [181, 120, 255]);
});

test('gradientColor clamps out-of-range inputs', () => {
  assert.deepEqual(gradientColor(-1), [58, 182, 255]);
  assert.deepEqual(gradientColor(2), [255, 187, 145]);
});

test('centerLine pads correctly', () => {
  const centered = centerLine('abc', 9);
  assert.equal(centered, '   abc');
  assert.equal(centerLine('abc', 3), 'abc');
  assert.equal(centerLine('abc', 2), 'abc'); // too wide, no pad
});

test('centerLine respects visible length when text has ANSI', () => {
  const colored = '\x1b[31mhi\x1b[0m'; // visible length 2
  const c = centerLine(colored, 10);
  // Should have pad of (10 - 2) / 2 = 4 leading spaces.
  assert.ok(c.startsWith('    '));
});
