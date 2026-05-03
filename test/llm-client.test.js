/**
 * Tests for src/core/llm-client.js, focused on the two `via-*` providers.
 *
 * We can't actually run `claude` or `opencode` here, so we mock spawn
 * via tmp shell scripts on the PATH. The test creates a tiny "claude"
 * (or "opencode") executable that echoes a fixed response, prepends its
 * directory to PATH, and calls complete().
 *
 * Run: node --test test/llm-client.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import path from 'node:path';

import { complete } from '../src/core/llm-client.js';

const isWindows = platform() === 'win32';

/**
 * Make a fake CLI binary on a tmp dir and return its dir + cleanup.
 * The fake reads stdin, ignores it, and prints `response`.
 *
 * On Windows we make a `.cmd` file. On Unix we make a shell script.
 * Either way the binary basename matches `name`.
 */
async function fakeBinary(name, response) {
  const dir = await mkdtemp(path.join(tmpdir(), 'storm-fakecli-'));
  if (isWindows) {
    const file = path.join(dir, `${name}.cmd`);
    // Windows .cmd that echoes the response to stdout.
    // We use single-line echo to avoid newline shenanigans.
    await writeFile(file, `@echo off\r\necho ${response}\r\n`, 'utf8');
  } else {
    const file = path.join(dir, name);
    await writeFile(file, `#!/bin/sh\nprintf '%s' "${response}"\n`, 'utf8');
    await chmod(file, 0o755);
  }
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function withPath(extraDir, fn) {
  const sep = isWindows ? ';' : ':';
  const oldPath = process.env.PATH;
  process.env.PATH = `${extraDir}${sep}${oldPath}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = oldPath;
  }
}

test('via-claude-code: spawns `claude --print` and returns stdout', async () => {
  const fake = await fakeBinary('claude', 'hello from fake claude');
  try {
    await withPath(fake.dir, async () => {
      const out = await complete({
        provider: 'via-claude-code',
        prompt: 'ping',
      });
      assert.match(out, /hello from fake claude/);
    });
  } finally {
    await fake.cleanup();
  }
});

test('via-opencode: spawns `opencode run --print` and returns stdout', async () => {
  const fake = await fakeBinary('opencode', 'hello from fake opencode');
  try {
    await withPath(fake.dir, async () => {
      const out = await complete({
        provider: 'via-opencode',
        prompt: 'ping',
      });
      assert.match(out, /hello from fake opencode/);
    });
  } finally {
    await fake.cleanup();
  }
});

test('via-claude-code: missing binary throws clear error', async () => {
  // Use a guaranteed-empty path so `claude` is definitely not found.
  const oldPath = process.env.PATH;
  process.env.PATH = isWindows ? 'C:\\Windows\\System32' : '/nonexistent-path-storm-test';
  try {
    await assert.rejects(
      () => complete({ provider: 'via-claude-code', prompt: 'x' }),
      /no está instalado o no está en el PATH|no se pudo lanzar/i,
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test('complete: unknown provider rejects', async () => {
  await assert.rejects(
    () => complete({ provider: 'made-up-thing', prompt: 'x' }),
    /Provider desconocido/,
  );
});
