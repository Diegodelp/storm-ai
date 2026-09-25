import process from 'node:process';
import readline from 'node:readline';
import * as clack from '@clack/prompts';

/** Leave results visible until the user acknowledges them; never block scripts. */
export function waitForMenu({ input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY || input.destroyed || input.readableEnded) return Promise.resolve(false);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output, terminal: true });
    let accepted = false;
    rl.once('close', () => resolve(accepted));
    rl.once('SIGINT', () => rl.close());
    rl.question('\nPresioná Enter para volver al menú (Ctrl+C para salir). ', () => {
      accepted = true;
      rl.close();
    });
  });
}

/** Centralize errors and acknowledgement before the picker clears the screen. */
export async function runMenuAction(action, {
  reportError = (message) => clack.log.error(message),
  pause = waitForMenu,
} = {}) {
  let result;
  try {
    result = await action();
  } catch (err) {
    reportError(err?.message ?? String(err));
    if (process.env.STORM_DEBUG && err?.stack) console.error(err.stack);
  }
  if (result === 'cancelled') return true;
  return pause();
}
