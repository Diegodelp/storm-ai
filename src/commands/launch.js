/**
 * `storm launch` — open the project by spawning the configured agent.
 *
 * The (provider, agent, model) tuple decides what to spawn:
 *   - Ollama cloud + Claude Code → `ollama launch claude --model <m>`
 *   - Ollama cloud + OpenCode    → `ollama launch opencode --model <m>`
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
  const config = await readConfig(input.projectRoot);
  const provider = config.model?.provider ?? 'claude';
  const modelName = config.model?.name ?? null;
  const agentId = config.agent ?? 'claude-code';
  const customCommand = config.launch?.customCommand ?? null;

  const { command, args } = buildAgentLaunchCommand({
    provider,
    agentId,
    modelName,
    customCommand,
  });

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: input.projectRoot,
      stdio: 'inherit',
      shell: platform() === 'win32',
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
