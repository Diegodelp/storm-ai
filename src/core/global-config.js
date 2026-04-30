/**
 * Global storm-ai config (machine-wide preferences).
 *
 * Lives at ~/.storm-ai/config.json and stores user preferences that
 * apply across all projects:
 *   - default AI provider + model (used by `storm import` and as
 *     a default in the wizards)
 *   - default agent (Claude Code, OpenCode, ...)
 *   - default custom launch command (advanced)
 *   - OLLAMA_HOST override (advanced)
 *
 * Per-project config still lives in <project>/project.config.json — this
 * is for things that aren't project-specific.
 *
 * The schema is forward-compatible: unknown fields are preserved. Reading
 * a missing or corrupt file returns sensible defaults (no exception).
 *
 * Schema:
 *   {
 *     "defaultProvider": {
 *       "provider": "ollama-cloud" | "ollama-local" | "claude",
 *       "model": "kimi-k2.6:cloud" | null
 *     },
 *     "defaultAgent": "claude-code" | "opencode" | <other>,
 *     "defaultLaunchCommand": "<shell string with {{model}} placeholder>" | null,
 *     "ollamaHost": "http://127.0.0.1:11434",
 *     "updatedAt": "<ISO timestamp>"
 *   }
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const CONFIG_DIR = path.join(homedir(), '.storm-ai');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * @typedef {Object} GlobalConfig
 * @property {{provider: string, model: string|null}|null} [defaultProvider]
 * @property {string} [defaultAgent]
 * @property {string|null} [defaultLaunchCommand]
 * @property {string} [ollamaHost]
 * @property {string} [updatedAt]
 */

/** @returns {GlobalConfig} */
function emptyConfig() {
  return {
    defaultProvider: null,
    defaultAgent: 'claude-code',
    defaultLaunchCommand: null,
    ollamaHost: 'http://127.0.0.1:11434',
  };
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
    // Merge with defaults so missing fields are filled in.
    return { ...emptyConfig(), ...parsed };
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

// ---------------------------------------------------------------------------
// Convenience accessors
// ---------------------------------------------------------------------------

/**
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

/**
 * @returns {Promise<string>}
 */
export async function getDefaultAgent() {
  const cfg = await readGlobalConfig();
  return cfg.defaultAgent ?? 'claude-code';
}

/**
 * @param {string} agentId
 */
export async function setDefaultAgent(agentId) {
  const cfg = await readGlobalConfig();
  cfg.defaultAgent = agentId;
  await writeGlobalConfig(cfg);
}

/**
 * @returns {Promise<string|null>}
 */
export async function getDefaultLaunchCommand() {
  const cfg = await readGlobalConfig();
  return cfg.defaultLaunchCommand ?? null;
}

/**
 * @param {string|null} cmd
 */
export async function setDefaultLaunchCommand(cmd) {
  const cfg = await readGlobalConfig();
  cfg.defaultLaunchCommand = cmd && cmd.trim() ? cmd.trim() : null;
  await writeGlobalConfig(cfg);
}

/**
 * @returns {Promise<string>}
 */
export async function getOllamaHost() {
  const cfg = await readGlobalConfig();
  return cfg.ollamaHost ?? 'http://127.0.0.1:11434';
}

/**
 * @param {string} host
 */
export async function setOllamaHost(host) {
  const cfg = await readGlobalConfig();
  cfg.ollamaHost = host;
  await writeGlobalConfig(cfg);
}

/** Path of the config file (for the wizard "open in editor" hint). */
export const CONFIG_FILE_PATH = CONFIG_FILE;
