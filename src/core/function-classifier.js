/**
 * LLM classifier for the function index (see core/functions.js).
 *
 * Sends only the functions that need it (new / modified / heuristic-only),
 * in batches, with a compact description of each one: ID, name, file,
 * signature, JSDoc line and the first lines of code. The model answers
 * with {id, layer, section, description} per function.
 *
 * Cost control:
 *   - unchanged functions are never re-sent (the registry keeps results);
 *   - snippets are capped (see SNIPPET_* in functions.js);
 *   - existing section names are passed so the model reuses them instead
 *     of inventing near-duplicates ("Pacientes" vs "Gestión de pacientes").
 */

import { complete as defaultComplete } from './llm-client.js';

const BATCH_SIZE = 40;
const CONCURRENCY = 2;

/**
 * @param {{
 *   provider: string,
 *   model?: string|null,
 *   language?: string,
 *   batchSize?: number,
 *   complete?: typeof defaultComplete,
 *   onProgress?: (done: number, total: number) => void,
 * }} opts
 * @returns {import('./functions.js').FunctionClassifier}
 */
export function makeLlmClassifier(opts) {
  const complete = opts.complete ?? defaultComplete;
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const language = opts.language ?? 'es';

  return async (pending, ctx) => {
    const results = new Map();
    const batches = [];
    for (let i = 0; i < pending.length; i += batchSize) batches.push(pending.slice(i, i + batchSize));

    // Sections discovered by earlier batches are shared with later ones.
    const sections = [...(ctx.sections ?? [])];
    let done = 0;
    let lastError = null;

    const runBatch = async (batch) => {
      const prompt = buildPrompt(batch, sections, language);
      try {
        const text = await complete({
          provider: opts.provider,
          model: opts.model ?? null,
          prompt,
          system: 'You classify source code functions. Respond with a JSON array only, no commentary, no code fences.',
          temperature: 0.1,
        });
        for (const r of parseClassification(text, new Set(batch.map((f) => f.id)))) {
          results.set(r.id, r);
          if (!sections.some((s) => s.layer === r.layer && s.section === r.section)) {
            sections.push({ layer: r.layer, section: r.section });
          }
        }
      } catch (err) {
        lastError = err;
      }
      done += batch.length;
      opts.onProgress?.(done, pending.length);
    };

    let next = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, batches.length) }, async () => {
      while (next < batches.length) await runBatch(batches[next++]);
    });
    await Promise.all(workers);

    // Every batch failed: surface it so the caller warns the user.
    if (results.size === 0 && lastError) throw lastError;
    return results;
  };
}

/**
 * @param {import('./functions.js').FunctionEntry[]} batch
 * @param {Array<{layer: string, section: string}>} sections
 * @param {string} language
 */
export function buildPrompt(batch, sections, language) {
  const lang = language === 'es' ? 'Spanish' : language === 'en' ? 'English' : language;
  const known = sections.length
    ? sections.map((s) => `- ${s.layer}: ${s.section}`).join('\n')
    : '(none yet)';
  const items = batch.map((f) => ({
    id: f.id,
    name: f.name,
    kind: f.kind,
    file: f.file,
    signature: f.signature,
    ...(f.doc ? { doc: f.doc } : {}),
    code: f.snippet,
  }));

  return [
    'Classify each function of this application.',
    '',
    'For every function return:',
    '- "id": the given id, unchanged.',
    '- "layer": "frontend" (UI, pages, components, client hooks/state), "backend" (API routes, server, DB, business logic run on the server) or "shared" (utilities, types, config used by both).',
    '- "section": the functional area of the app it belongs to, as a short Title Case name of 1-3 words (e.g. "Pacientes", "Turnos", "Autenticación", "Facturación"). Group by business domain, not by technical role. Reuse an existing section name whenever it fits.',
    `- "description": one short sentence in ${lang} saying what the function does (e.g. "Trae la lista de pacientes").`,
    '',
    'Existing sections:',
    known,
    '',
    'Functions (JSON):',
    JSON.stringify(items),
    '',
    'Answer with a JSON array: [{"id":"ID-001","layer":"frontend","section":"Pacientes","description":"..."}]',
  ].join('\n');
}

/**
 * Extract classification entries from the model output. Tolerates code
 * fences and text around the JSON; ignores IDs that weren't asked for.
 *
 * @param {string} text
 * @param {Set<string>} [allowedIds]
 * @returns {Array<{id: string, layer: string, section: string, description: string}>}
 */
export function parseClassification(text, allowedIds) {
  const raw = String(text ?? '');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  let data = null;
  if (start !== -1 && end > start) {
    try { data = JSON.parse(raw.slice(start, end + 1)); } catch { data = null; }
  }
  if (!data) {
    // Some models wrap the array: {"functions": [...]}.
    try {
      const obj = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      data = Object.values(obj).find(Array.isArray) ?? null;
    } catch {
      data = null;
    }
  }
  if (!Array.isArray(data)) throw new Error('La IA no devolvió un JSON válido para clasificar funciones.');

  const out = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id ?? '').replace(/^#/, '').toUpperCase();
    if (!id || (allowedIds && !allowedIds.has(id))) continue;
    const layer = String(item.layer ?? '').toLowerCase();
    out.push({
      id,
      layer: ['frontend', 'backend', 'shared'].includes(layer) ? layer : 'shared',
      section: String(item.section ?? '').trim() || 'General',
      description: String(item.description ?? '').trim(),
    });
  }
  return out;
}
