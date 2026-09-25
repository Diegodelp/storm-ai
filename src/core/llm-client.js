/**
 * Minimal LLM client used by `storm import`.
 *
 * Five backends:
 *   - 'ollama-cloud' / 'ollama-local': POSTs to OLLAMA_HOST/api/generate
 *     with the chosen model name. Cloud models include the ":cloud" suffix
 *     and Ollama itself routes the request to ollama.com — we never hit
 *     ollama.com directly.
 *   - 'claude': POSTs to https://api.anthropic.com/v1/messages using the
 *     ANTHROPIC_API_KEY env var.
 *   - 'via-claude-code': delegates to the `claude` CLI in the user's PATH.
 *     Runs `claude --print --output-format text` with the prompt on stdin.
 *     Whatever model is configured in Claude Code (API, Pro sub, etc.)
 *     is what we end up using.
 *   - 'via-opencode': delegates to the `opencode` CLI in the user's PATH.
 *     Runs `opencode run --format json` and extracts text events. Uses the
 *     model configured in OpenCode (ChatGPT, Gemini, Anthropic, etc.).
 *
 * The 'via-*' providers exist so users who already pay for Claude Code or
 * OpenCode (including ChatGPT Pro routed through OpenCode) can analyze
 * projects without configuring a separate API key for storm.
 *
 * The interface is intentionally narrow: text in, text out.
 */

import process from 'node:process';
import { spawn } from 'node:child_process';
import { getOllamaHost } from './global-config.js';
import { chooseInstalledModel, isCloudModel, listOllamaModels } from './providers.js';

const ANTHROPIC_HOST = 'https://api.anthropic.com';

/** Default model used if none is provided. Reasonable for most tasks. */
const DEFAULT_OLLAMA_MODEL = 'kimi-k2.6:cloud';
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-5';

/**
 * @typedef {Object} CompleteInput
 * @property {string} provider           'ollama-cloud' | 'ollama-local' | 'claude' | 'via-claude-code' | 'via-opencode'
 * @property {string|null} [model]       Model name. Provider default if null.
 *                                       For 'via-*' providers, ignored — model comes from the agent's own config.
 * @property {string} prompt             User prompt.
 * @property {string} [system]           Optional system prompt.
 * @property {number} [temperature]      Sampling temperature (default 0.2).
 *                                       For 'via-*' providers, ignored.
 * @property {AbortSignal} [signal]      Cancellation.
 */

/**
 * Run a single completion. Returns the assistant's reply as plain text.
 *
 * @param {CompleteInput} input
 * @returns {Promise<string>}
 */
export async function complete(input) {
  input.signal?.throwIfAborted();
  if (input.provider === 'ollama-cloud' || input.provider === 'ollama-local') {
    return ollamaComplete(input);
  }
  if (input.provider === 'claude') {
    return claudeComplete(input);
  }
  if (input.provider === 'via-claude-code') {
    return viaCliComplete(input, {
      cmd: 'claude',
      args: ['--print', '--output-format', 'text'],
      installHint: 'Corré `storm config` → Instalar agent → Claude Code, o ejecutá `irm https://claude.ai/install.ps1 | iex` (Windows).',
    });
  }
  if (input.provider === 'via-opencode') {
    return viaCliComplete(input, {
      cmd: 'opencode',
      args: ['run', '--format', 'json'],
      parseOutput: parseOpenCodeOutput,
      installHint: 'Corré `storm config` → Instalar agent → OpenCode.',
    });
  }
  throw new Error(`Provider desconocido: ${input.provider}`);
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

async function ollamaComplete(input) {
  let model = input.model?.trim();
  if (input.provider === 'ollama-local') {
    model ||= chooseInstalledModel(await listOllamaModels(), input.provider);
    input.signal?.throwIfAborted();
    if (!model) throw new Error('ollama-local requiere un modelo local instalado. Indicá --model o descargá uno con `ollama pull <modelo>`.');
    if (isCloudModel(model)) throw new Error('El modelo elegido es cloud; usá ollama-cloud o elegí un modelo local.');
  }
  model ||= DEFAULT_OLLAMA_MODEL;
  const host = await getOllamaHost();
  const url = `${host}/api/generate`;

  const body = {
    model,
    prompt: input.prompt,
    system: input.system,
    stream: false,
    options: {
      temperature: input.temperature ?? 0.2,
    },
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: input.signal,
    });
  } catch (err) {
    input.signal?.throwIfAborted();
    throw new Error(
      `No se pudo contactar a Ollama en ${host}. ` +
        `¿Está corriendo el daemon? (\`ollama serve\`). Error: ${err.message}`,
    );
  }

  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`Ollama respondió ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  if (typeof data?.response !== 'string' || !data.response.trim()) {
    throw new Error(`Respuesta inesperada de Ollama: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.response;
}

// ---------------------------------------------------------------------------
// Claude (Anthropic)
// ---------------------------------------------------------------------------

async function claudeComplete(input) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Falta ANTHROPIC_API_KEY en el environment. ' +
        'Definila o cambiá el provider a Ollama.',
    );
  }

  const model = input.model || DEFAULT_CLAUDE_MODEL;
  const url = `${ANTHROPIC_HOST}/v1/messages`;

  const body = {
    model,
    max_tokens: 4096,
    temperature: input.temperature ?? 0.2,
    system: input.system,
    messages: [{ role: 'user', content: input.prompt }],
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: input.signal,
    });
  } catch (err) {
    input.signal?.throwIfAborted();
    throw new Error(`No se pudo contactar a Anthropic: ${err.message}`);
  }

  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`Anthropic respondió ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  // Response shape: { content: [{ type: 'text', text: '...' }, ...] }
  const text = (Array.isArray(data?.content) ? data.content : [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  if (!text) {
    throw new Error(`Respuesta vacía de Anthropic: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return text;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '<no body>';
  }
}

// ---------------------------------------------------------------------------
// via-* CLI delegation
//
// We spawn the agent's CLI as a subprocess. The contract is:
//   - We pass the prompt on stdin.
//   - The CLI runs in non-interactive print mode.
//   - We read stdout as the response.
//   - stderr is forwarded if non-empty AND the exit code is non-zero.
//
// Why stdin and not args:
//   Prompts can be 5-50 KB long with the "deep" import mode. Passing that
//   on argv hits OS-level limits (Windows ~32K, Linux ~128K) and gets
//   clobbered by shell quoting. stdin is unlimited, no quoting hell.
//
// Task-specific instructions are inlined before the user prompt; each CLI
// also keeps its own configured system instructions.
// ---------------------------------------------------------------------------

function parseOpenCodeOutput(stdout) {
  const parts = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error('OpenCode devolvió un evento JSON inválido. Verificá `opencode run --help`.');
    }
    if (event?.type === 'error') {
      const message = event.error?.data?.message ?? event.error?.message ?? event.error?.name ?? event.error;
      throw new Error(`OpenCode: ${String(message ?? 'error desconocido').slice(0, 1000)}`);
    }
    if (event?.type === 'text' && typeof event.part?.text === 'string') {
      parts.push(event.part.text);
    }
  }
  return parts.join('\n');
}

function stopCli(proc) {
  if (process.platform === 'win32' && proc.pid) {
    // Killing cmd.exe alone leaves the actual CLI running with its pipes open.
    const killer = spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => { proc.kill(); });
    killer.on('close', (code) => { if (code !== 0) proc.kill(); });
  } else {
    proc.kill('SIGTERM');
  }
}

/**
 * @param {CompleteInput} input
 * @param {{cmd: string, args: string[], installHint: string, parseOutput?: (stdout: string) => string}} cliConfig
 */
async function viaCliComplete(input, cliConfig) {
  const fullPrompt = input.system
    ? `${input.system}\n\n---\n\n${input.prompt}`
    : input.prompt;

  return new Promise((resolve, reject) => {
    let proc;
    try {
      // On Windows, many CLIs ship as .cmd or .bat files (Claude Code's
      // installer creates `claude.cmd`, OpenCode's installer is similar).
      // Without `shell: true`, spawn() only resolves PATHEXT for .exe,
      // so it can't find `.cmd` files. With `shell: true`, the OS shell
      // does the resolution and finds them.
      //
      // On Linux/macOS, `shell: true` is unnecessary and slightly slower,
      // so we keep the direct spawn there.
      const useShell = process.platform === 'win32';
      proc = spawn(cliConfig.cmd, cliConfig.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: useShell,
        // Explicitly pass env so test environments that mutate process.env.PATH
        // see their changes propagate to the child. Without this, Node sometimes
        // snapshots env at the moment the binding loads.
        env: process.env,
      });
    } catch (err) {
      // Synchronous spawn errors (rare on modern Node, but possible).
      reject(new Error(
        `No se pudo lanzar \`${cliConfig.cmd}\`: ${err.message}\n` +
          cliConfig.installHint,
      ));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let stdinError;
    const onAbort = () => {
      try { stopCli(proc); } catch { /* Process may already have exited. */ }
      settle(reject, input.signal.reason);
    };

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener('abort', onAbort);
      fn(value);
    };

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    // A CLI can exit before consuming a large prompt. Wait for close so the
    // caller receives its exit code/stderr instead of an unhandled EPIPE.
    proc.stdin.on('error', (err) => { stdinError = err; });

    proc.on('error', (err) => {
      // ENOENT means the binary isn't in PATH.
      if (err.code === 'ENOENT') {
        settle(reject, new Error(
          `\`${cliConfig.cmd}\` no está instalado o no está en el PATH.\n` +
            cliConfig.installHint,
        ));
      } else {
        settle(reject, new Error(
          `Error ejecutando \`${cliConfig.cmd}\`: ${err.message}`,
        ));
      }
    });

    proc.on('close', (code) => {
      if (settled) return;
      let output = stdout;
      if (cliConfig.parseOutput && stdout.trim()) {
        try {
          output = cliConfig.parseOutput(stdout);
        } catch (err) {
          settle(reject, err);
          return;
        }
      }
      if (code === 0) {
        if (stdinError) {
          settle(reject, new Error(`No se pudo enviar el prompt a \`${cliConfig.cmd}\`: ${stdinError.message}`));
          return;
        }
        if (!output.trim()) {
          settle(reject, new Error(
            `\`${cliConfig.cmd}\` devolvió stdout vacío. ` +
              `stderr: ${stderr.slice(0, 500) || '<vacío>'}`,
          ));
          return;
        }
        settle(resolve, output);
      } else {
        // When `shell: true` on Windows, a missing binary doesn't surface
        // as ENOENT — it surfaces as exit code 1 with a localized stderr
        // message ("X no se reconoce como un comando interno", "X is not
        // recognized as an internal or external command", or similar in
        // any Windows locale). Detect that and remap to the friendly
        // "not installed" error so the user gets the install hint either
        // way.
        const lower = stderr.toLowerCase();
        const looksLikeMissing =
          lower.includes('no se reconoce') ||
          lower.includes('is not recognized') ||
          lower.includes(`${cliConfig.cmd}: command not found`) ||
          lower.includes(`${cliConfig.cmd}: not found`);
        if (looksLikeMissing) {
          settle(reject, new Error(
            `\`${cliConfig.cmd}\` no está instalado o no está en el PATH.\n` +
              cliConfig.installHint,
          ));
          return;
        }
        settle(reject, new Error(
          `\`${cliConfig.cmd}\` salió con código ${code}.\n` +
            `stderr: ${stderr.slice(0, 1000) || '<vacío>'}`,
        ));
      }
    });

    // Allow callers to cancel.
    if (input.signal) {
      input.signal.addEventListener('abort', onAbort, { once: true });
      if (input.signal.aborted) {
        onAbort();
        return;
      }
    }

    // Pipe the prompt to stdin.
    proc.stdin.end(fullPrompt, 'utf8');
  });
}
