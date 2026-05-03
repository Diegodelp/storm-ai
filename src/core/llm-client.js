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
 *     Runs `claude --print "<prompt>"` and reads stdout. Whatever model is
 *     configured in Claude Code (Anthropic API, the user's Pro sub, etc.)
 *     is what we end up using.
 *   - 'via-opencode': delegates to the `opencode` CLI in the user's PATH.
 *     Runs `opencode run --print "<prompt>"`. Whatever model is configured
 *     in OpenCode (ChatGPT via web auth, Gemini, Anthropic, etc.) is used.
 *
 * The 'via-*' providers exist so users who already pay for Claude Code or
 * OpenCode (including ChatGPT Pro routed through OpenCode) can analyze
 * projects without configuring a separate API key for storm.
 *
 * The interface is intentionally narrow: text in, text out.
 */

import process from 'node:process';
import { spawn } from 'node:child_process';

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
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
  if (input.provider === 'ollama-cloud' || input.provider === 'ollama-local') {
    return ollamaComplete(input);
  }
  if (input.provider === 'claude') {
    return claudeComplete(input);
  }
  if (input.provider === 'via-claude-code') {
    return viaCliComplete(input, {
      cmd: 'claude',
      args: ['--print'],
      installHint: 'Corré `storm config` → Instalar agent → Claude Code, o ejecutá `irm https://claude.ai/install.ps1 | iex` (Windows).',
    });
  }
  if (input.provider === 'via-opencode') {
    return viaCliComplete(input, {
      cmd: 'opencode',
      args: ['run', '--print'],
      installHint: 'Corré `storm config` → Instalar agent → OpenCode.',
    });
  }
  throw new Error(`Provider desconocido: ${input.provider}`);
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

async function ollamaComplete(input) {
  const model = input.model || DEFAULT_OLLAMA_MODEL;
  const url = `${OLLAMA_HOST}/api/generate`;

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
    throw new Error(
      `No se pudo contactar a Ollama en ${OLLAMA_HOST}. ` +
        `¿Está corriendo el daemon? (\`ollama serve\`). Error: ${err.message}`,
    );
  }

  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`Ollama respondió ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  if (typeof data.response !== 'string') {
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
    throw new Error(`No se pudo contactar a Anthropic: ${err.message}`);
  }

  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`Anthropic respondió ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  // Response shape: { content: [{ type: 'text', text: '...' }, ...] }
  const text = (data?.content ?? [])
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
// Why we don't merge system + prompt:
//   Both Claude Code and OpenCode read system instructions from their own
//   config files (~/.claude/, ~/.config/opencode/). The user has already
//   chosen a "system prompt" globally. We just hand them the user prompt
//   and trust the rest. If we need a stronger system message, we can
//   inline it in the user prompt.
// ---------------------------------------------------------------------------

/**
 * @param {CompleteInput} input
 * @param {{cmd: string, args: string[], installHint: string}} cliConfig
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

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

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

    proc.on('exit', (code) => {
      if (code === 0) {
        if (!stdout.trim()) {
          settle(reject, new Error(
            `\`${cliConfig.cmd}\` devolvió stdout vacío. ` +
              `stderr: ${stderr.slice(0, 500) || '<vacío>'}`,
          ));
          return;
        }
        settle(resolve, stdout);
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
          lower.includes('command not found') ||
          lower.includes('not found');
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
      input.signal.addEventListener('abort', () => {
        try { proc.kill('SIGTERM'); } catch { /* noop */ }
        settle(reject, new Error('Cancelado por el usuario.'));
      }, { once: true });
    }

    // Pipe the prompt to stdin.
    proc.stdin.write(fullPrompt, 'utf8');
    proc.stdin.end();
  });
}
