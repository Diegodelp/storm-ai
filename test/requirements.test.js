/**
 * Tests for src/core/requirements.js
 *
 * We don't simulate the OS — we just verify that detection runs without
 * exception and returns a well-shaped object. On any normal dev machine
 * git/node/npm are installed; the tests assert the shape, not the
 * specific result.
 *
 * Run: node --test test/requirements.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectGit,
  detectNode,
  detectNpm,
  installNodeHint,
} from '../src/core/requirements.js';

test('detectNode: returns shape (installed, version)', async () => {
  const r = await detectNode();
  assert.equal(typeof r.installed, 'boolean');
  // If installed (which it must be — we're running in node), version is a string.
  if (r.installed) {
    assert.equal(typeof r.version, 'string');
    // Node version usually starts with "v", e.g. "v20.11.0".
    assert.match(r.version, /^v?\d+/);
  } else {
    assert.equal(r.version, null);
  }
});

test('detectNpm: returns shape', async () => {
  const r = await detectNpm();
  assert.equal(typeof r.installed, 'boolean');
});

test('detectGit: returns shape', async () => {
  const r = await detectGit();
  assert.equal(typeof r.installed, 'boolean');
  if (r.installed) {
    assert.match(r.version, /git/i);
  }
});

test('installNodeHint: returns a message for win32', () => {
  const r = installNodeHint('win32');
  assert.equal(r.ok, false);
  assert.match(r.message, /nodejs\.org/);
});

test('installNodeHint: returns a message for linux/darwin', () => {
  const linuxHint = installNodeHint('linux');
  assert.equal(linuxHint.ok, false);
  assert.match(linuxHint.message, /nvm|nodejs/i);

  const macHint = installNodeHint('darwin');
  assert.equal(macHint.ok, false);
});
