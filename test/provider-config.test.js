import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

// A fresh process isolates cached homedir/config modules on Windows and Unix.
async function withConfig(script, setup) {
  const dir = await mkdtemp(path.join(tmpdir(), 'storm-provider-config-'));
  try {
    if (setup) await setup(dir);
    return await execFileAsync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import path from 'node:path';
      import { readFile } from 'node:fs/promises';
      import * as globalConfig from './src/core/global-config.js';
      import { setConfigValue, getConfigValue } from './src/commands/config.js';
      assert.equal(globalConfig.CONFIG_FILE_PATH, path.join(process.env.STORM_TEST_HOME, '.storm-ai', 'config.json'));
      ${script}
    `], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: dir,
        USERPROFILE: dir,
        STORM_TEST_HOME: dir,
        OLLAMA_HOST: '',
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
      },
      windowsHide: true,
      timeout: 10_000,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('provider changes clear incompatible models, reselecting the same provider preserves them', async () => {
  await withConfig(`
    await setConfigValue('provider', 'ollama-cloud');
    await setConfigValue('model', 'test:cloud');
    await setConfigValue('provider', 'ollama-cloud');
    assert.equal((await getConfigValue('model')).value, 'test:cloud');
    await setConfigValue('provider', 'ollama-local');
    assert.equal((await getConfigValue('model')).value, null);
    await setConfigValue('model', 'local-model');
    await setConfigValue('provider', 'claude');
    assert.equal((await getConfigValue('model')).value, null);
  `);
});

test('Ollama host: environment overrides saved config, which overrides localhost', async () => {
  await withConfig(`
    assert.equal(await globalConfig.getOllamaHost(), 'http://127.0.0.1:11434');
    await setConfigValue('ollamaHost', 'http://saved-host:11434/');
    assert.equal(await globalConfig.getOllamaHost(), 'http://saved-host:11434');
    process.env.OLLAMA_HOST = 'https://env-host:443/ollama/';
    assert.equal(await globalConfig.getOllamaHost(), 'https://env-host/ollama');
    process.env.OLLAMA_HOST = 'ftp://bad-host';
    await assert.rejects(globalConfig.getOllamaHost(), /http o https/);
  `);
});

async function fakeOllama(dir) {
  const entry = path.join(dir, 'ollama.cjs');
  await writeFile(entry, `
    const fs = require('node:fs');
    const path = require('node:path');
    fs.writeFileSync(path.join(__dirname, 'capture.json'), JSON.stringify({
      host: process.env.OLLAMA_HOST, args: process.argv.slice(2), cwd: process.cwd(),
    }));
    if (process.argv[2] === 'list') {
      console.log('NAME  ID  SIZE  MODIFIED\\nlocal-model  abc123  1 GB  1 day ago');
    }
    process.exitCode = Number(process.env.STORM_TEST_EXIT ?? 0);
  `);
  for (const name of ['ollama', 'opencode', 'claude']) {
    if (process.platform === 'win32') {
      await writeFile(path.join(dir, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`);
    } else {
      const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
      await writeFile(path.join(dir, name), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} "$@"\n`);
      await chmod(path.join(dir, name), 0o755);
    }
  }
}

test('Ollama: HTTP, model discovery and launch use the saved remote host', async () => {
  await withConfig(`
    import { complete } from './src/core/llm-client.js';
    import { listOllamaModels } from './src/core/providers.js';
    import { launchForProject } from './src/commands/launch.js';
    import { createConfig, writeConfig } from './src/core/config.js';
    const root = process.env.STORM_TEST_HOME;
    const host = 'http://saved-host:11434';
    await setConfigValue('ollamaHost', host);
    globalThis.fetch = async (url) => {
      assert.equal(url, host + '/api/generate');
      return Response.json({ response: 'remote response' });
    };
    assert.equal(await complete({ provider: 'ollama-local', model: 'local-model', prompt: 'x' }), 'remote response');
    assert.equal((await listOllamaModels())[0].name, 'local-model');
    const capture = async () => JSON.parse(await readFile(path.join(root, 'capture.json'), 'utf8'));
    assert.equal((await capture()).host, host);
    await writeConfig(root, createConfig({ name: 'fixture', agent: 'opencode', model: { provider: 'ollama-local', name: 'local-model' } }));
    await launchForProject({ projectRoot: root });
    const launched = await capture();
    assert.equal(launched.host, host);
    assert.deepEqual(launched.args, ['--model', 'ollama/local-model']);
    const native = JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8'));
    assert.equal(native.model, 'ollama/local-model');
    assert.equal(native.provider.ollama.options.baseURL, host + '/v1');
    assert.equal(launched.cwd, root);
    process.env.STORM_TEST_EXIT = '7';
    await assert.rejects(launchForProject({ projectRoot: root }), /código 7/);
  `, fakeOllama);
});
