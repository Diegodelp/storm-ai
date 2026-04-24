/**
 * `storm launch` — open a project by launching Claude Code with the
 * provider + model configured in project.config.json.
 *
 * Two execution modes:
 *   - Ollama (local or cloud): run `ollama launch claude --model <name>`.
 *     This is Ollama's own wrapper that sets the Anthropic-compatible
 *     endpoint and launches Claude Code in one step.
 *   - Claude API: run `claude` directly. The user's ANTHROPIC_API_KEY
 *     (if any) is inherited from the environment.
 *
 * We use inherit stdio so Claude Code takes full control of the terminal.
 * When the user exits Claude Code, control returns to storm (the wizard
 * exits, or the menu loops).
 */

import { spawn } from 'node:child_process';
import { platform } from 'node:os';

import { readConfig } from '../core/config.js';
import { requireProjectRoot } from '../core/paths.js';

/**
 * @param {{cwd:string}} input
 * @returns {Promise<{command:string, args:string[]}>}
 */
export async function launch(input) {
  const root = await requireProjectRoot(input.cwd);
  return launchForProject({ projectRoot: root });
}

/**
 * Direct variant: you already know the project root (e.g. right after
 * `createProject`). Returns after Claude Code exits.
 *
 * @param {{projectRoot:string}} input
 * @returns {Promise<void>}
 */
export async function launchForProject(input) {
  const config = await readConfig(input.projectRoot);
  const provider = config.model?.provider ?? 'claude';
  const modelName = config.model?.name ?? null;

  const { command, args } = buildCommand({ provider, modelName });

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: input.projectRoot,
      stdio: 'inherit',
      shell: platform() === 'win32', // shell=true lets Windows resolve .cmd/.bat shims
    });
    proc.on('error', (err) => reject(err));
    proc.on('exit', () => resolve());
  });
}

/**
 * Compute the shell command for a given provider/model combination.
 * Exported for testing.
 *
 * @param {{provider:string, modelName:string|null}} input
 * @returns {{command:string, args:string[]}}
 */
export function buildCommand({ provider, modelName }) {
  if (provider === 'ollama-cloud' || provider === 'ollama-local') {
    if (!modelName) {
      throw new Error(
        `Provider "${provider}" requires a model name. ` +
          `Edit project.config.json and set model.name.`,
      );
    }
    return { command: 'ollama', args: ['launch', 'claude', '--model', modelName] };
  }

  // Default: Claude API (direct).
  return { command: 'claude', args: [] };
}
