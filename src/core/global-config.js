/**
 * Global storm-ai config (machine-wide preferences).
 *
 * Lives at ~/.storm-ai/config.json and stores user preferences that
 * apply across all projects:
 *   - default AI provider (used by `storm import` and as a wizard default)
 *   - default model name
 *   - whether the user finished the first-run setup
 *
 * Per-project config still lives in <project>/project.config.json — this
 * is for things that aren't project-specific.
 *
 * The schema is forward-compatible: unknown fields are preserved. Reading
 * a missing or corrupt file returns sensible defaults (no exception).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const CONFIG_DIR = path.join(homedir(), '.storm-ai');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * @typedef {Object} GlobalConfig
 * @property {Object} [defaultProvider]
 * @property {'ollama-cloud'|'ollama-local'|'claude'} [defaultProvider.provider]
 * @property {string|null} [defaultProvider.model]
 * @property {string} [updatedAt]
 */

/** @returns {GlobalConfig} */
function emptyConfig() {
  return { defaultProvider: null };
}

/**
 * Read the global config. Never throws — returns defaults on error.
 * @returns {Promise<GlobalConfig>}
 */
export async function readGlobalConfig() {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyConfig();
    return parsed;
  } catch {
    return emptyConfig();
  }
}

/**
 * Write the global config. Creates ~/.storm-ai/ if needed.
 * @param {GlobalConfig} config
 */
export async function writeGlobalConfig(config) {
  await mkdir(CONFIG_DIR, { recursive: true });
  const out = { ...config, updatedAt: new Date().toISOString() };
  await writeFile(CONFIG_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');
}

/**
 * Convenience: read just the default provider, or null if not set.
 * @returns {Promise<{provider: string, model: string|null}|null>}
 */
export async function getDefaultProvider() {
  const cfg = await readGlobalConfig();
  if (!cfg.defaultProvider?.provider) return null;
  return {
    provider: cfg.defaultProvider.provider,
    model: cfg.defaultProvider.model ?? null,
  };
}

/**
 * Convenience: persist a default provider so future commands can use it.
 * @param {{provider: string, model: string|null}} input
 */
export async function setDefaultProvider(input) {
  const cfg = await readGlobalConfig();
  cfg.defaultProvider = {
    provider: input.provider,
    model: input.model ?? null,
  };
  await writeGlobalConfig(cfg);
}
