/** Project-local runtime configuration for the CLI selected in project.config.json. */
import { readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse, modify, applyEdits } from 'jsonc-parser';
import { atomicWrite, atomicWriteJson } from './atomic-io.js';
import { readConfig, writeConfig } from './config.js';
import { fileExists } from './paths.js';
import { getOllamaHost } from './global-config.js';
import { CLOUD_MODELS, chooseInstalledModel, isCloudModel, listOllamaModels } from './providers.js';

const STATE_FILE = '.storm/agent-config.json';
const CLAUDE_FILE = '.claude/settings.local.json';
const OPENCODE_FILES = ['.opencode/opencode.jsonc', '.opencode/opencode.json', 'opencode.jsonc', 'opencode.json'];
const NATIVE_FILES = new Set([CLAUDE_FILE, ...OPENCODE_FILES]);

async function readDocument(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return { text: '{}\n', data: {}, exists: false };
  }
  const errors = [];
  const data = parse(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
  if (errors.length || !data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Configuración inválida: ${file}. Corregí el JSON/JSONC; no se sobrescribió.`);
  }
  return { text, data, exists: true };
}

function at(data, keys) {
  for (const key of keys) {
    if (!data || typeof data !== 'object' || !Object.hasOwn(data, key)) return undefined;
    data = data[key];
  }
  return data;
}

function edit(doc, keys, value) {
  if (isDeepStrictEqual(at(doc.data, keys), value)) return;
  // modify edits only the requested property, retaining unrelated JSONC comments.
  doc.text = applyEdits(doc.text, modify(doc.text, keys, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: doc.text.includes('\r\n') ? '\r\n' : '\n' },
  }));
  doc.data = parse(doc.text);
  if (value === undefined && keys.length > 1) {
    const parent = keys.slice(0, -1);
    const current = at(doc.data, parent);
    if (current && typeof current === 'object' && !Array.isArray(current) && !Object.keys(current).length) edit(doc, parent, undefined);
  }
}

async function inheritedModel(agent, projectRoot, local) {
  if (agent === 'claude-code' && process.env.ANTHROPIC_MODEL?.trim()) return process.env.ANTHROPIC_MODEL.trim();
  if (typeof local.model === 'string' && local.model.trim()) return local.model;
  const candidates = agent === 'claude-code'
    ? [path.join(projectRoot, '.claude/settings.json'), path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'settings.json')]
    : [process.env.OPENCODE_CONFIG, ...['opencode.jsonc', 'opencode.json'].map((name) =>
      path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'opencode', name))];
  if (agent === 'opencode' && process.env.OPENCODE_CONFIG_CONTENT) {
    const model = parse(process.env.OPENCODE_CONFIG_CONTENT)?.model;
    if (typeof model === 'string' && model.trim()) return model;
  }
  for (const file of candidates.filter(Boolean)) {
    const { data } = await readDocument(file);
    if (typeof data.model === 'string' && data.model.trim()) return data.model;
  }
  return null;
}

/**
 * Merge generated routing/model fields into native CLI config. The state file
 * records only generated values, so switching providers removes our old fields
 * without deleting permissions, hooks, credentials, or manually changed values.
 * Dependencies are injectable for offline discovery and tests.
 */
export async function configureAgentForProject({ projectRoot, config, strict = false }, {
  listModels = listOllamaModels, getHost = getOllamaHost,
} = {}) {
  const result = { createdFiles: [], warnings: [], modelName: config.model?.name ?? null };
  if (config.launch?.customCommand || !['claude-code', 'opencode'].includes(config.agent)) return result;
  const agent = config.agent;
  const provider = config.model.provider;
  const ollama = provider === 'ollama-local' || provider === 'ollama-cloud';
  const statePath = path.join(projectRoot, STATE_FILE);
  const state = (await readDocument(statePath)).data;
  const documents = new Map();
  const load = async (file) => {
    if (!documents.has(file)) documents.set(file, await readDocument(path.join(projectRoot, file)));
    return documents.get(file);
  };
  let target = CLAUDE_FILE;
  if (agent === 'opencode') {
    target = 'opencode.json';
    for (const file of OPENCODE_FILES) {
      if ((await load(file)).exists) { target = file; break; }
    }
  }
  const doc = await load(target);
  // Retire only fields still equal to what Storm previously generated.
  for (const [file, entries] of Object.entries(state.files ?? {})) {
    if (!NATIVE_FILES.has(file) || !Array.isArray(entries)) continue;
    const previous = await load(file);
    for (const entry of entries) {
      if (!Array.isArray(entry.path) || !entry.path.length || !entry.path.every((k) => typeof k === 'string')) continue;
      if (isDeepStrictEqual(at(previous.data, entry.path), entry.value)) edit(previous, entry.path, undefined);
    }
  }

  let selected = config.model.name?.trim() || null;
  if (state.provider && state.provider !== provider && selected === state.modelName) selected = null;
  let host;
  let models = [];
  if (ollama) {
    host = await getHost();
    const all = await listModels({ includeCloud: true });
    models = all.filter((m) => isCloudModel(m) === (provider === 'ollama-cloud'));
    if (selected && provider === 'ollama-local' && isCloudModel(selected)) {
      throw new Error(`El modelo ${selected} es cloud. Usá ollama-cloud o elegí un modelo local.`);
    }
    if (!selected) selected = chooseInstalledModel(models, provider);
    if (!selected && provider === 'ollama-cloud') selected = CLOUD_MODELS[0].name;
    if (!selected) {
      const message = `No se detectaron modelos locales en ${host}. Iniciá Ollama y descargá un modelo con \`ollama pull <modelo>\`, o indicá model.name.`;
      if (strict) throw new Error(message);
      result.warnings.push(message);
      return result;
    }
    const match = models.find((m) => m.name === selected || m.name === `${selected}:latest`);
    if (match) selected = match.name;
    else if (provider === 'ollama-local' && all.length) {
      const message = `El modelo local ${selected} no está instalado en ${host}. Descargalo con \`ollama pull ${selected}\` o elegí uno de los modelos detectados: ${models.map((m) => m.name).join(', ') || '(ninguno)'}.`;
      if (strict) throw new Error(message);
      result.warnings.push(message);
    }
  } else if (provider === 'claude') {
    selected ||= process.env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-4-5';
    selected = selected.replace(/^anthropic\//, '');
  } else if (provider === 'via-claude-code' || provider === 'via-opencode') {
    // A model configured in one CLI is not automatically usable in the other.
    const sourceAgent = provider === 'via-opencode' ? 'opencode' : 'claude-code';
    selected = (sourceAgent === agent ? selected : null) || await inheritedModel(agent, projectRoot, doc.data);
  } else {
    throw new Error(`Provider desconocido: ${provider}`);
  }

  const entries = [];
  const set = (keys, value) => {
    // A matching value already owned by the user does not become ours to delete.
    if (isDeepStrictEqual(at(doc.data, keys), value)) return;
    edit(doc, keys, value);
    entries.push({ path: keys, value });
  };
  if (agent === 'claude-code') {
    if (selected) set(['model'], selected);
    if (ollama) {
      for (const [key, value] of Object.entries({
        ANTHROPIC_BASE_URL: host,
        ANTHROPIC_AUTH_TOKEN: 'ollama',
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_MODEL: selected,
        ANTHROPIC_DEFAULT_SONNET_MODEL: selected,
        ANTHROPIC_DEFAULT_OPUS_MODEL: selected,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: selected,
        CLAUDE_CODE_SUBAGENT_MODEL: selected,
      })) set(['env', key], value);
    }
  } else {
    if (!doc.data.$schema) edit(doc, ['$schema'], 'https://opencode.ai/config.json');
    if (ollama) {
      set(['model'], `ollama/${selected}`);
      set(['small_model'], `ollama/${selected}`);
      set(['provider', 'ollama', 'npm'], '@ai-sdk/openai-compatible');
      set(['provider', 'ollama', 'name'], 'Ollama');
      set(['provider', 'ollama', 'options', 'baseURL'], `${host}/v1`);
      // OpenCode only offers the models listed here. Cloud models are not
      // "installed", so /api/tags rarely lists them: add the curated cloud
      // catalog so the picker shows them (with a readable label).
      const labels = new Map(provider === 'ollama-cloud' ? CLOUD_MODELS.map((m) => [m.name, m.label]) : []);
      for (const name of new Set([selected, ...models.map((m) => m.name), ...labels.keys()])) {
        set(['provider', 'ollama', 'models', name, 'name'], labels.get(name) ?? name);
      }
    } else if (selected) {
      set(['model'], provider === 'claude' ? `anthropic/${selected}` : selected);
    }
    // The existing scaffold places instructions here; register it explicitly.
    const instructions = doc.data.instructions ?? [];
    if (!Array.isArray(instructions)) throw new Error(`${target}: instructions debe ser un array.`);
    if (await fileExists(path.join(projectRoot, '.opencode/AGENTS.md')) && !instructions.includes('.opencode/AGENTS.md')) {
      edit(doc, ['instructions'], [...instructions, '.opencode/AGENTS.md']);
    }
  }

  // Validate/prepare every document before writing any of them.
  for (const [file, document] of documents) {
    const dest = path.join(projectRoot, file);
    let old;
    try { old = await readFile(dest, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (old === document.text || (!document.exists && file !== target)) continue;
    await mkdir(path.dirname(dest), { recursive: true });
    await atomicWrite(dest, document.text);
    result.createdFiles.push(file);
  }
  await mkdir(path.dirname(statePath), { recursive: true });
  const nextState = { version: 1, provider, modelName: selected, files: { [target]: entries } };
  if (!isDeepStrictEqual(state, nextState)) {
    await atomicWriteJson(statePath, nextState);
    result.createdFiles.push(STATE_FILE);
  }
  // No secrets are copied from the environment or global CLI config.
  const ignorePath = path.join(projectRoot, '.gitignore');
  let ignore = '';
  try { ignore = await readFile(ignorePath, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const ignored = ignore.split(/\r?\n/);
  const rules = [`/${STATE_FILE}`, ...(agent === 'claude-code' ? [`/${CLAUDE_FILE}`] : [])];
  const missing = rules.filter((rule) => !ignored.includes(rule));
  if (missing.length) {
    await atomicWrite(ignorePath, `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
    result.createdFiles.push('.gitignore');
  }
  result.modelName = selected;
  // Persist automatic choices for direct providers; delegated CLIs keep their defaults.
  if (ollama || provider === 'claude') config.model.name = selected;
  return result;
}

/** Keep every creation path and launch on the same saved project configuration. */
export async function syncAgentConfig(projectRoot, options = {}) {
  const config = await readConfig(projectRoot);
  const before = config.model.name;
  const result = await configureAgentForProject({ projectRoot, config, ...options });
  if (config.model.name !== before) await writeConfig(projectRoot, config);
  return result;
}
