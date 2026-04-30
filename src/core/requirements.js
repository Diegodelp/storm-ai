/**
 * Detection and (best-effort) installation of system requirements:
 * git and node.
 *
 * Storm itself runs on Node, so if `node` isn't on PATH the user
 * couldn't have invoked us — but we still check because the user might
 * be inside a separate sub-shell or weird env. Mostly we report it.
 *
 * Git is genuinely optional for `storm new` but REQUIRED for
 * `storm new --template <id>` (which clones a template repo). We also
 * check it during first-run.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';

const execAsync = promisify(exec);
const TIMEOUT_MS = 5000;

/**
 * @typedef {Object} ToolStatus
 * @property {boolean} installed
 * @property {string|null} version
 */

/** @returns {Promise<ToolStatus>} */
export async function detectGit() {
  return runVersionCommand('git --version');
}

/** @returns {Promise<ToolStatus>} */
export async function detectNode() {
  return runVersionCommand('node --version');
}

/** @returns {Promise<ToolStatus>} */
export async function detectNpm() {
  return runVersionCommand('npm --version');
}

async function runVersionCommand(cmd) {
  try {
    const { stdout } = await execAsync(cmd, {
      timeout: TIMEOUT_MS,
      windowsHide: true,
    });
    return { installed: true, version: stdout.trim() };
  } catch {
    return { installed: false, version: null };
  }
}

/**
 * Try to install git via the platform's package manager.
 * On Windows we cannot do this silently — point the user to the official installer.
 *
 * @param {'darwin'|'linux'|'win32'} platform
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function installGit(platform) {
  if (platform === 'win32') {
    // Try winget first (preinstalled on Windows 10 1809+ and Windows 11).
    // The user might still get a UAC prompt for elevation.
    try {
      await execAsync('winget --version', { timeout: TIMEOUT_MS, windowsHide: true });
    } catch {
      return {
        ok: false,
        message:
          'En Windows necesitás `winget` (incluido por defecto en Win10 1809+ / Win11), ' +
          'o instalá Git manualmente desde https://git-scm.com/download/win\n' +
          'Después de instalarlo, reiniciá la terminal.',
        manualUrl: 'https://git-scm.com/download/win',
      };
    }
    return runInstaller([
      'winget',
      ['install', '--id', 'Git.Git', '-e', '--accept-source-agreements', '--accept-package-agreements'],
    ]);
  }

  if (platform === 'darwin') {
    // Most Macs have Xcode CLT preinstalled, which includes git.
    // If brew is available, use it. Otherwise tell the user.
    try {
      await execAsync('which brew', { timeout: TIMEOUT_MS, windowsHide: true });
    } catch {
      return {
        ok: false,
        message:
          'Necesitás Homebrew para instalar git automáticamente, o instalá Xcode Command Line Tools:\n' +
          '  xcode-select --install\n' +
          'Después de instalarlo, reiniciá la terminal.',
      };
    }
    return runInstaller(['brew', ['install', 'git']]);
  }

  // Linux: detect package manager.
  const candidates = [
    { check: 'which apt-get', cmd: ['sudo', ['apt-get', 'install', '-y', 'git']] },
    { check: 'which dnf',     cmd: ['sudo', ['dnf', 'install', '-y', 'git']] },
    { check: 'which yum',     cmd: ['sudo', ['yum', 'install', '-y', 'git']] },
    { check: 'which pacman',  cmd: ['sudo', ['pacman', '-S', '--noconfirm', 'git']] },
    { check: 'which apk',     cmd: ['sudo', ['apk', 'add', 'git']] },
  ];

  for (const c of candidates) {
    try {
      await execAsync(c.check, { timeout: TIMEOUT_MS, windowsHide: true });
      return runInstaller(c.cmd);
    } catch {
      // try next
    }
  }

  return {
    ok: false,
    message:
      'No encontré un package manager conocido (apt, dnf, yum, pacman, apk). ' +
      'Instalá git manualmente desde https://git-scm.com/download',
  };
}

/**
 * Show npm/node install hint. Storm itself requires node — this is for
 * users who somehow ended up with broken node. Mostly a redirect.
 *
 * @param {'darwin'|'linux'|'win32'} platform
 * @returns {{ok: boolean, message: string}}
 */
export function installNodeHint(platform) {
  if (platform === 'win32') {
    return {
      ok: false,
      message:
        'Descargá Node.js (LTS) desde https://nodejs.org/. Incluye npm.\n' +
        'Después de instalar, reiniciá la terminal.',
    };
  }
  return {
    ok: false,
    message:
      'Recomiendo instalar Node con nvm:\n' +
      '  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash\n' +
      '  nvm install --lts\n' +
      'O bajalo directo de https://nodejs.org/.',
  };
}

/**
 * Run an installer command, streaming output to the user's terminal.
 *
 * @param {[string, string[]]} cmd  [command, args]
 * @returns {Promise<{ok: boolean, message: string}>}
 */
function runInstaller([command, args]) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { stdio: 'inherit', windowsHide: true });
    proc.on('exit', (code) => {
      if (code === 0) resolve({ ok: true, message: 'Instalación completa.' });
      else resolve({ ok: false, message: `${command} terminó con código ${code}.` });
    });
    proc.on('error', (err) => {
      resolve({ ok: false, message: err.message });
    });
  });
}
