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
import { getEventListeners } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
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
async function fakeBinary(name, response, script) {
  const dir = await mkdtemp(path.join(tmpdir(), 'storm-fakecli-'));
  const entry = path.join(dir, 'cli.cjs');
  await writeFile(entry, script ?? `
    process.stdin.resume();
    process.stdin.on('end', () => process.stdout.write(${JSON.stringify(response)}));
  `, 'utf8');
  if (isWindows) {
    const file = path.join(dir, `${name}.cmd`);
    await writeFile(file, `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`, 'utf8');
  } else {
    const file = path.join(dir, name);
    const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
    await writeFile(file, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} "$@"\n`, 'utf8');
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
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
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

test('via-opencode: reads text from JSON events', async () => {
  const fake = await fakeBinary('opencode', [
    { type: 'step_start', part: { type: 'step-start' } },
    { type: 'reasoning', part: { text: 'hidden reasoning' } },
    { type: 'text', part: { text: 'hello from fake opencode' } },
    { type: 'tool_use', part: { text: 'tool output' } },
    { type: 'text', part: { text: 'second paragraph' } },
    { type: 'step_finish', part: { type: 'step-finish' } },
  ].map((event) => JSON.stringify(event)).join('\r\n'));
  try {
    await withPath(fake.dir, async () => {
      const out = await complete({
        provider: 'via-opencode',
        prompt: 'ping',
      });
      assert.equal(out, 'hello from fake opencode\nsecond paragraph');
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

for (const [provider, binary, args] of [
  ['via-claude-code', 'claude', ['--print', '--output-format', 'text']],
  ['via-opencode', 'opencode', ['run', '--format', 'json']],
]) {
  test(`${provider}: passes long Unicode prompts on stdin with correct arguments`, async () => {
    const fake = await fakeBinary(binary, '', `
      let prompt = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => prompt += chunk);
      process.stdin.on('end', () => {
        const text = JSON.stringify({ args: process.argv.slice(2), prompt });
        process.stdout.write(${JSON.stringify(binary)} === 'opencode'
          ? JSON.stringify({ type: 'text', part: { text } }) + '\\n' : text);
      });
    `);
    try {
      await withPath(fake.dir, async () => {
        const prompt = 'á漢字🙂 "quoted" & | %PATH%\n'.repeat(4000);
        const out = JSON.parse(await complete({ provider, system: 'Analyze', prompt }));
        assert.deepEqual(out.args, args);
        assert.equal(out.prompt, `Analyze\n\n---\n\n${prompt}`);
      });
    } finally {
      await fake.cleanup();
    }
  });
}

test('via-opencode: propagates JSON error events even with exit code zero', async () => {
  const fake = await fakeBinary('opencode', JSON.stringify({
    type: 'error', error: { name: 'APIError', data: { message: 'Model not found' } },
  }));
  try {
    await withPath(fake.dir, () => assert.rejects(
      complete({ provider: 'via-opencode', prompt: 'x' }), /OpenCode: Model not found/,
    ));
  } finally {
    await fake.cleanup();
  }
});

test('via-opencode: rejects malformed JSON and responses without text', async () => {
  for (const response of ['not json', '{"type":"step_finish"}']) {
    const fake = await fakeBinary('opencode', response);
    try {
      await withPath(fake.dir, () => assert.rejects(
        complete({ provider: 'via-opencode', prompt: 'x' }), /JSON inválido|stdout vacío/,
      ));
    } finally {
      await fake.cleanup();
    }
  }
});

test('CLI: early exit with a large unread prompt reports stderr, not unhandled EPIPE', async () => {
  const fake = await fakeBinary('claude', '', `
    process.stderr.write('Model not found');
    process.exit(2);
  `);
  try {
    await withPath(fake.dir, () => assert.rejects(
      complete({ provider: 'via-claude-code', prompt: 'x'.repeat(2_000_000) }),
      /código 2.*\n.*Model not found/,
    ));
  } finally {
    await fake.cleanup();
  }
});

test('complete: pre-aborted requests preserve the cancellation reason for every provider', async () => {
  const reason = new Error('cancelled before starting');
  for (const provider of ['via-claude-code', 'via-opencode', 'claude', 'ollama-local', 'ollama-cloud']) {
    await assert.rejects(
      complete({ provider, prompt: 'x', signal: AbortSignal.abort(reason) }),
      (err) => err === reason,
    );
  }
});

test('CLI: removes the abort listener when the request finishes', async () => {
  const fake = await fakeBinary('claude', 'done');
  const controller = new AbortController();
  try {
    await withPath(fake.dir, async () => {
      assert.equal(await complete({ provider: 'via-claude-code', prompt: 'x', signal: controller.signal }), 'done');
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });
  } finally {
    await fake.cleanup();
  }
});

test('CLI: cancellation stops the running CLI, including the Windows shell child', { timeout: 10_000 }, async () => {
  const fake = await fakeBinary('claude', '', `
    require('node:fs').writeFileSync(require('node:path').join(__dirname, 'pid'), String(process.pid));
    process.stdin.resume();
    setInterval(() => {}, 1000);
    setTimeout(() => process.exit(0), 7000);
  `);
  const controller = new AbortController();
  const reason = new Error('cancel running CLI');
  try {
    await withPath(fake.dir, async () => {
      const result = assert.rejects(complete({ provider: 'via-claude-code', prompt: 'x', signal: controller.signal }), (err) => err === reason);
      let pid;
      for (let attempt = 0; attempt < 250 && !pid; attempt++) {
        try { pid = Number(await readFile(path.join(fake.dir, 'pid'), 'utf8')); } catch { await delay(10); }
      }
      controller.abort(reason);
      await result;
      assert.ok(pid, 'fake CLI must have started before cancellation');
      let alive = true;
      for (let attempt = 0; attempt < 250 && alive; attempt++) {
        try { process.kill(pid, 0); await delay(10); } catch { alive = false; }
      }
      assert.equal(alive, false, 'CLI must terminate after cancellation');
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });
  } finally {
    controller.abort(reason);
    await fake.cleanup();
  }
});

test('Ollama: resolves OLLAMA_HOST per call and normalizes trailing slashes', async (t) => {
  const previous = process.env.OLLAMA_HOST;
  t.after(() => {
    if (previous === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = previous;
  });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, ...init, body: JSON.parse(init.body) });
    return Response.json({ response: 'ok' });
  });
  for (const host of ['http://remote:11434/', 'other:11434']) {
    process.env.OLLAMA_HOST = host;
    assert.equal(await complete({ provider: 'ollama-local', model: 'local-model', system: 'sys', prompt: 'x', temperature: 0 }), 'ok');
  }
  assert.deepEqual(requests.map((r) => r.url), ['http://remote:11434/api/generate', 'http://other:11434/api/generate']);
  assert.equal(requests[0].body.model, 'local-model');
  assert.equal(requests[0].body.system, 'sys');
  assert.equal(requests[0].body.options.temperature, 0);
  assert.equal(requests[0].body.stream, false);
});

test('Ollama local: missing installed models fail before generating', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(url, /\/api\/tags$/);
    return Response.json({ models: [] });
  });
  await assert.rejects(complete({ provider: 'ollama-local', prompt: 'x' }), /requiere un modelo local/);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('Ollama local: analysis automatically uses a detected installed model', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'installed:latest' }, { name: 'model:cloud' }] });
    assert.match(url, /\/api\/generate$/);
    assert.equal(JSON.parse(init.body).model, 'installed:latest');
    return Response.json({ response: 'analysis' });
  });
  assert.equal(await complete({ provider: 'ollama-local', prompt: 'x' }), 'analysis');
});

test('HTTP providers: preserve cancellation during fetch', async (t) => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-only';
  t.after(() => {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  });
  for (const provider of ['ollama-cloud', 'claude']) {
    const controller = new AbortController();
    const reason = new Error('cancelled during fetch');
    const mock = t.mock.method(globalThis, 'fetch', async () => {
      controller.abort(reason);
      throw new Error('fetch failed');
    });
    await assert.rejects(complete({ provider, prompt: 'x', signal: controller.signal }), (err) => err === reason);
    mock.mock.restore();
  }
});

test('Ollama: reports HTTP failures and rejects empty or malformed responses', async (t) => {
  for (const [response, pattern] of [
    [new Response('model missing', { status: 404 }), /Ollama respondió 404: model missing/],
    [Response.json({ response: '' }), /Respuesta inesperada de Ollama/],
    [Response.json(null), /Respuesta inesperada de Ollama/],
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => response);
    await assert.rejects(complete({ provider: 'ollama-cloud', prompt: 'x' }), pattern);
    mock.mock.restore();
  }
});

test('Claude API: handles text blocks and rejects malformed content with a provider error', async (t) => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-only';
  t.after(() => {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  });
  let response = { content: [
    { type: 'thinking', thinking: 'private' },
    { type: 'text', text: 'hello ' },
    { type: 'text', text: 'world' },
  ] };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.headers['x-api-key'], 'test-only');
    assert.equal(JSON.parse(init.body).model, 'custom-model');
    return Response.json(response);
  });
  const input = { provider: 'claude', model: 'custom-model', prompt: 'x' };
  assert.equal(await complete(input), 'hello world');
  response = { content: { unexpected: true } };
  await assert.rejects(complete(input), /Respuesta vacía de Anthropic/);
});
