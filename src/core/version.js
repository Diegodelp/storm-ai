/**
 * Read the package version from package.json at runtime.
 *
 * Why this exists: hardcoding `const VERSION = '0.1.0'` in source files
 * means we have to remember to bump it on every release, AND the bump
 * has to land in git AND in npm publish. Forgetting any step ships the
 * wrong version string to users.
 *
 * Reading from package.json at runtime avoids all of that — `npm version`
 * updates the file, and the file is always in the published tarball
 * (it has to be, npm requires it).
 *
 * Cached in-memory after first call.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let _cached = null;

/**
 * @returns {string}  Version string like "0.2.3", or "0.0.0" if read fails.
 */
export function getVersion() {
  if (_cached !== null) return _cached;

  try {
    // package.json sits at the repo root, two levels up from src/core/.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, '..', '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw);
    _cached = typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    _cached = '0.0.0';
  }
  return _cached;
}
