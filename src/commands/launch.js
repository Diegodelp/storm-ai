/**
 * `storm launch` — open the project by spawning the configured agent.
 *
 * The (provider, agent, model) tuple decides what to spawn:
 *   - Ollama + Claude Code → native settings + `claude --model <m>`
 *   - Ollama + OpenCode    → native config + `opencode --model ollama/<m>`
 *   - Claude API + Claude Code   → `claude`
 *   - Claude API + OpenCode      → `opencode`
 *
 * The user can override completely by setting `customCommand` in the
 * project's config, which we shell-split as the spawn target. Useful
 * for invoking Aider, gemini, custom scripts, etc.
 *
 * stdio:'inherit' lets the agent take full control of the terminal.
 * On exit, control returns to storm.
 */

import { spawn } from 'node:child_process';
import { platform } from 'node:os';

import { readConfig } from '../core/config.js';
import { requireProjectRoot } from '../core/paths.js';
import { buildAgentLaunchCommand } from '../core/agents.js';
import { getOllamaHost } from '../core/global-config.js';
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
  const modelName = prepared.modelName;
  const agentId = config.agent ?? 'claude-code';
  const customCommand = config.launch?.customCommand ?? null;

  const { command, args } = buildAgentLaunchCommand({
    provider,
    agentId,
    modelName,
    customCommand,
  });

  // Keep subprocesses pointed at the same host used for project analysis.
  const env = { ...process.env };
  if (provider === 'ollama-cloud' || provider === 'ollama-local') {
    env.OLLAMA_HOST = await getOllamaHost();
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: input.projectRoot,
      stdio: 'inherit',
      shell: platform() === 'win32',
      env,
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
