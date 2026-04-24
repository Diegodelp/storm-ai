/**
 * `storm install` — make the `storm` command available globally.
 *
 * When storm is installed via `npm install -g @belotti/storm-ai`, this
 * command is mostly redundant — npm creates the global bin for us.
 * It exists for users who installed locally (e.g., from a cloned repo)
 * and want a shortcut without publishing.
 *
 * We do NOT copy the CLI itself anywhere. We write a small shim/shortcut
 * that always points to the current installation. That way, upgrading
 * storm doesn't leave stale copies behind.
 *
 * Platforms:
 *   - win32:   write a .cmd shim in %USERPROFILE%\bin (or create a
 *              Desktop .lnk via powershell).
 *   - darwin / linux: symlink in ~/.local/bin.
 */

import { writeFile, mkdir, symlink, unlink } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fileExists } from '../core/paths.js';

/**
 * @typedef {Object} InstallResult
 * @property {string} platform
 * @property {string[]} created          Absolute paths of files/links written.
 * @property {string[]} warnings
 * @property {string[]} nextSteps        Human-readable post-install hints.
 */

/**
 * @param {{force?: boolean}} input
 * @returns {Promise<InstallResult>}
 */
export async function install(input = {}) {
  const plat = platform();
  const binPath = resolveBinPath();

  if (plat === 'win32') return installWindows(binPath, input);
  return installUnix(binPath, input);
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

async function installWindows(binPath, { force }) {
  const created = [];
  const warnings = [];
  const nextSteps = [];

  const targetDir = path.join(homedir(), 'bin');
  await mkdir(targetDir, { recursive: true });

  const shimPath = path.join(targetDir, 'storm.cmd');
  if ((await fileExists(shimPath)) && !force) {
    warnings.push(
      `${shimPath} already exists. Pass force:true to overwrite.`,
    );
  } else {
    const shim = `@echo off\r\nnode "${binPath}" %*\r\n`;
    await writeFile(shimPath, shim, 'utf8');
    created.push(shimPath);
  }

  nextSteps.push(
    `Make sure "${targetDir}" is in your PATH. To add it permanently:`,
    `  powershell -Command "[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';${targetDir}', 'User')"`,
    `Then open a NEW terminal and run: storm`,
  );

  return { platform: 'win32', created, warnings, nextSteps };
}

// ---------------------------------------------------------------------------
// Unix (macOS, Linux)
// ---------------------------------------------------------------------------

async function installUnix(binPath, { force }) {
  const created = [];
  const warnings = [];
  const nextSteps = [];

  const targetDir = path.join(homedir(), '.local', 'bin');
  await mkdir(targetDir, { recursive: true });

  const linkPath = path.join(targetDir, 'storm');
  if (await fileExists(linkPath)) {
    if (!force) {
      warnings.push(
        `${linkPath} already exists. Pass force:true to replace.`,
      );
      return {
        platform: platform(),
        created,
        warnings,
        nextSteps: [`Nothing to do. Run \`storm\` to confirm it's on PATH.`],
      };
    }
    await unlink(linkPath);
  }

  await symlink(binPath, linkPath);
  created.push(linkPath);

  nextSteps.push(
    `Make sure "${targetDir}" is in your PATH. If not, add to your shell rc:`,
    `  export PATH="$HOME/.local/bin:$PATH"`,
    `Then reload your shell and run: storm`,
  );

  return { platform: platform(), created, warnings, nextSteps };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Locate bin/storm.js relative to THIS module (src/commands/install.js).
 * Using import.meta.url keeps us portable to both linked and installed
 * package layouts.
 */
function resolveBinPath() {
  const thisFile = fileURLToPath(import.meta.url);
  // src/commands/install.js -> ../../bin/storm.js
  return path.resolve(path.dirname(thisFile), '..', '..', 'bin', 'storm.js');
}
