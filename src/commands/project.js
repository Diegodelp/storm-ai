/**
 * `storm project` — read and change how a project is launched:
 * provider, model, agent and custom launch command.
 *
 * These live in <project>/project.config.json and are the ONLY thing
 * `storm launch` / `storm open` look at. The global config
 * (`storm config`) just seeds new projects.
 *
 * Keys:
 *   - provider        any id from PROVIDERS, compatible with the agent.
 *                     Changing it clears the model.
 *   - model           only for providers that take one (ollama-*). Empty =
 *                     automatic (agent-config picks an installed one).
 *   - agent           claude-code | opencode | <custom>. Changing it
 *                     writes the new agent's scaffolding (CLAUDE.md or
 *                     AGENTS.md, commands, ...) and, if the current
 *                     provider can't drive the new agent, switches to the
 *                     agent's native provider.
 *   - launchCommand   custom shell command ({{model}} placeholder).
 *                     Overrides the agent's launch template.
 *
 * Every change re-syncs the agent's native project config
 * (.claude/settings.local.json / opencode.json, see core/agent-config.js).
 */

import { readConfig, writeConfig } from '../core/config.js';
import {
  getAgent,
  getCompatibleProviders,
  isProviderCompatible,
  resolveLaunchModel,
  getInstructionsFile,
  agentLabel,
} from '../core/agents.js';
import { validateProviderModel } from '../core/providers.js';
import { syncAgentConfig } from '../core/agent-config.js';
import { writeAgentScaffold } from './new.js';

export const PROJECT_KEYS = Object.freeze(['provider', 'model', 'agent', 'launchCommand']);

/**
 * @typedef {Object} ProjectLaunchSettings
 * @property {string} provider
 * @property {string|null} model
 * @property {string} agent
 * @property {string|null} launchCommand
 */

/**
 * @param {string} projectRoot
 * @returns {Promise<ProjectLaunchSettings>}
 */
export async function getProjectSettings(projectRoot) {
  const config = await readConfig(projectRoot);
  return settingsOf(config);
}

/**
 * @param {import('../core/config.js').ProjectConfig} config
 * @returns {ProjectLaunchSettings}
 */
function settingsOf(config) {
  return {
    provider: config.model?.provider ?? 'claude',
    model: config.model?.name ?? null,
    agent: config.agent ?? 'claude-code',
    launchCommand: config.launch?.customCommand ?? null,
  };
}

/**
 * Validate a full set of settings. Returns an error message or null.
 * @param {ProjectLaunchSettings} s
 * @returns {string|null}
 */
export function validateProjectSettings(s) {
  if (!s.agent?.trim()) return 'El agent no puede estar vacío.';
  const pm = validateProviderModel(s.provider, s.model);
  if (pm) return pm;
  if (!s.launchCommand) {
    if (!getAgent(s.agent)) {
      return `"${s.agent}" no es un agent conocido: definí un launchCommand para poder lanzarlo.`;
    }
    if (!isProviderCompatible(s.provider, s.agent)) {
      return `${agentLabel(s.agent)} no se puede lanzar con "${s.provider}". ` +
        `Compatibles: ${getCompatibleProviders(s.agent).join(', ')}.`;
    }
  }
  return null;
}

/**
 * Apply a patch to the project's launch settings, validate the result,
 * persist it, and write the new agent's scaffolding if the agent changed.
 *
 * Normalizations:
 *   - provider changed and model not given → model cleared.
 *   - agent changed, provider not given, current provider incompatible
 *     with the new agent → agent's native provider.
 *
 * @param {string} projectRoot
 * @param {Partial<ProjectLaunchSettings>} patch  `null` clears model/launchCommand.
 * @returns {Promise<{
 *   before: ProjectLaunchSettings,
 *   after: ProjectLaunchSettings,
 *   scaffold: {createdFiles: string[], skippedFiles: string[]} | null,
 *   notes: string[],
 * }>}
 */
export async function updateProjectSettings(projectRoot, patch) {
  const config = await readConfig(projectRoot);
  const before = settingsOf(config);
  const next = { ...before };
  /** @type {string[]} */
  const notes = [];

  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
  const clean = (v) => (typeof v === 'string' ? v.trim() || null : v ?? null);

  if (has('agent')) next.agent = clean(patch.agent) ?? 'claude-code';
  if (has('launchCommand')) next.launchCommand = clean(patch.launchCommand);
  if (has('provider')) {
    next.provider = clean(patch.provider) ?? 'claude';
    if (next.provider !== before.provider && !has('model')) next.model = null;
  }
  if (has('model')) next.model = clean(patch.model);

  if (next.agent !== before.agent && !has('provider') && getAgent(next.agent)) {
    const r = resolveLaunchModel({ provider: next.provider, name: next.model }, next.agent);
    if (r.adjusted) {
      notes.push(
        `"${next.provider}" no puede lanzar ${agentLabel(next.agent)}; ` +
        `el provider pasa a "${r.model.provider}".`,
      );
      next.provider = r.model.provider;
      next.model = r.model.name;
    }
  }

  const err = validateProjectSettings(next);
  if (err) throw new Error(err);

  config.model = { provider: next.provider, name: next.model };
  config.agent = next.agent;
  config.launch = { ...(config.launch ?? {}) };
  if (next.launchCommand) config.launch.customCommand = next.launchCommand;
  else delete config.launch.customCommand;
  await writeConfig(projectRoot, config);

  let scaffold = null;
  if (next.agent !== before.agent) {
    // Existing files (e.g. a CLAUDE.md the user edited) are preserved.
    scaffold = await writeAgentScaffold({ projectRoot, config, overwrite: false });
    const oldFile = getInstructionsFile(before.agent);
    if (oldFile !== getInstructionsFile(next.agent)) {
      notes.push(`${oldFile} (del agent anterior) quedó en el proyecto; borralo si ya no lo usás.`);
    }
  }

  // Native CLI config follows the new settings (may also fill in an
  // automatic Ollama model, which we report back).
  try {
    const native = await syncAgentConfig(projectRoot);
    notes.push(...native.warnings);
    if (!next.model && native.modelName && (next.provider === 'ollama-cloud' || next.provider === 'ollama-local')) {
      notes.push(`Modelo elegido automáticamente: ${native.modelName}.`);
      next.model = native.modelName;
    }
  } catch (err) {
    notes.push(`No pude actualizar la config nativa del CLI: ${err.message}`);
  }

  return { before, after: next, scaffold, notes };
}
