/**
 * Global storm-ai config (machine-wide preferences).
 *
 * Lives at ~/.storm-ai/config.json and stores user preferences:
 *   - default AI provider + model: used by `storm import` to analyze
 *     projects, and as the default for NEW projects
 *   - default agent (Claude Code, OpenCode, ...) for NEW projects
 *   - default custom launch command for NEW projects, and the fallback
 *     for projects whose agent storm doesn't know
 *   - OLLAMA_HOST (used by `storm import`, model listing and launch;
 *     the OLLAMA_HOST env var wins over it)
 *
 * Existing projects are NOT affected by changes here: each one keeps its
 * own provider/model/agent in <project>/project.config.json, editable
 * with `storm project`.
 *
 * The schema is forward-compatible: unknown fields are preserved. Reading
 * a missing or corrupt file returns sensible defaults (no exception).
 *
 * Schema:
 *   {
 *     "defaultProvider": {
 *       "provider": <id from PROVIDERS in core/providers.js>,
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
import process from 'node:process';

import { atomicWriteJson } from './atomic-io.js';

// Resolved on every call (not at import time) so HOME overrides — tests,
// wrappers — take effect.
const configDir = () => path.join(homedir(), '.storm-ai');
const configFile = () => path.join(configDir(), 'config.json');

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
    const raw = await readFile(configFile(), 'utf8');
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
 * Uses atomic write + lock so concurrent storm subprocesses don't
 * corrupt the file.
 * @param {GlobalConfig} config
 */
export async function writeGlobalConfig(config) {
  await mkdir(configDir(), { recursive: true });
  const out = { ...config, updatedAt: new Date().toISOString() };
  await atomicWriteJson(configFile(), out);
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
 * @param {{provider: string, model: string|null}|null} input  null clears it.
 */
export async function setDefaultProvider(input) {
  const cfg = await readGlobalConfig();
  cfg.defaultProvider = input?.provider
    ? { provider: input.provider, model: input.model ?? null }
    : null;
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
  const host = process.env.OLLAMA_HOST?.trim() || cfg.ollamaHost?.trim() || 'http://127.0.0.1:11434';
  // Ollama accepts host:port as well as a full URL. fetch requires a scheme.
  const url = new URL(host.includes('://') ? host : `http://${host}`);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('OLLAMA_HOST debe usar http o https.');
  }
  return url.toString().replace(/\/+$/, '');
}

/**
 * @param {string} host
 */
export async function setOllamaHost(host) {
  const cfg = await readGlobalConfig();
  cfg.ollamaHost = host || 'http://127.0.0.1:11434';
  await writeGlobalConfig(cfg);
}

/** Path of the config file (for the wizard "open in editor" hint). */
export const CONFIG_FILE_PATH = configFile();
