/**
 * `storm launch` — open the project by spawning the configured agent.
 *
 * Everything comes from the PROJECT's project.config.json (`model`,
 * `agent`, `launch.customCommand`). The global config (~/.storm-ai) only
 * provides defaults when a project is created, plus two fallbacks:
 *   - `defaultLaunchCommand` for agents storm doesn't know (custom ones)
 *     when the project has no command of its own.
 *   - `ollamaHost`, exported as OLLAMA_HOST for `ollama launch` unless
 *     the env var is already set.
 *
 * The (provider, agent, model) tuple decides what to spawn:
 *   - Ollama cloud/local + Claude Code → `ollama launch claude --model <m>`
 *   - Ollama cloud/local + OpenCode    → `ollama launch opencode --model <m>`
 *   - Claude API / via-claude-code + Claude Code → `claude`
 *   - Claude API / via-opencode    + OpenCode    → `opencode`
 *
 * stdio:'inherit' lets the agent take full control of the terminal.
 * On exit, control returns to storm.
 */

import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import process from 'node:process';

import { readConfig } from '../core/config.js';
import { requireProjectRoot } from '../core/paths.js';
import { buildAgentLaunchCommand, getAgent } from '../core/agents.js';
import { readGlobalConfig } from '../core/global-config.js';

/**
 * @param {{cwd: string}} input
 * @returns {Promise<void>}
 */
export async function launch(input) {
  const root = await requireProjectRoot(input.cwd);
  return launchForProject({ projectRoot: root });
}

/**
 * Decide what to spawn for a project. Pure: no I/O, easy to test.
 *
 * @param {{
 *   config: import('../core/config.js').ProjectConfig,
 *   globalConfig?: import('../core/global-config.js').GlobalConfig,
 *   env?: Record<string, string|undefined>,
 * }} input
 * @returns {{command: string, args: string[], env: Record<string,string>, agentId: string, provider: string, modelName: string|null}}
 */
export function resolveLaunch({ config, globalConfig = {}, env = process.env }) {
  const provider = config.model?.provider ?? 'claude';
  const modelName = config.model?.name ?? null;
  const agentId = config.agent ?? 'claude-code';

  // Project command wins. For an agent storm doesn't know, fall back to
  // the global command so custom agents configured via `storm config`
  // keep working in projects that predate the per-project setting.
  let customCommand = config.launch?.customCommand || null;
  if (!customCommand && !getAgent(agentId)) {
    customCommand = globalConfig.defaultLaunchCommand || null;
  }

  const { command, args } = buildAgentLaunchCommand({
    provider,
    agentId,
    modelName,
    customCommand,
  });

  /** @type {Record<string,string>} */
  const extraEnv = {};
  if (!env.OLLAMA_HOST && globalConfig.ollamaHost &&
      (provider === 'ollama-cloud' || provider === 'ollama-local')) {
    extraEnv.OLLAMA_HOST = globalConfig.ollamaHost;
  }

  return { command, args, env: extraEnv, agentId, provider, modelName };
}

/**
 * Direct variant: caller already knows the project root.
 *
 * @param {{projectRoot: string}} input
 * @returns {Promise<void>}
 */
export async function launchForProject(input) {
  const config = await readConfig(input.projectRoot);
  const globalConfig = await readGlobalConfig();
  const { command, args, env } = resolveLaunch({ config, globalConfig });

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: input.projectRoot,
      stdio: 'inherit',
      shell: platform() === 'win32',
      env: { ...process.env, ...env },
    });
    proc.on('error', (err) => reject(err));
    proc.on('exit', () => resolve());
  });
}

/**
 * Re-export buildAgentLaunchCommand under the legacy name `buildCommand`
 * for any external code that still imports it.
 *
 * @param {{provider: string, modelName: string|null}} input
 * @returns {{command: string, args: string[]}}
 */
export function buildCommand({ provider, modelName }) {
  return buildAgentLaunchCommand({
    provider,
    agentId: 'claude-code',
    modelName,
  });
}
