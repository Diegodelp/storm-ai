/**
 * Tests for src/core/parse-analysis.js
 *
 * The parser must be tolerant: real LLMs sometimes wrap JSON in code
 * fences, prepend "Sure, here's the JSON:", or include trailing prose.
 *
 * Run: node --test test/parse-analysis.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAnalysis, AnalysisParseError } from '../src/core/parse-analysis.js';

const validJson = JSON.stringify({
  name: 'My Project',
  description: 'A test',
  stackId: 'nextjs-app',
  stackReasoning: 'Has app/ directory and next.config.js',
  databaseId: 'postgres',
  databaseReasoning: 'prisma schema uses postgres',
  branches: [
    { path: 'app/api', description: 'API routes' },
    { path: 'components', description: 'UI components' },
  ],
  skills: [
    { name: 'auth-reviewer', description: 'Reviews auth flows' },
  ],
  agents: [
    { name: 'API Reviewer', slash: 'api-reviewer', description: 'Reviews API code' },
  ],
});

test('parseAnalysis: clean JSON parses', () => {
  const r = parseAnalysis(validJson);
  assert.equal(r.name, 'my-project'); // slugified
  assert.equal(r.description, 'A test');
  assert.equal(r.stackId, 'nextjs-app');
  assert.equal(r.databaseId, 'postgres');
  assert.equal(r.branches.length, 2);
  assert.equal(r.skills.length, 1);
  assert.equal(r.agents.length, 1);
  assert.equal(r.agents[0].slash, 'api-reviewer');
});

test('parseAnalysis: tolerates code fences', () => {
  const wrapped = '```json\n' + validJson + '\n```';
  const r = parseAnalysis(wrapped);
  assert.equal(r.stackId, 'nextjs-app');
});

test('parseAnalysis: tolerates leading prose', () => {
  const messy = "Sure, here's the analysis:\n\n" + validJson;
  const r = parseAnalysis(messy);
  assert.equal(r.stackId, 'nextjs-app');
});

test('parseAnalysis: tolerates trailing prose', () => {
  const messy = validJson + "\n\nLet me know if you need anything else.";
  const r = parseAnalysis(messy);
  assert.equal(r.stackId, 'nextjs-app');
});

test('parseAnalysis: tolerates fence + prose around it', () => {
  const messy = "Here you go:\n\n```\n" + validJson + "\n```\n\nThanks!";
  const r = parseAnalysis(messy);
  assert.equal(r.stackId, 'nextjs-app');
});

test('parseAnalysis: unknown stackId falls back to "other"', () => {
  const j = validJson.replace('"nextjs-app"', '"vue-with-laravel-and-stuff"');
  const r = parseAnalysis(j);
  assert.equal(r.stackId, 'other');
});

test('parseAnalysis: unknown databaseId falls back to "other"', () => {
  const j = validJson.replace('"postgres"', '"someweirdb"');
  const r = parseAnalysis(j);
  assert.equal(r.databaseId, 'other');
});

test('parseAnalysis: caps skills at 3 and agents at 2', () => {
  const j = JSON.stringify({
    name: 'x', description: 'x',
    stackId: 'other', databaseId: 'none',
    branches: [],
    skills: [
      { name: 's1', description: '' },
      { name: 's2', description: '' },
      { name: 's3', description: '' },
      { name: 's4', description: '' },
      { name: 's5', description: '' },
    ],
    agents: [
      { name: 'a1', slash: 'a1' },
      { name: 'a2', slash: 'a2' },
      { name: 'a3', slash: 'a3' },
    ],
  });
  const r = parseAnalysis(j);
  assert.equal(r.skills.length, 3);
  assert.equal(r.agents.length, 2);
});

test('parseAnalysis: handles missing fields', () => {
  const r = parseAnalysis(JSON.stringify({ name: 'x' }));
  assert.equal(r.name, 'x');
  assert.equal(r.description, '');
  assert.equal(r.stackId, 'other');
  assert.deepEqual(r.branches, []);
  assert.deepEqual(r.skills, []);
});

test('parseAnalysis: throws on empty input', () => {
  assert.throws(() => parseAnalysis(''), AnalysisParseError);
  assert.throws(() => parseAnalysis('   '), AnalysisParseError);
});

test('parseAnalysis: throws on non-JSON', () => {
  assert.throws(
    () => parseAnalysis('Sorry, I cannot help with that.'),
    AnalysisParseError,
  );
});

test('parseAnalysis: throws on malformed JSON', () => {
  assert.throws(
    () => parseAnalysis('{ "name": "x", but this isnt valid'),
    AnalysisParseError,
  );
});

test('parseAnalysis: handles strings with braces', () => {
  // Make sure { inside a JSON string doesn't confuse the brace matcher.
  const tricky = JSON.stringify({
    name: 'x',
    description: 'string with } and { inside it',
    stackId: 'nextjs-app',
    databaseId: 'postgres',
    branches: [],
    skills: [],
    agents: [],
  });
  const r = parseAnalysis(tricky);
  assert.equal(r.description, 'string with } and { inside it');
});

test('parseAnalysis: agent slash is slugified from name if missing', () => {
  const j = JSON.stringify({
    name: 'p', description: '', stackId: 'other', databaseId: 'none',
    branches: [], skills: [],
    agents: [{ name: 'My Cool Agent', description: '' }],
  });
  const r = parseAnalysis(j);
  assert.equal(r.agents[0].slash, 'my-cool-agent');
});

test('parseAnalysis: branch paths normalized (no trailing slash, forward slashes)', () => {
  const j = JSON.stringify({
    name: 'p', description: '', stackId: 'other', databaseId: 'none',
    branches: [
      { path: 'src\\api\\', description: '' },
      { path: 'lib/utils/', description: '' },
    ],
    skills: [], agents: [],
  });
  const r = parseAnalysis(j);
  assert.equal(r.branches[0].path, 'src/api');
  assert.equal(r.branches[1].path, 'lib/utils');
});
