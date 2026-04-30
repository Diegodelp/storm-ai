/**
 * `storm config` — read and modify the global storm-ai config.
 *
 * The CLI exposes two surfaces:
 *   1. `storm config`            → interactive wizard (see ui/wizard-config.js).
 *   2. `storm config get/set`    → scriptable get/set of individual keys.
 *
 * The keys we support are intentionally narrow:
 *   - provider                   (ollama-cloud | ollama-local | claude)
 *   - model                      (free string)
 *   - agent                      (claude-code | opencode | <other>)
 *   - launchCommand              (free shell string with {{model}} placeholder)
 *   - ollamaHost                 (http://...)
 *
 * For more advanced config (or to inspect the full file), the user can
 * always edit ~/.storm-ai/config.json by hand.
 */

import {
  readGlobalConfig,
  writeGlobalConfig,
  setDefaultProvider,
  setDefaultAgent,
  setDefaultLaunchCommand,
  setOllamaHost,
  CONFIG_FILE_PATH,
} from '../core/global-config.js';

/**
 * @typedef {'provider'|'model'|'agent'|'launchCommand'|'ollamaHost'} ConfigKey
 */

const VALID_KEYS = new Set([
  'provider',
  'model',
  'agent',
  'launchCommand',
  'ollamaHost',
]);

/**
 * Read the entire global config.
 * @returns {Promise<import('../core/global-config.js').GlobalConfig>}
 */
export async function readAllConfig() {
  return readGlobalConfig();
}

/**
 * Read a single value.
 * @param {string} key
 * @returns {Promise<{value: unknown, exists: boolean}>}
 */
export async function getConfigValue(key) {
  if (!VALID_KEYS.has(key)) {
    throw new Error(
      `Clave desconocida: ${key}. Válidas: ${[...VALID_KEYS].join(', ')}.`,
    );
  }
  const cfg = await readGlobalConfig();
  switch (key) {
    case 'provider':
      return { value: cfg.defaultProvider?.provider ?? null, exists: !!cfg.defaultProvider };
    case 'model':
      return { value: cfg.defaultProvider?.model ?? null, exists: !!cfg.defaultProvider };
    case 'agent':
      return { value: cfg.defaultAgent ?? 'claude-code', exists: true };
    case 'launchCommand':
      return { value: cfg.defaultLaunchCommand ?? null, exists: cfg.defaultLaunchCommand != null };
    case 'ollamaHost':
      return { value: cfg.ollamaHost ?? 'http://127.0.0.1:11434', exists: true };
  }
  return { value: null, exists: false };
}

/**
 * Set a single value.
 * @param {string} key
 * @param {string|null} value
 */
export async function setConfigValue(key, value) {
  if (!VALID_KEYS.has(key)) {
    throw new Error(
      `Clave desconocida: ${key}. Válidas: ${[...VALID_KEYS].join(', ')}.`,
    );
  }
  switch (key) {
    case 'provider': {
      const cfg = await readGlobalConfig();
      const model = cfg.defaultProvider?.model ?? null;
      await setDefaultProvider({ provider: value, model });
      return;
    }
    case 'model': {
      const cfg = await readGlobalConfig();
      const provider = cfg.defaultProvider?.provider ?? 'ollama-cloud';
      await setDefaultProvider({ provider, model: value });
      return;
    }
    case 'agent':
      await setDefaultAgent(value);
      return;
    case 'launchCommand':
      await setDefaultLaunchCommand(value);
      return;
    case 'ollamaHost':
      await setOllamaHost(value);
      return;
  }
}

/** Reset config to factory defaults. */
export async function resetConfig() {
  await writeGlobalConfig({
    defaultProvider: null,
    defaultAgent: 'claude-code',
    defaultLaunchCommand: null,
    ollamaHost: 'http://127.0.0.1:11434',
  });
}

export { CONFIG_FILE_PATH };
