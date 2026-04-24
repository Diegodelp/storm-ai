/**
 * Model provider detection and model listing.
 *
 * Two providers are supported at runtime:
 *   - 'claude-code'  : Anthropic Claude Code, unmodified. User provides API key.
 *   - 'ollama'       : Claude Code wired to Ollama via `ollama launch claude`.
 *                      Models can be local (detected via `ollama list`) or
 *                      cloud (hardcoded list, resolved server-side by Ollama).
 *
 * Design choices:
 *   - We never HTTP to ollama.com to list cloud models. The catalog changes
 *     too often; we ship a curated shortlist and let the user type any
 *     name they want.
 *   - `ollama list` has a short timeout. If it hangs (daemon down, etc.)
 *     we treat it as "no local models" and move on.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const OLLAMA_LIST_TIMEOUT_MS = 5000;

/**
 * Curated list of recommended cloud models. These run on Ollama's hosted
 * infrastructure (https://ollama.com) and don't require a local download.
 * Source: Ollama's Claude Code integration doc + ollama.com/search?c=cloud.
 *
 * Ordered by general recommendation strength for agentic coding tasks.
 * Updated: April 2026.
 */
export const CLOUD_MODELS = [
  {
    name: 'kimi-k2.6:cloud',
    label: 'Kimi K2.6 (cloud)',
    hint: 'Top open agentic coder, 256K context',
  },
  {
    name: 'kimi-k2.5:cloud',
    label: 'Kimi K2.5 (cloud)',
    hint: 'Previous Kimi generation, still strong',
  },
  {
    name: 'glm-5:cloud',
    label: 'GLM-5 (cloud)',
    hint: 'ChatGLM latest, balanced',
  },
  {
    name: 'minimax-m2.7:cloud',
    label: 'MiniMax M2.7 (cloud)',
    hint: 'Coding + agentic workflows',
  },
  {
    name: 'qwen3.5:cloud',
    label: 'Qwen 3.5 (cloud)',
    hint: 'Alibaba flagship, multimodal',
  },
];

/**
 * Curated list of recommended LOCAL models. These map to names the user
 * can `ollama pull` directly.
 */
export const LOCAL_RECOMMENDED = [
  {
    name: 'glm-4.7-flash',
    label: 'GLM-4.7 Flash',
    hint: 'Best overall local default',
  },
  {
    name: 'qwen3-coder:30b',
    label: 'Qwen3 Coder 30B',
    hint: 'Best local for coding',
  },
  {
    name: 'qwen3.5:27b',
    label: 'Qwen 3.5 27B',
    hint: 'Strong local generalist',
  },
  {
    name: 'qwen3.5:9b',
    label: 'Qwen 3.5 9B',
    hint: 'Budget local option',
  },
];

/**
 * @typedef {Object} OllamaStatus
 * @property {boolean} installed    Is the `ollama` binary on PATH?
 * @property {string|null} version  Output of `ollama --version`, or null.
 */

/**
 * @returns {Promise<OllamaStatus>}
 */
export async function detectOllama() {
  try {
    const { stdout } = await execAsync('ollama --version', {
      timeout: OLLAMA_LIST_TIMEOUT_MS,
      windowsHide: true,
    });
    return { installed: true, version: stdout.trim() };
  } catch {
    return { installed: false, version: null };
  }
}

/**
 * @typedef {Object} LocalModel
 * @property {string} name
 * @property {string} [size]       Human-readable (e.g., "4.1 GB")
 * @property {string} [modified]   Relative timestamp from `ollama list`.
 */

/**
 * Parse the output of `ollama list`. Format (newer versions):
 *   NAME                   ID              SIZE      MODIFIED
 *   qwen3.5:9b             abc123def       6.6 GB    2 days ago
 *
 * Older versions have different columns. We grab the first column and
 * best-effort on size. If parsing fails for a row, we skip it.
 *
 * @returns {Promise<LocalModel[]>}
 */
export async function listOllamaModels() {
  try {
    const { stdout } = await execAsync('ollama list', {
      timeout: OLLAMA_LIST_TIMEOUT_MS,
      windowsHide: true,
    });
    const lines = stdout.split(/\r?\n/).map((l) => l.trimEnd());
    if (lines.length === 0) return [];

    // Drop the header if present.
    const body = lines[0].toUpperCase().startsWith('NAME') ? lines.slice(1) : lines;

    const models = [];
    for (const line of body) {
      if (!line.trim()) continue;
      // Split on whitespace runs of 2+ to preserve "2 days ago" as one cell.
      const cells = line.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
      if (cells.length === 0) continue;
      models.push({
        name: cells[0],
        size: cells[2] || null,
        modified: cells[3] || null,
      });
    }
    return models;
  } catch {
    return [];
  }
}

/**
 * Install Ollama. Tries the official one-liner installers.
 * Returns true on success, false on failure or user abort.
 *
 * @param {'darwin'|'linux'|'win32'} platform
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function installOllama(platform) {
  if (platform === 'win32') {
    return {
      ok: false,
      message:
        'On Windows, please download Ollama manually from https://ollama.com/download. ' +
        'After installing, re-run this wizard.',
    };
  }

  // macOS + Linux share the same install script.
  try {
    const { stdout, stderr } = await execAsync(
      'curl -fsSL https://ollama.com/install.sh | sh',
      { timeout: 120_000, windowsHide: true },
    );
    return { ok: true, message: (stdout + stderr).slice(-500) };
  } catch (err) {
    return {
      ok: false,
      message:
        `Ollama installer failed: ${err.message}. ` +
        `Please install manually from https://ollama.com/download.`,
    };
  }
}

/**
 * Pull a local model via `ollama pull`. This streams to our stdout so
 * the user sees progress — it can take minutes for large models.
 *
 * @param {string} modelName
 * @returns {Promise<{ok: boolean, message?: string}>}
 */
export async function pullOllamaModel(modelName) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const proc = spawn('ollama', ['pull', modelName], {
      stdio: 'inherit',
      windowsHide: true,
    });
    proc.on('exit', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, message: `ollama pull exited with code ${code}` });
    });
    proc.on('error', (err) => {
      resolve({ ok: false, message: err.message });
    });
  });
}
