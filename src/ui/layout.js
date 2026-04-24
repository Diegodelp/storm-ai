/**
 * Layout helpers: centering, padding, and horizontal rules.
 *
 * Centering is tricky when the string contains ANSI escape codes
 * (color, bold, reset). We strip those before measuring width so
 * the visible center lines up properly.
 *
 * We intentionally do NOT depend on the `string-width` package.
 * For our use case (ASCII + half-blocks), the plain stripped length
 * equals the visible cell count, which is all we need.
 */

import process from 'node:process';
import { stripAnsi } from './ansi.js';

export function termWidth() {
  return process.stdout.columns || 100;
}

export function termHeight() {
  return process.stdout.rows || 30;
}

/** Visible cell count of a string, ignoring ANSI codes. */
export function visibleLength(s) {
  return stripAnsi(s).length;
}

/**
 * Center a single line within `width` columns by prepending spaces.
 * Strings with ANSI codes are handled correctly.
 */
export function centerLine(text, width = termWidth()) {
  const vis = visibleLength(text);
  const pad = Math.max(0, Math.floor((width - vis) / 2));
  return ' '.repeat(pad) + text;
}

/**
 * Center every line of a multi-line block. All lines get the SAME
 * left padding (computed from the widest line), which means fixed-
 * width art like our half-block logo stays perfectly aligned.
 */
export function centerBlock(text, width = termWidth()) {
  const lines = text.split('\n');
  const widest = Math.max(0, ...lines.map((l) => visibleLength(l)));
  const pad = Math.max(0, Math.floor((width - widest) / 2));
  const prefix = ' '.repeat(pad);
  return lines.map((l) => prefix + l).join('\n');
}

export function padLeft(text, spaces = 0) {
  const prefix = ' '.repeat(Math.max(0, spaces));
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}

export function horizontalRule(char = '─', width = termWidth()) {
  return char.repeat(Math.max(1, width));
}
