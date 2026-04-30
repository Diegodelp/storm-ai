/**
 * Coding agent (CLI) catalog.
 *
 * An "agent" in storm-ai is the terminal coding assistant we hand the
 * project off to: Claude Code, OpenCode, etc. It's distinct from the
 * "provider" (who serves the model — Anthropic, Ollama cloud, Ollama
 * local). The two combine like a matrix:
 *
 *                       Ollama cloud   Ollama local   Claude API
 *   Claude Code         OK             OK             OK (default)
 *   OpenCode            OK             OK             OK
 *   <custom>            user-defined launch command
 *
 * Each agent declares:
 *   - id, label, hint     (for the wizard)
 *   - launchTemplate      template strings used to build the spawn command
 *                         for each provider it supports
 *   - install             how to install the agent on each platform
 *   - detectCommand       command we run to check if it's already installed
 *
 * If you want to add a new agent (Aider, Cursor CLI, your own thing)
 * append a new entry here. No core code needs to change.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';

const execAsync = promisify(exec);
const DETECT_TIMEOUT_MS = 5000;

/**
 * @typedef {Object} AgentLaunchPlan
 * @property {string} command   Binary to spawn (e.g. "ollama", "opencode").
 * @property {string[]} args    Argument list. Use "{{model}}" as placeholder.
 */

/**
 * @typedef {Object} AgentPreset
 * @property {string} id
 * @property {string} label
 * @property {string} hint
 * @property {string} detectCommand          Shell command to verify install.
 * @property {Record<string, AgentLaunchPlan>} launchTemplates
 *   Keys are provider ids ('ollama-cloud', 'ollama-local', 'claude').
 *   The value tells how to spawn for that provider+agent combination.
 * @property {Object} install
 * @property {string|null} install.linux    One-liner shell command (or null).
 * @property {string|null} install.darwin
 * @property {string|null} install.win32    null = manual download.
 * @property {string} install.manualUrl     Where to download for manual cases.
 */

/** @type {AgentPreset[]} */
export const AGENTS = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    hint: 'CLI oficial de Anthropic. Soporta Ollama cloud/local vía `ollama launch claude`.',
    detectCommand: 'claude --version',
    launchTemplates: {
      'ollama-cloud': { command: 'ollama', args: ['launch', 'claude', '--model', '{{model}}'] },
      'ollama-local': { command: 'ollama', args: ['launch', 'claude', '--model', '{{model}}'] },
      'claude':       { command: 'claude', args: [] },
    },
    install: {
      // Linux / macOS: official one-liner from claude.ai/install.sh.
      linux:  'curl -fsSL https://claude.ai/install.sh | bash',
      darwin: 'curl -fsSL https://claude.ai/install.sh | bash',
      // Windows: Anthropic's official PowerShell installer.
      // Equivalent of `irm https://claude.ai/install.ps1 | iex`.
      // We invoke powershell.exe directly so it runs even from non-PS terminals.
      win32:  'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass ' +
              '-Command "irm https://claude.ai/install.ps1 | iex"',
      manualUrl: 'https://claude.ai/download',
    },
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    hint: 'CLI open-source. Soporta Ollama cloud/local vía `ollama launch opencode`.',
    detectCommand: 'opencode --version',
    launchTemplates: {
      'ollama-cloud': { command: 'ollama', args: ['launch', 'opencode', '--model', '{{model}}'] },
      'ollama-local': { command: 'ollama', args: ['launch', 'opencode', '--model', '{{model}}'] },
      // OpenCode standalone reads config from ~/.config/opencode/opencode.json
      // and can use Anthropic via that config. We just spawn the binary.
      'claude':       { command: 'opencode', args: [] },
    },
    install: {
      linux:  'curl -fsSL https://opencode.ai/install | bash',
      darwin: 'curl -fsSL https://opencode.ai/install | bash',
      // OpenCode no tiene un instalador nativo Windows todavía. Caemos
      // al browser para descarga manual.
      win32:  null,
      manualUrl: 'https://opencode.ai',
    },
  },
];

/**
 * Look up an agent by id.
 * @param {string} id
 * @returns {AgentPreset|null}
 */
export function getAgent(id) {
  return AGENTS.find((a) => a.id === id) ?? null;
}

/**
 * Detect whether the agent's binary is on PATH.
 * @param {string} agentId
 * @returns {Promise<{installed: boolean, version: string|null}>}
 */
export async function detectAgent(agentId) {
  const agent = getAgent(agentId);
  if (!agent) return { installed: false, version: null };

  try {
    const { stdout } = await execAsync(agent.detectCommand, {
      timeout: DETECT_TIMEOUT_MS,
      windowsHide: true,
    });
    return { installed: true, version: stdout.trim() };
  } catch {
    return { installed: false, version: null };
  }
}

/**
 * Try to install an agent.
 * @param {string} agentId
 * @param {'linux'|'darwin'|'win32'} platform
 * @returns {Promise<{ok: boolean, message: string, manualUrl?: string}>}
 */
export async function installAgent(agentId, platform) {
  const agent = getAgent(agentId);
  if (!agent) {
    return { ok: false, message: `Agent desconocido: ${agentId}` };
  }

  const cmd = agent.install[platform];
  if (!cmd) {
    return {
      ok: false,
      message:
        `La instalación automática de ${agent.label} no está soportada en ${platform}.\n` +
        `Descargalo desde: ${agent.install.manualUrl}\n` +
        'Después reiniciá la terminal y volvé a probar.',
      manualUrl: agent.install.manualUrl,
    };
  }

  return runInstaller(cmd);
}

/**
 * Build the spawn command for a (provider, agent, model) combination.
 *
 * @param {{provider: string, agentId?: string, modelName: string|null, customCommand?: string}} input
 * @returns {{command: string, args: string[]}}
 *
 * If `customCommand` is set (a single string from user config), we
 * shell-split it and use as-is. Useful for users who want to invoke
 * something we don't know about (Aider, gemini, etc).
 */
export function buildAgentLaunchCommand({ provider, agentId = 'claude-code', modelName, customCommand }) {
  if (customCommand) {
    return parseShellCommand(substituteModel(customCommand, modelName));
  }

  const agent = getAgent(agentId);
  if (!agent) {
    throw new Error(`Agent desconocido: ${agentId}. Configurá uno con \`storm config\`.`);
  }

  const tmpl = agent.launchTemplates[provider];
  if (!tmpl) {
    throw new Error(
      `${agent.label} no tiene un launch template para provider "${provider}". ` +
      `Combinaciones soportadas: ${Object.keys(agent.launchTemplates).join(', ')}.`,
    );
  }

  // For Ollama-based providers, model is required. For 'claude' direct, optional.
  if ((provider === 'ollama-cloud' || provider === 'ollama-local') && !modelName) {
    throw new Error(
      `Provider "${provider}" + agent "${agentId}" requiere un model name. ` +
      'Editá project.config.json y completá model.name, o corré `storm config`.',
    );
  }

  const args = tmpl.args.map((a) => substituteModel(a, modelName));
  return { command: tmpl.command, args };
}

function substituteModel(s, modelName) {
  return String(s).replaceAll('{{model}}', modelName ?? '');
}

/**
 * Tiny shell-style argv splitter. Honors single and double quotes.
 * NOT a full shell parser (no env vars, no globbing, no pipes).
 *
 * @param {string} cmd
 * @returns {{command: string, args: string[]}}
 */
function parseShellCommand(cmd) {
  /** @type {string[]} */
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (cur) { parts.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  if (parts.length === 0) {
    throw new Error('customCommand vacío.');
  }
  return { command: parts[0], args: parts.slice(1) };
}

function runInstaller(shellCommand) {
  return new Promise((resolve) => {
    const proc = spawn(shellCommand, {
      stdio: 'inherit',
      shell: true,
      windowsHide: true,
    });
    proc.on('exit', (code) => {
      if (code === 0) resolve({ ok: true, message: 'Instalación completa.' });
      else resolve({ ok: false, message: `Instalador terminó con código ${code}.` });
    });
    proc.on('error', (err) => {
      resolve({ ok: false, message: err.message });
    });
  });
}
