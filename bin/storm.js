#!/usr/bin/env node
/**
 * storm-ai CLI entry point.
 *
 * We keep this file tiny on purpose — all logic lives in src/. This way
 * the entry point never needs to change when commands evolve.
 */

import { runCli } from '../src/cli.js';
import process from 'node:process';

runCli(process.argv).catch((err) => {
  // Last-resort error handler. Most errors are caught inside runCli
  // and formatted there; this is for truly unexpected failures.
  console.error('\n\x1b[38;2;239;91;91m✗\x1b[0m ' + (err?.message ?? String(err)));
  if (process.env.STORM_DEBUG) console.error(err?.stack);
  process.exit(1);
});
