/**
 * Shared pickers for agent / provider / model.
 *
 * Every wizard that asks "which agent, which provider, which model" goes
 * through here, so they all:
 *   - ask the agent FIRST and only offer providers that can launch it,
 *   - start from the current / default values, unless they need Ollama
 *     and Ollama isn't available (then the agent's own via-* provider),
 *   - flag the Ollama options when Ollama isn't installed/reachable,
 *   - accept the same model names.
 *
 * All functions return null when the user cancels (Esc).
 */

import * as clack from '@clack/prompts';

import {
  PROVIDERS,
  CLOUD_MODELS,
  LOCAL_RECOMMENDED,
  detectOllama,
  listOllamaModels,
  pullOllamaModel,
  getProvider,
  providerNeedsModel,
  isCloudModelName,
  isOllamaAvailable,
  isOllamaProvider,
} from '../core/providers.js';
import { AGENTS, getAgent, getCompatibleProviders, suggestProvider } from '../core/agents.js';
import * as ansi from './ansi.js';

/**
 * @param {{initialValue?: string, message?: string}} [opts]
 * @returns {Promise<{agent: string, launchCommand: string|null}|null>}
 *   launchCommand is only set for custom agents.
 */
export async function pickAgent(opts = {}) {
  const initial = opts.initialValue ?? 'claude-code';
  const isCustom = !getAgent(initial);
  const choice = await clack.select({
    message: opts.message ?? '¿Qué CLI (agent) vas a usar?',
    options: [
      ...AGENTS.map((a) => ({ value: a.id, label: a.label, hint: a.hint })),
      { value: '__custom__', label: 'Otro... (Aider, script propio, ...)', hint: isCustom ? `actual: ${initial}` : undefined },
    ],
    initialValue: isCustom ? '__custom__' : initial,
  });
  if (clack.isCancel(choice)) return null;
  if (choice !== '__custom__') return { agent: choice, launchCommand: null };

  const id = await clack.text({
    message: 'ID del agent',
    placeholder: 'aider',
    initialValue: isCustom ? initial : '',
    validate: (v) => (v?.trim() ? undefined : 'No puede estar vacío'),
  });
  if (clack.isCancel(id)) return null;
  const cmd = await clack.text({
    message: `Comando para lanzarlo (usá ${ansi.cyan('{{model}}')} para el modelo)`,
    placeholder: 'aider --model {{model}}',
    initialValue: opts.launchCommand ?? '',
    validate: (v) => (v?.trim() ? undefined : 'Un agent custom necesita un comando'),
  });
  if (clack.isCancel(cmd)) return null;
  return { agent: id.trim(), launchCommand: cmd.trim() };
}

/**
 * Pick a provider. With `agentId`, only providers that can launch that
 * agent are offered (custom agents accept all). When Ollama isn't
 * available, its options are flagged, the pre-selection avoids them and
 * picking one asks for confirmation.
 *
 * @param {{agentId?: string, suggestFor?: string, initialValue?: string|null,
 *          message?: string, ollamaAvailable?: boolean}} [opts]
 *   suggestFor: agent used only to choose the pre-selection (no filtering).
 * @returns {Promise<string|null>}
 */
export async function pickProvider(opts = {}) {
  const ollamaAvailable = opts.ollamaAvailable ?? await isOllamaAvailable();
  const compatible = opts.agentId ? getCompatibleProviders(opts.agentId) : null;
  const options = PROVIDERS
    .filter((p) => compatible === null || compatible.includes(p.id))
    .map((p) => ({
      value: p.id,
      label: p.label,
      hint: isOllamaProvider(p.id) && !ollamaAvailable
        ? 'Requiere Ollama — no detectado en esta máquina'
        : p.hint,
    }));
  const suggested = suggestProvider({
    agentId: opts.agentId ?? opts.suggestFor ?? null,
    preferred: opts.initialValue ?? null,
    ollamaAvailable,
  });
  const initial = options.some((o) => o.value === suggested) ? suggested : options[0].value;

  if (!ollamaAvailable) {
    clack.log.info(ansi.dim(
      'Ollama no está instalado ni responde en OLLAMA_HOST. Si usás los modelos de tu CLI ' +
        '(OpenCode, Claude Code), elegí "Via ..." y storm no le cambia el modelo.',
    ));
  }

  while (true) {
    const choice = await clack.select({
      message: opts.message ?? '¿Qué proveedor de IA?',
      options,
      initialValue: initial,
    });
    if (clack.isCancel(choice)) return null;
    if (!isOllamaProvider(choice) || ollamaAvailable) return choice;

    const sure = await clack.confirm({
      message: 'Ollama no está disponible: el agent no va a poder usar ese provider hasta que lo instales. ¿Usarlo igual?',
      initialValue: false,
    });
    if (clack.isCancel(sure)) return null;
    if (sure) return choice;
  }
}

/**
 * Pick a model for `provider`. Providers without a model picker return
 * `{provider, name: null}` without asking.
 *
 * @param {string} provider
 * @param {{initialValue?: string|null, offerPull?: boolean}} [opts]
 * @returns {Promise<{provider: string, name: string|null}|null>}
 */
export async function pickModel(provider, opts = {}) {
  if (!providerNeedsModel(provider)) return { provider, name: null };
  const name = provider === 'ollama-cloud'
    ? await pickOllamaCloudModel(opts.initialValue)
    : await pickOllamaLocalModel(opts.initialValue, opts.offerPull ?? true);
  return name ? { provider, name } : null;
}

/**
 * Agent → provider → model, in that order.
 *
 * @param {{agent?: string, launchCommand?: string|null, provider?: string|null, model?: string|null,
 *          ollamaAvailable?: boolean}} [initial]
 *   provider null/undefined → suggested from the agent (see suggestProvider).
 * @returns {Promise<{agent: string, launchCommand: string|null, model: {provider: string, name: string|null}}|null>}
 */
export async function pickLaunchSettings(initial = {}) {
  const agent = await pickAgent({ initialValue: initial.agent, launchCommand: initial.launchCommand });
  if (!agent) return null;
  const provider = await pickProvider({
    agentId: agent.agent,
    initialValue: initial.provider,
    ollamaAvailable: initial.ollamaAvailable,
  });
  if (!provider) return null;
  const model = await pickModel(provider, {
    initialValue: provider === initial.provider ? initial.model : null,
  });
  if (!model) return null;
  return { agent: agent.agent, launchCommand: agent.launchCommand, model };
}

/** @param {string} id */
export function providerLabel(id) {
  return getProvider(id)?.label ?? id;
}

// ---------------------------------------------------------------------------
// Ollama model pickers
// ---------------------------------------------------------------------------

async function pickOllamaCloudModel(initialValue) {
  const known = CLOUD_MODELS.some((m) => m.name === initialValue);
  const options = [
    ...CLOUD_MODELS.map((m) => ({ value: m.name, label: m.label, hint: m.hint })),
    { value: '__other__', label: 'Otro...', hint: known || !initialValue ? 'Escribir el nombre de cualquier modelo cloud' : `actual: ${initialValue}` },
  ];

  const choice = await clack.select({
    message: 'Elegí un modelo cloud',
    options,
    initialValue: known ? initialValue : initialValue ? '__other__' : CLOUD_MODELS[0].name,
  });
  if (clack.isCancel(choice)) return null;
  if (choice !== '__other__') return choice;

  const custom = await clack.text({
    message: 'Nombre del modelo cloud (termina en ":cloud" o "-cloud")',
    placeholder: 'mi-modelo:cloud',
    initialValue: known ? '' : initialValue ?? '',
    validate: (v) => (isCloudModelName(v) ? undefined : 'Los modelos cloud terminan en ":cloud" o "-cloud".'),
  });
  if (clack.isCancel(custom)) return null;
  return custom.trim();
}

async function pickOllamaLocalModel(initialValue, offerPull) {
  const ollama = await detectOllama();
  if (!ollama.installed) {
    clack.log.info('Ollama CLI no está instalado. Buscando modelos en el daemon configurado en OLLAMA_HOST.');
  }

  const spinner = clack.spinner();
  spinner.start('Buscando modelos Ollama locales');
  // Queries the daemon over HTTP, so remote OLLAMA_HOSTs work without the CLI.
  const local = await listOllamaModels();
  spinner.stop(`${local.length} modelo(s) local(es) detectado(s)`);

  const detectedNames = new Set(local.map((m) => m.name));
  const options = [];
  for (const m of local) {
    options.push({ value: m.name, label: m.name, hint: m.size ? `instalado · ${m.size}` : 'instalado' });
  }
  for (const m of LOCAL_RECOMMENDED) {
    if (!detectedNames.has(m.name)) {
      options.push({ value: m.name, label: m.label, hint: `${m.hint} · se descarga al elegirlo` });
    }
  }
  const listed = options.some((o) => o.value === initialValue);
  options.push({ value: '__other__', label: 'Otro...', hint: 'Escribir el nombre de cualquier modelo local' });

  const choice = await clack.select({
    message: 'Elegí un modelo local',
    options,
    initialValue: listed ? initialValue : initialValue ? '__other__' : options[0].value,
  });
  if (clack.isCancel(choice)) return null;

  let modelName = choice;
  if (choice === '__other__') {
    const custom = await clack.text({
      message: 'Nombre del modelo local',
      placeholder: 'qwen3.5:9b',
      initialValue: listed ? '' : initialValue ?? '',
      validate: (v) => {
        if (!v?.trim()) return 'El nombre es obligatorio';
        if (isCloudModelName(v)) return 'Ese es un modelo cloud: usá el provider Ollama (cloud).';
        return undefined;
      },
    });
    if (clack.isCancel(custom)) return null;
    modelName = custom.trim();
  }

  if (offerPull && ollama.installed && !detectedNames.has(modelName)) {
    const pullConfirm = await clack.confirm({
      message: `¿Descargar ${ansi.cyan(modelName)} ahora? (puede tardar varios minutos)`,
      initialValue: true,
    });
    if (clack.isCancel(pullConfirm)) return null;
    if (pullConfirm) {
      clack.log.info(`Descargando ${modelName}...`);
      const r = await pullOllamaModel(modelName);
      if (!r.ok) clack.log.warn(`Falló la descarga: ${r.message}. Volvé a intentar: ollama pull ${modelName}`);
      else clack.log.success(`${modelName} listo.`);
    }
  }
  return modelName;
}
