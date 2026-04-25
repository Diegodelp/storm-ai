/**
 * Minimal LLM client used by `storm import`.
 *
 * Two backends:
 *   - 'ollama-cloud' / 'ollama-local': POSTs to http://127.0.0.1:11434/api/generate
 *     with the chosen model name. Cloud models include the ":cloud" suffix
 *     and Ollama itself routes the request to ollama.com — we never hit
 *     ollama.com directly.
 *   - 'claude': POSTs to https://api.anthropic.com/v1/messages using the
 *     ANTHROPIC_API_KEY env var.
 *
 * The interface is intentionally narrow: text in, text out. Importers
 * who need streaming or function calling can extend this later.
 */

import process from 'node:process';

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
const ANTHROPIC_HOST = 'https://api.anthropic.com';

/** Default model used if none is provided. Reasonable for most tasks. */
const DEFAULT_OLLAMA_MODEL = 'kimi-k2.6:cloud';
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-5';

/**
 * @typedef {Object} CompleteInput
 * @property {string} provider           'ollama-cloud' | 'ollama-local' | 'claude'
 * @property {string|null} [model]       Model name. Provider default if null.
 * @property {string} prompt             User prompt.
 * @property {string} [system]           Optional system prompt.
 * @property {number} [temperature]      Sampling temperature (default 0.2).
 * @property {AbortSignal} [signal]      Cancellation.
 */

/**
 * Run a single completion. Returns the assistant's reply as plain text.
 *
 * @param {CompleteInput} input
 * @returns {Promise<string>}
 */
export async function complete(input) {
  if (input.provider === 'ollama-cloud' || input.provider === 'ollama-local') {
    return ollamaComplete(input);
  }
  if (input.provider === 'claude') {
    return claudeComplete(input);
  }
  throw new Error(`Provider desconocido: ${input.provider}`);
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

async function ollamaComplete(input) {
  const model = input.model || DEFAULT_OLLAMA_MODEL;
  const url = `${OLLAMA_HOST}/api/generate`;

  const body = {
    model,
    prompt: input.prompt,
    system: input.system,
    stream: false,
    options: {
      temperature: input.temperature ?? 0.2,
    },
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: input.signal,
    });
  } catch (err) {
    throw new Error(
      `No se pudo contactar a Ollama en ${OLLAMA_HOST}. ` +
        `¿Está corriendo el daemon? (\`ollama serve\`). Error: ${err.message}`,
    );
  }

  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`Ollama respondió ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  if (typeof data.response !== 'string') {
    throw new Error(`Respuesta inesperada de Ollama: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.response;
}

// ---------------------------------------------------------------------------
// Claude (Anthropic)
// ---------------------------------------------------------------------------

async function claudeComplete(input) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Falta ANTHROPIC_API_KEY en el environment. ' +
        'Definila o cambiá el provider a Ollama.',
    );
  }

  const model = input.model || DEFAULT_CLAUDE_MODEL;
  const url = `${ANTHROPIC_HOST}/v1/messages`;

  const body = {
    model,
    max_tokens: 4096,
    temperature: input.temperature ?? 0.2,
    system: input.system,
    messages: [{ role: 'user', content: input.prompt }],
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: input.signal,
    });
  } catch (err) {
    throw new Error(`No se pudo contactar a Anthropic: ${err.message}`);
  }

  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`Anthropic respondió ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  // Response shape: { content: [{ type: 'text', text: '...' }, ...] }
  const text = (data?.content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  if (!text) {
    throw new Error(`Respuesta vacía de Anthropic: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return text;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '<no body>';
  }
}
