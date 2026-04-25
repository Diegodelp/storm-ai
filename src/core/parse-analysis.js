/**
 * Parse and validate an LLM analysis response.
 *
 * The LLM is asked for "a strict JSON object". They mostly comply, but
 * sometimes wrap it in code fences or precede it with a sentence. This
 * module is forgiving: it locates the first balanced `{...}` block and
 * tries to parse it.
 *
 * Once parsed, every field is validated against known stack/database ids
 * and shape constraints. Unknown stackId/databaseId fall back to "other".
 * Unknown fields are dropped silently.
 */

import { STACKS, DATABASES, getStack, getDatabase } from './stacks.js';

const KNOWN_STACK_IDS = new Set(STACKS.map((s) => s.id));
const KNOWN_DB_IDS = new Set(DATABASES.map((d) => d.id));

/**
 * @typedef {Object} AnalysisResult
 * @property {string} name
 * @property {string} description
 * @property {string} stackId
 * @property {string} stackReasoning
 * @property {string} databaseId
 * @property {string} databaseReasoning
 * @property {{path: string, description: string}[]} branches
 * @property {{name: string, description: string}[]} skills
 * @property {{name: string, slash: string, description: string}[]} agents
 */

export class AnalysisParseError extends Error {
  constructor(message, raw) {
    super(message);
    this.name = 'AnalysisParseError';
    this.raw = raw;
  }
}

/**
 * @param {string} rawText  Raw LLM output.
 * @returns {AnalysisResult}
 */
export function parseAnalysis(rawText) {
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    throw new AnalysisParseError('Respuesta vacía del LLM', rawText);
  }

  const json = extractJsonBlock(rawText);
  if (!json) {
    throw new AnalysisParseError(
      'No se encontró JSON en la respuesta del LLM',
      rawText,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new AnalysisParseError(
      `JSON inválido: ${err.message}`,
      rawText,
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new AnalysisParseError('La respuesta no es un objeto', rawText);
  }

  return normalize(parsed);
}

/**
 * Find the first balanced `{ ... }` substring. Strips ```json ... ```
 * fences first if present.
 */
function extractJsonBlock(text) {
  // Strip code fences. Matches ```json...``` or ```...```.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1] : text;

  // Find the first '{' and walk until the matching '}'.
  const start = candidate.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (inString) {
      if (ch === '\\') { escapeNext = true; }
      else if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return candidate.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Coerce arbitrary parsed JSON into a clean AnalysisResult.
 * Anything that doesn't fit gets a sane default.
 *
 * @param {any} obj
 * @returns {AnalysisResult}
 */
function normalize(obj) {
  /** @type {AnalysisResult} */
  const out = {
    name: '',
    description: '',
    stackId: 'other',
    stackReasoning: '',
    databaseId: 'other',
    databaseReasoning: '',
    branches: [],
    skills: [],
    agents: [],
  };

  if (typeof obj.name === 'string') out.name = slugify(obj.name);
  if (typeof obj.description === 'string') out.description = obj.description.trim();

  if (typeof obj.stackId === 'string' && KNOWN_STACK_IDS.has(obj.stackId)) {
    out.stackId = obj.stackId;
  }
  if (typeof obj.stackReasoning === 'string') {
    out.stackReasoning = obj.stackReasoning.trim();
  }

  if (typeof obj.databaseId === 'string' && KNOWN_DB_IDS.has(obj.databaseId)) {
    out.databaseId = obj.databaseId;
  }
  if (typeof obj.databaseReasoning === 'string') {
    out.databaseReasoning = obj.databaseReasoning.trim();
  }

  if (Array.isArray(obj.branches)) {
    out.branches = obj.branches
      .filter((b) => b && typeof b.path === 'string' && b.path.trim())
      .map((b) => ({
        path: b.path.trim().replaceAll('\\', '/').replace(/\/+$/, ''),
        description: typeof b.description === 'string' ? b.description.trim() : '',
      }))
      .slice(0, 10); // hard cap
  }

  if (Array.isArray(obj.skills)) {
    out.skills = obj.skills
      .filter((s) => s && typeof s.name === 'string' && s.name.trim())
      .map((s) => ({
        name: s.name.trim(),
        description: typeof s.description === 'string' ? s.description.trim() : '',
      }))
      .slice(0, 3); // per spec: max 3
  }

  if (Array.isArray(obj.agents)) {
    out.agents = obj.agents
      .filter((a) => a && typeof a.name === 'string' && a.name.trim())
      .map((a) => ({
        name: a.name.trim(),
        slash: typeof a.slash === 'string'
          ? slugify(a.slash)
          : slugify(a.name),
        description: typeof a.description === 'string' ? a.description.trim() : '',
      }))
      .slice(0, 2); // per spec: max 2
  }

  return out;
}

function slugify(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Helpers exported so the wizard can render reasoning.
 */
export function lookupStack(id) { return getStack(id); }
export function lookupDatabase(id) { return getDatabase(id); }
