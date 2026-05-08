/**
 * Atomic file writes with a simple in-process lock.
 *
 * Why both:
 *
 *   1. **Atomic write** (write tmp + rename). On all major OSes, `rename()`
 *      within the same filesystem is atomic at the syscall level. So a
 *      reader that opens the destination either sees the OLD complete file
 *      or the NEW complete file — never a half-written one. Plain
 *      `writeFile()` truncates first, then writes; if the process crashes
 *      between those two, the file is corrupt.
 *
 *   2. **Lock**. Two storm subprocesses launched by an agent in parallel
 *      could each call atomicWriteJson(). Atomic writes alone serialize
 *      what each write *looks like* but not the read-modify-write cycle:
 *      both could read v1, both modify, the second's write wins, the
 *      first's edit is lost. A lock ensures the read+write+rename happens
 *      as a unit.
 *
 *      We use an in-process Map keyed by the absolute file path. This
 *      handles concurrency *within one Node process*. For cross-process
 *      concurrency (one storm CLI invocation racing another), see the
 *      file-based lock below.
 *
 *   3. **Cross-process file lock**. We create `<file>.lock` with O_EXCL.
 *      If it exists, we wait and retry. If we can't acquire after a
 *      timeout, we throw with a clear message. The lock is cleaned up
 *      always (even on errors) via `finally`.
 *
 * Trade-off accepted: this is best-effort. A killed storm process can
 * leave a stale `.lock` file. We mitigate by checking the lock's mtime —
 * if it's older than LOCK_STALE_MS, we forcibly remove it.
 */

import { writeFile, rename, unlink, stat, open } from 'node:fs/promises';
import path from 'node:path';

const LOCK_STALE_MS = 30_000;        // 30s — anything older is presumed dead
const LOCK_RETRY_MS = 50;            // poll interval while waiting
const LOCK_TIMEOUT_MS = 10_000;      // give up after 10s

/** In-process lock: Map<absPath, Promise<void>> for currently-held locks. */
const inProcessLocks = new Map();

/**
 * Acquire both an in-process queue slot AND a cross-process .lock file.
 * Returns a release function. ALWAYS call release() in a finally block.
 *
 * @param {string} absPath
 * @returns {Promise<() => Promise<void>>}
 */
async function acquireLock(absPath) {
  // 1. In-process: chain onto any existing lock for this path.
  const prev = inProcessLocks.get(absPath) ?? Promise.resolve();
  let releaseInProc;
  const myTurn = new Promise((resolve) => { releaseInProc = resolve; });
  inProcessLocks.set(absPath, prev.then(() => myTurn));
  await prev;

  // 2. Cross-process: try to create <file>.lock exclusively.
  const lockPath = absPath + '.lock';
  const start = Date.now();
  let acquired = false;
  while (!acquired) {
    try {
      const fh = await open(lockPath, 'wx');  // O_CREAT | O_EXCL
      await fh.close();
      acquired = true;
    } catch (err) {
      if (err.code !== 'EEXIST') {
        // Couldn't even attempt creation. Free the in-process slot and bail.
        if (inProcessLocks.get(absPath) === myTurn) inProcessLocks.delete(absPath);
        releaseInProc();
        throw err;
      }
      // Lock exists. Check if it's stale.
      try {
        const s = await stat(lockPath);
        if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
          // Stale — assume the holder died and steal it.
          await unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        // .lock disappeared between EEXIST and stat — try again immediately.
        continue;
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        if (inProcessLocks.get(absPath) === myTurn) inProcessLocks.delete(absPath);
        releaseInProc();
        throw new Error(
          `Timeout esperando lock en ${absPath}. ` +
          `Si estás seguro de que ningún otro storm está corriendo, ` +
          `borrá ${lockPath} a mano.`,
        );
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }

  return async () => {
    // Release cross-process first, then in-process.
    await unlink(lockPath).catch(() => {});
    if (inProcessLocks.get(absPath) === myTurn) inProcessLocks.delete(absPath);
    releaseInProc();
  };
}

/**
 * Atomically write a string to `absPath`.
 *
 * The write is "atomic" in the sense that any concurrent reader either
 * sees the OLD file content or the NEW file content, never a partial
 * write. It is NOT atomic across processes without a lock — if you need
 * read-modify-write semantics, see `atomicUpdateJson`.
 *
 * @param {string} absPath
 * @param {string} content
 */
export async function atomicWrite(absPath, content) {
  const tmpPath = `${absPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(tmpPath, content, 'utf8');
    await rename(tmpPath, absPath);
  } catch (err) {
    // Clean up the tmp file if the rename failed.
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Atomically read-modify-write JSON, holding an exclusive lock for the
 * full read+write cycle. Use this when you can't afford a lost-update
 * race.
 *
 * @template T
 * @param {string} absPath
 * @param {(data: T | null) => Promise<T> | T} mutator
 *   Called with parsed JSON (or null if file doesn't exist). Must return
 *   the new state.
 * @returns {Promise<T>}
 */
export async function atomicUpdateJson(absPath, mutator) {
  const release = await acquireLock(absPath);
  try {
    let current = null;
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(absPath, 'utf8');
      current = JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // File doesn't exist yet — that's fine, mutator gets null.
    }
    const next = await mutator(current);
    await atomicWrite(absPath, JSON.stringify(next, null, 2) + '\n');
    return next;
  } finally {
    await release();
  }
}

/**
 * Atomically write JSON without the read step. Still locks to serialize
 * concurrent writers but doesn't preserve their changes — last write wins.
 * Use when the caller already has the full new state and doesn't care
 * about merging.
 *
 * @param {string} absPath
 * @param {unknown} data
 */
export async function atomicWriteJson(absPath, data) {
  const release = await acquireLock(absPath);
  try {
    await atomicWrite(absPath, JSON.stringify(data, null, 2) + '\n');
  } finally {
    await release();
  }
}
