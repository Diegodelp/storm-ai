/**
 * Custom keyboard-driven menu picker.
 *
 * Responsive: listens to process.stdout 'resize' and re-renders the
 * entire "screen" (header + options + footer) whenever the terminal
 * changes size. The caller supplies a `repaintHeader()` that redraws
 * everything above the options (logo, instructions) and a
 * `repaintFooter()` that redraws the bottom bar. The picker itself
 * handles the options.
 *
 * Controls:
 *   ↑ / k            – move up (wraps)
 *   ↓ / j            – move down (wraps)
 *   Enter            – select
 *   Esc / q / Ctrl+C – cancel (returns null)
 *   1-9              – jump to that option and select
 */

import process from 'node:process';
import readline from 'node:readline';
import * as ansi from './ansi.js';

const HIGHLIGHT_PREFIX = '>';
const NORMAL_PREFIX = ' ';
const RESIZE_DEBOUNCE_MS = 50;

/**
 * @param {{
 *   options: Array<{value: string, label: string}>,
 *   initialIndex?: number,
 *   repaintHeader?: () => void,
 *   repaintFooter?: () => void,
 *   computeIndent?: (termWidth: number) => number,
 * }} opts
 */
export async function pick(opts) {
  const {
    options,
    initialIndex = 0,
    repaintHeader = () => {},
    repaintFooter = () => {},
    computeIndent = () => 0,
  } = opts;

  if (!Array.isArray(options) || options.length === 0) {
    throw new Error('pick(): options debe ser un array no vacío');
  }

  const stdin = process.stdin;
  const stdout = process.stdout;

  if (!stdin.isTTY) {
    return nonInteractivePick(options);
  }

  let current = Math.max(0, Math.min(initialIndex, options.length - 1));

  /**
   * Renders the full screen:
   *   1. Clear
   *   2. Header (logo + instructions)
   *   3. Blank separator
   *   4. Menu options (with current highlighted)
   *   5. Footer at bottom
   */
  function fullRedraw() {
    // Clear screen + move to top-left.
    stdout.write('\x1bc');

    // Header
    repaintHeader();

    // Menu
    const indent = computeIndent(stdout.columns || 100);
    const pad = ' '.repeat(indent);
    for (let i = 0; i < options.length; i++) {
      const isCurrent = i === current;
      const prefix = isCurrent ? ansi.cyan(HIGHLIGHT_PREFIX) : NORMAL_PREFIX;
      const label = isCurrent
        ? ansi.cyan(ansi.bold(options[i].label))
        : options[i].label;
      stdout.write(`${pad}${prefix} ${label}\n`);
    }

    // Footer
    repaintFooter();
  }

  return new Promise((resolve) => {
    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();

    stdout.write('\x1b[?25l'); // hide cursor

    // Debounced resize handler.
    let resizeTimer = null;
    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fullRedraw();
      }, RESIZE_DEBOUNCE_MS);
    };

    const cleanup = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      stdout.off('resize', onResize);
      stdout.write('\x1b[?25h'); // show cursor
      stdin.off('keypress', onKey);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    const onKey = (_str, key) => {
      if (!key) return;

      if (key.name === 'up' || key.name === 'k') {
        current = (current - 1 + options.length) % options.length;
        fullRedraw();
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        current = (current + 1) % options.length;
        fullRedraw();
        return;
      }
      if (key.name === 'return') {
        cleanup();
        resolve(options[current].value);
        return;
      }
      if (key.name === 'escape' || key.name === 'q' ||
          (key.ctrl && key.name === 'c')) {
        cleanup();
        resolve(null);
        return;
      }

      // 1-9 jump-and-select.
      const digit = parseInt(_str ?? '', 10);
      if (!Number.isNaN(digit) && digit >= 1 && digit <= options.length) {
        current = digit - 1;
        cleanup();
        resolve(options[current].value);
        return;
      }
    };

    stdin.on('keypress', onKey);
    stdout.on('resize', onResize);

    fullRedraw();
  });
}

/**
 * Non-TTY fallback.
 */
async function nonInteractivePick(options) {
  const stdout = process.stdout;
  for (let i = 0; i < options.length; i++) {
    stdout.write(`  ${i + 1}. ${options[i].label}\n`);
  }
  stdout.write('Elegí [1-' + options.length + ']: ');
  return new Promise((resolve) => {
    process.stdin.on('data', (chunk) => {
      const line = chunk.toString().split(/\r?\n/)[0];
      if (line.length === 0) return;
      const n = parseInt(line.trim(), 10);
      if (!Number.isNaN(n) && n >= 1 && n <= options.length) {
        resolve(options[n - 1].value);
      } else {
        resolve(null);
      }
    });
  });
}
