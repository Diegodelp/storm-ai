/**
 * Tiny ANSI helpers.
 *
 * We don't use chalk or picocolors because we only need a few codes and
 * our gradient logo requires raw RGB anyway. Keeping this dep-free means
 * one less thing to break on Windows.
 *
 * Color support detection: we honor NO_COLOR (universal standard) and
 * assume terminals support RGB otherwise. Node 20+ on Windows Terminal,
 * VS Code terminal, iTerm2, and any modern Linux terminal all support it.
 */

import process from 'node:process';

const SUPPORTS_COLOR = !process.env.NO_COLOR && !process.env.STORM_NO_COLOR;

const ESC = '\x1b[';

function code(seq) {
  return SUPPORTS_COLOR ? ESC + seq : '';
}

function wrap(open, close, text) {
  return code(open) + text + code(close);
}

export const reset = code('0m');
export const bold = (t) => wrap('1m', '0m', t);
export const dim = (t) => wrap('2m', '0m', t);
export const italic = (t) => wrap('3m', '0m', t);
export const underline = (t) => wrap('4m', '0m', t);

export const red     = (t) => wrap('38;2;239;91;91m',  '0m', t);
export const green   = (t) => wrap('38;2;110;206;120m', '0m', t);
export const yellow  = (t) => wrap('38;2;244;192;82m',  '0m', t);
export const cyan    = (t) => wrap('38;2;110;180;255m', '0m', t);
export const magenta = (t) => wrap('38;2;181;120;255m', '0m', t);
export const violet  = magenta;

/**
 * RGB foreground. Returns a raw-code prefix; caller must reset after.
 * Use the wrap-style helpers above when possible.
 */
export function rgb(r, g, b) {
  return code(`38;2;${r};${g};${b}m`);
}

/**
 * Interpolate across the STORM brand gradient:
 * cyan → blue-violet → violet → pink → warm orange.
 */
export function gradientColor(t) {
  const stops = [
    [58, 182, 255],
    [110, 146, 255],
    [181, 120, 255],
    [232, 125, 196],
    [255, 187, 145],
  ];
  if (t <= 0) return stops[0];
  if (t >= 1) return stops[stops.length - 1];
  const seg = t * (stops.length - 1);
  const i = Math.floor(seg);
  const f = seg - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/**
 * Apply the gradient across a single line, coloring each non-space char
 * according to its horizontal position.
 */
export function gradientLine(line, totalWidth) {
  if (!SUPPORTS_COLOR) return line;
  const width = Math.max(2, totalWidth);
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ' ') {
      out += ' ';
      continue;
    }
    const t = i / (width - 1);
    const [r, g, b] = gradientColor(t);
    out += `${ESC}38;2;${r};${g};${b}m${ch}`;
  }
  return out + reset;
}

/**
 * Strip ANSI escape sequences so we can measure visible width.
 */
export function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

export function visibleLength(s) {
  return stripAnsi(s).length;
}

export function centerLine(text, width) {
  const vis = visibleLength(text);
  if (vis >= width) return text;
  return ' '.repeat(Math.floor((width - vis) / 2)) + text;
}
