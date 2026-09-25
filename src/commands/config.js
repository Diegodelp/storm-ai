/**
 * `storm config` — read and modify the global storm-ai config.
 *
 * The CLI exposes two surfaces:
 *   1. `storm config`            → interactive wizard (see ui/wizard-config.js).
 *   2. `storm config get/set`    → scriptable get/set of individual keys.
 *
 * The keys we support are intentionally narrow:
 *   - provider                   (any id from PROVIDERS; changing it clears model)
 *   - model                      (only for providers that take one: ollama-*)
 *   - agent                      (claude-code | opencode | <other>)
 *   - launchCommand              (free shell string with {{model}} placeholder)
 *   - ollamaHost                 (http://...)
 *
 * These are defaults for NEW projects (and the provider `storm import`
 * analyzes with). Existing projects are edited with `storm project`.
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
import { validateProviderModel, providerNeedsModel } from '../core/providers.js';

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
  const v = typeof value === 'string' ? value.trim() : value;
  switch (key) {
    case 'provider': {
      if (!v) {
        await setDefaultProvider(null);
        return;
      }
      const err = validateProviderModel(v, null);
      if (err) throw new Error(err);
      const cfg = await readGlobalConfig();
      // A model only makes sense for the provider it was picked for.
      const keepModel = cfg.defaultProvider?.provider === v ? cfg.defaultProvider.model : null;
      await setDefaultProvider({ provider: v, model: keepModel ?? null });
      return;
    }
    case 'model': {
      const cfg = await readGlobalConfig();
      const provider = cfg.defaultProvider?.provider;
      if (!v) {
        if (provider) await setDefaultProvider({ provider, model: null });
        return;
      }
      if (!provider) {
        throw new Error('Primero elegí un provider: storm config set provider <id>.');
      }
      if (!providerNeedsModel(provider)) {
        throw new Error(validateProviderModel(provider, v));
      }
      const err = validateProviderModel(provider, v);
      if (err) throw new Error(err);
      await setDefaultProvider({ provider, model: v });
      return;
    }
    case 'agent':
      await setDefaultAgent(v || 'claude-code');
      return;
    case 'launchCommand':
      await setDefaultLaunchCommand(v || null);
      return;
    case 'ollamaHost':
      if (v) {
        // Same forms Ollama accepts: a full URL or host:port.
        let url;
        try { url = new URL(v.includes('://') ? v : `http://${v}`); } catch { url = null; }
        if (!url || !['http:', 'https:'].includes(url.protocol)) {
          throw new Error('ollamaHost debe ser una URL http(s) o host:puerto.');
        }
      }
      await setOllamaHost(v || null);
      return;
  }
}

/**
 * Set provider and model together (what the wizard uses, so the global
 * config never ends up with a provider paired with another's model).
 * @param {string} provider
 * @param {string|null} model
 */
export async function setProviderAndModel(provider, model) {
  const err = validateProviderModel(provider, model);
  if (err) throw new Error(err);
  await setDefaultProvider({ provider, model: model || null });
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
