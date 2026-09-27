/**
 * Logo renderer.
 *
 * Two modes:
 *
 *   1. Half-block mode (preferred). Draws the precomputed pixels in
 *      src/assets/logo-pixels.js (assets/logo.png auto-cropped and
 *      resized by `npm run build:logo`), one terminal row per pair of
 *      pixel rows using '▀' (U+2580): foreground = top pixel,
 *      background = bottom pixel. Needs a 24-bit color terminal, and no
 *      image library at runtime.
 *
 *   2. ASCII fallback, if the pixel data can't be decoded.
 */

import * as ansi from './ansi.js';
import { getVersion } from '../core/version.js';
import { LOGO_COLS, LOGO_PIXEL_ROWS, LOGO_RGB_BASE64 } from '../assets/logo-pixels.js';

/** Width in terminal columns (80 fits the default terminal width). */
const TARGET_COLS = LOGO_COLS;

/** Brightness threshold (sum of RGB 0..765) below which we treat a
 *  pixel as background — skips emitting ANSI for "blank" cells.
 *  Set conservatively high (60) to catch near-black pixels with
 *  tint from JPEG-like compression noise. */
const BG_THRESHOLD = 60;

let cachedLogo = null;

/**
 * Main entry. Returns a multi-line string ready to print.
 * Async for API compatibility with earlier versions.
 *
 * @returns {Promise<string>}
 */
export async function renderLogo() {
  if (cachedLogo !== null) return cachedLogo;

  try {
    cachedLogo = await renderHalfBlocks();
    return cachedLogo;
  } catch (err) {
    if (process.env.STORM_DEBUG) {
      process.stderr.write(`[storm] half-block fallback: ${err?.message ?? err}\n`);
      if (err?.stack) process.stderr.write(err.stack + '\n');
    } else {
      process.stderr.write(
        `[storm] Logo ASCII (logo no renderizable: ${err?.message ?? err})\n`,
      );
    }
  }

  cachedLogo = renderAsciiFallback();
  return cachedLogo;
}

/**
 * Renders the STORM footer line ("STORM CLI  v0.2.3  |  https://...").
 *
 * If no `version` is passed in, reads it from package.json at runtime
 * via getVersion(). The repo URL also has a sane default.
 */
export function renderFooter({
  version,
  url = 'https://github.com/Diegodelp/storm-ai',
} = {}) {
  const v = version ?? getVersion();
  const left = `${ansi.cyan('STORM CLI')}  ${ansi.dim('v' + v)}`;
  const right = ansi.violet(url);
  return `${left}  ${ansi.dim('|')}  ${right}`;
}

// ---------------------------------------------------------------------------
// Half-block implementation
// ---------------------------------------------------------------------------

async function renderHalfBlocks() {
  const resized = Buffer.from(LOGO_RGB_BASE64, 'base64');
  const rows = LOGO_PIXEL_ROWS / 2;
  if (resized.length !== TARGET_COLS * LOGO_PIXEL_ROWS * 3) {
    throw new Error(`logo-pixels.js inválido (${resized.length} bytes)`);
  }

  // Emit half-blocks.
  const lines = [];
  for (let ry = 0; ry < rows; ry++) {
    let line = '';
    for (let cx = 0; cx < TARGET_COLS; cx++) {
      const topIdx = (ry * 2 * TARGET_COLS + cx) * 3;
      const botIdx = ((ry * 2 + 1) * TARGET_COLS + cx) * 3;
      const tr = resized[topIdx],     tg = resized[topIdx + 1],     tb = resized[topIdx + 2];
      const br = resized[botIdx],     bg = resized[botIdx + 1],     bb = resized[botIdx + 2];

      if (tr + tg + tb < BG_THRESHOLD && br + bg + bb < BG_THRESHOLD) {
        line += ' ';
      } else {
        line += `\x1b[38;2;${tr};${tg};${tb}m\x1b[48;2;${br};${bg};${bb}m\u2580\x1b[0m`;
      }
    }
    // Trim trailing blanks so the line doesn't paint empty columns
    // beyond the logo's visible content.
    lines.push(line.replace(/ +$/, ''));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// ASCII fallback
// ---------------------------------------------------------------------------

const ASCII_LINES = [
  '███████╗████████╗ ██████╗ ██████╗ ███╗   ███╗',
  '██╔════╝╚══██╔══╝██╔═══██╗██╔══██╗████╗ ████║',
  '███████╗   ██║   ██║ ▲ ██║██████╔╝██╔████╔██║',
  '╚════██║   ██║   ██║ ▼ ██║██╔══██╗██║╚██╔╝██║',
  '███████║   ██║   ╚██████╔╝██║  ██║██║ ╚═╝ ██║',
  '╚══════╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝',
];

function renderAsciiFallback() {
  try {
    if (typeof ansi.gradientLine === 'function') {
      return ASCII_LINES.map((line) => ansi.gradientLine(line, ASCII_LINES[0].length)).join('\n');
    }
  } catch {
    // fall through
  }
  return ASCII_LINES.join('\n');
}

/** Rendered visual width of the half-block logo, in terminal columns. */
export const LOGO_WIDTH = TARGET_COLS;
