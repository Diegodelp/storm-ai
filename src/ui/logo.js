/**
 * Logo renderer.
 *
 * Two modes:
 *
 *   1. Half-block mode (preferred). Loads src/assets/logo.png, auto-crops
 *      black borders, resizes to TARGET_COLS × (rows * 2) pixels, and
 *      emits one terminal row per pair of source pixels using '▀'
 *      (U+2580): foreground = top pixel, background = bottom pixel.
 *      Result: near pixel-perfect rendition of the PNG in any terminal
 *      that supports 24-bit ANSI color.
 *
 *   2. ASCII fallback. If sharp fails to load or the PNG is missing,
 *      fall back to a hardcoded block-style STORM logo.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as ansi from './ansi.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOGO_PNG = path.resolve(__dirname, '../assets/logo.png');

/** Target width in terminal columns. 80 is a good balance: narrow
 *  enough to fit in standard terminals (80-col default), wide enough
 *  to resolve the S segments and the lightning bolt clearly. */
const TARGET_COLS = 80;

/** Brightness threshold (sum of RGB 0..765) below which we treat a
 *  pixel as background — skips emitting ANSI for "blank" cells.
 *  Set conservatively high (60) to catch near-black pixels with
 *  tint from JPEG-like compression noise. */
const BG_THRESHOLD = 60;

/** Brightness threshold for the auto-crop of black borders. */
const CROP_THRESHOLD = 90;

let cachedLogo = null;

/**
 * Main entry. Returns a multi-line string ready to print.
 * Async because sharp's API is async.
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
        `[storm] Logo ASCII (logo.png no renderizable: ${err?.message ?? err})\n`,
      );
    }
  }

  cachedLogo = renderAsciiFallback();
  return cachedLogo;
}

/**
 * Renders the STORM footer line ("STORM CLI  v0.1.0  |  https://...").
 */
export function renderFooter({ version = '0.1.0', url = 'https://github.com/diegobelotti/storm-ai' } = {}) {
  const left = `${ansi.cyan('STORM CLI')}  ${ansi.dim('v' + version)}`;
  const right = ansi.violet(url);
  return `${left}  ${ansi.dim('|')}  ${right}`;
}

// ---------------------------------------------------------------------------
// Half-block implementation
// ---------------------------------------------------------------------------

async function renderHalfBlocks() {
  // Dynamic import so missing `sharp` throws inside the try/catch.
  const sharpModule = await import('sharp');
  const sharp = sharpModule.default ?? sharpModule;

  const buf = readFileSync(LOGO_PNG);

  // IMPORTANT: sharp pipelines are single-use. Each operation below
  // creates a fresh sharp() instance from the original buffer. Reusing
  // a pipeline after metadata()/toBuffer() returns corrupted data.

  // 1. Source dimensions.
  const meta = await sharp(buf).metadata();
  if (!meta.width || !meta.height) {
    throw new Error(`logo.png metadata inválida: ${JSON.stringify(meta)}`);
  }

  // 2. Read full image as raw RGB to compute the crop box.
  const rawFull = await sharp(buf).removeAlpha().raw().toBuffer();
  const expectedLen = meta.width * meta.height * 3;
  if (rawFull.length < expectedLen) {
    throw new Error(
      `Buffer raw más chico de lo esperado: ${rawFull.length} < ${expectedLen}`,
    );
  }

  const crop = findCropBox(rawFull, meta.width, meta.height, CROP_THRESHOLD);
  const cropW = crop.right - crop.left;
  const cropH = crop.bottom - crop.top;
  if (cropW <= 0 || cropH <= 0) {
    throw new Error(`Auto-crop devolvió región vacía (${cropW}x${cropH})`);
  }

  // 3. Extract + resize in a fresh pipeline.
  const aspect = cropH / cropW;
  const rows = Math.max(1, Math.round((TARGET_COLS * aspect) / 2));

  const resized = await sharp(buf)
    .removeAlpha()
    .extract({ left: crop.left, top: crop.top, width: cropW, height: cropH })
    .resize(TARGET_COLS, rows * 2, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer();

  // 4. Emit half-blocks.
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

function findCropBox(buf, w, h, threshold) {
  const idx = (x, y) => (y * w + x) * 3;
  const bright = (x, y) => {
    const i = idx(x, y);
    return buf[i] + buf[i + 1] + buf[i + 2];
  };

  let top = 0;
  outerT: for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (bright(x, y) > threshold) { top = y; break outerT; }
    }
  }
  let bottom = h;
  outerB: for (let y = h - 1; y >= 0; y--) {
    for (let x = 0; x < w; x++) {
      if (bright(x, y) > threshold) { bottom = y + 1; break outerB; }
    }
  }
  let left = 0;
  outerL: for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      if (bright(x, y) > threshold) { left = x; break outerL; }
    }
  }
  let right = w;
  outerR: for (let x = w - 1; x >= 0; x--) {
    for (let y = 0; y < h; y++) {
      if (bright(x, y) > threshold) { right = x + 1; break outerR; }
    }
  }
  return { left, top, right, bottom };
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
