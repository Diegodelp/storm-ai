/**
 * `storm launch` — open the project by spawning the configured agent.
 *
 * Everything comes from the PROJECT's project.config.json (`model`,
 * `agent`, `launch.customCommand`). The global config (~/.storm-ai) only
 * provides defaults when a project is created, plus two fallbacks:
 *   - `defaultLaunchCommand` for agents storm doesn't know (custom ones)
 *     when the project has no command of its own.
 *   - `ollamaHost`, exported as OLLAMA_HOST for Ollama providers (the
 *     OLLAMA_HOST env var wins over it).
 *
 * The (provider, agent, model) tuple decides what to spawn:
 *   - Ollama + Claude Code → native settings + `claude --model <m>`
 *   - Ollama + OpenCode    → native config + `opencode --model ollama/<m>`
 *   - Claude API + Claude Code   → `claude`
 *   - Claude API + OpenCode      → `opencode`
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
import { getOllamaHost, readGlobalConfig } from '../core/global-config.js';
import { syncAgentConfig } from '../core/agent-config.js';

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
 *   modelName?: string|null,   Resolved model (defaults to config.model.name).
 *   ollamaHost?: string,       Resolved host for Ollama providers.
 * }} input
 * @returns {{command: string, args: string[], env: Record<string,string>, agentId: string, provider: string, modelName: string|null}}
 */
export function resolveLaunch({ config, globalConfig = {}, modelName, ollamaHost }) {
  const provider = config.model?.provider ?? 'claude';
  const model = modelName === undefined ? config.model?.name ?? null : modelName;
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
    modelName: model,
    customCommand,
  });

  /** @type {Record<string,string>} */
  const env = {};
  if (ollamaHost && (provider === 'ollama-cloud' || provider === 'ollama-local')) {
    env.OLLAMA_HOST = ollamaHost;
  }

  return { command, args, env, agentId, provider, modelName: model };
}

/**
 * Direct variant: caller already knows the project root.
 *
 * @param {{projectRoot: string}} input
 * @returns {Promise<void>}
 */
export async function launchForProject(input) {
  const prepared = await syncAgentConfig(input.projectRoot, { strict: true });
  for (const warning of prepared.warnings) console.warn(warning);
  const config = await readConfig(input.projectRoot);
  const provider = config.model?.provider ?? 'claude';
  // Keep subprocesses pointed at the same host used for project analysis.
  const ollamaHost = provider === 'ollama-cloud' || provider === 'ollama-local'
    ? await getOllamaHost()
    : undefined;

  const { command, args, env } = resolveLaunch({
    config,
    globalConfig: await readGlobalConfig(),
    modelName: prepared.modelName,
    ollamaHost,
  });

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: input.projectRoot,
      stdio: 'inherit',
      shell: platform() === 'win32',
      env: { ...process.env, ...env },
    });
    proc.on('error', (err) => {
      const detail = err.code === 'ENOENT'
        ? `No se encontró \`${command}\`. Verificá que esté instalado y disponible en PATH; podés instalar el CLI desde \`storm config\`.`
        : `No se pudo ejecutar \`${command}\`: ${err.message}`;
      reject(new Error(`${detail}\nProyecto: ${input.projectRoot}`, { cause: err }));
    });
    proc.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `\`${command}\` terminó con ${signal ? `señal ${signal}` : `código ${code}`}.\n` +
          `Proyecto: ${input.projectRoot}\nRevisá el mensaje del CLI que aparece arriba.`,
      ));
    });
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
