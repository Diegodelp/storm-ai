/**
 * Cross-platform helper to open a URL in the user's default browser.
 *
 * Why this exists: storm sometimes needs to send the user to a download
 * page (Ollama on Windows, git on Windows, OpenCode on Windows, etc).
 * Telling the user "go to https://..." and waiting for them to copy the
 * link is friction. Opening the browser automatically is one less step.
 *
 * Best-effort: if it fails for any reason (no GUI, sandbox, etc) we
 * return false so the caller can fall back to printing the link.
 */

import { spawn } from 'node:child_process';
import { platform } from 'node:os';

/**
 * @param {string} url
 * @returns {Promise<boolean>}  true if the open command was spawned cleanly.
 */
export async function openInBrowser(url) {
  const plat = platform();
  return new Promise((resolve) => {
    let cmd, args;
    if (plat === 'win32') {
      // `start` is a cmd.exe builtin, not a binary.
      // The first "" is the (empty) window title — `start` requires it
      // when the next argument might contain quotes/spaces.
      cmd = 'cmd';
      args = ['/c', 'start', '""', url];
    } else if (plat === 'darwin') {
      cmd = 'open';
      args = [url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    try {
      const proc = spawn(cmd, args, {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      });
      proc.on('error', () => resolve(false));
      proc.unref();
      // Wait briefly to detect spawn errors.
      setTimeout(() => resolve(true), 200);
    } catch {
      resolve(false);
    }
  });
}
