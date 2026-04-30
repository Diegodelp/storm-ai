/**
 * Wizard interactivo para `storm new --template`.
 *
 * Flujo:
 *   1. Lista de templates desde el registry (con spinner por la HTTP fetch).
 *   2. Usuario elige uno.
 *   3. Spinner: clonar repo y leer storm-template.json.
 *   4. Preguntar el nombre del proyecto.
 *   5. Preguntar variables del template (las definidas en storm-template.json).
 *   6. Preguntar provider/model (igual que el wizard normal).
 *   7. Confirmar.
 *   8. applyTemplateToProject().
 *   9. Mostrar resumen y abrir Claude Code.
 *
 * Si el registry está vacío o falla la fetch, devuelve null para que el
 * wizard principal caiga al flujo "desde cero".
 */

import * as clack from '@clack/prompts';
import path from 'node:path';

import { listTemplates } from '../commands/templates.js';
import { fetchTemplate, applyTemplateToProject } from '../commands/new-from-template.js';
import {
  detectOllama,
  listOllamaModels,
  pullOllamaModel,
  CLOUD_MODELS,
  LOCAL_RECOMMENDED,
} from '../core/providers.js';
import { detectGit } from '../core/requirements.js';
import * as ansi from './ansi.js';

/**
 * @param {{cwd: string}} input
 * @returns {Promise<'cancelled'|'fallback'|'done'>}
 *   'fallback' = no había templates, el caller debe correr el wizard normal.
 */
export async function runNewFromTemplateWizard({ cwd }) {
  // Pre-flight: git is mandatory for cloning.
  const git = await detectGit();
  if (!git.installed) {
    clack.log.error(
      'git no está instalado. Es necesario para clonar templates.\n' +
        'Instalalo con: storm  (te lo va a ofrecer en el chequeo inicial), ' +
        'o desde https://git-scm.com/download',
    );
    return 'cancelled';
  }

  // Fetch registry.
  const fetchSpinner = clack.spinner();
  fetchSpinner.start('Buscando templates disponibles');
  let registry;
  try {
    registry = await listTemplates();
    fetchSpinner.stop(`${registry.length} template(s) encontrado(s)`);
  } catch (err) {
    fetchSpinner.stop(ansi.red('Falló la búsqueda de templates'));
    clack.log.error(err.message ?? String(err));
    return 'fallback';
  }

  if (registry.length === 0) {
    clack.log.info(
      'Todavía no hay templates publicados en el registry. ' +
        'Sigamos con el wizard desde cero.',
    );
    return 'fallback';
  }

  // Pick a template.
  const pickedId = await clack.select({
    message: 'Elegí un template',
    options: [
      ...registry.map((t) => ({
        value: t.id,
        label: t.label,
        hint: t.description,
      })),
      { value: '__cancel__', label: 'Cancelar y volver al menú principal' },
    ],
  });
  if (clack.isCancel(pickedId) || pickedId === '__cancel__') return 'cancelled';

  const entry = registry.find((t) => t.id === pickedId);

  // Clone + read metadata.
  const cloneSpinner = clack.spinner();
  cloneSpinner.start(`Clonando ${entry.repo}`);
  let cloneResult;
  try {
    cloneResult = await fetchTemplate({ repo: entry.repo, ref: entry.ref });
    cloneSpinner.stop('Template descargado');
  } catch (err) {
    cloneSpinner.stop(ansi.red('Falló la descarga'));
    clack.log.error(err.message ?? String(err));
    return 'cancelled';
  }

  const meta = cloneResult.metadata;

  clack.note(
    [
      `${ansi.bold(meta.label)}`,
      meta.description ? ansi.dim(meta.description) : null,
      '',
      `Stack:        ${meta.stackId}`,
      meta.databaseId ? `Base datos:   ${meta.databaseId}` : null,
      `Variables:    ${meta.variables?.length ?? 0}`,
      `Tareas init:  ${meta.initialTasks?.length ?? 0}`,
      `Post-install: ${meta.postInstall?.length ?? 0} comando(s)`,
    ].filter(Boolean).join('\n'),
    'Detalles del template',
  );

  try {
    // Project name.
    const projectName = await clack.text({
      message: 'Nombre del proyecto',
      placeholder: meta.name,
      initialValue: meta.name,
      validate: (v) => (v?.trim() ? undefined : 'El nombre es obligatorio'),
    });
    if (clack.isCancel(projectName)) return cancelled();

    // Variables.
    const variables = {};
    for (const v of meta.variables ?? []) {
      const answered = await clack.text({
        message: v.prompt || `Valor para ${v.key}`,
        placeholder: v.placeholder ?? '',
        validate: v.optional
          ? undefined
          : (val) => (val?.trim() ? undefined : 'Es obligatorio'),
      });
      if (clack.isCancel(answered)) return cancelled();
      variables[v.key] = answered ?? '';
    }

    // Provider + modelo.
    const providerChoice = await clack.select({
      message: '¿Qué proveedor de IA?',
      options: [
        { value: 'ollama-cloud', label: 'Ollama (cloud)', hint: 'Gratis, calidad Claude.' },
        { value: 'ollama-local', label: 'Ollama (local)', hint: 'Corre en tu máquina.' },
        { value: 'claude',       label: 'Claude API',     hint: 'Requiere ANTHROPIC_API_KEY.' },
      ],
      initialValue: 'ollama-cloud',
    });
    if (clack.isCancel(providerChoice)) return cancelled();

    let model = { provider: providerChoice, name: null };
    if (providerChoice === 'ollama-cloud') {
      model = await pickOllamaCloudModel();
      if (!model) return cancelled();
    } else if (providerChoice === 'ollama-local') {
      model = await pickOllamaLocalModel();
      if (!model) return cancelled();
    }

    // Confirmation.
    const summary = [
      `Template:     ${ansi.cyan(meta.label)}`,
      `Nombre:       ${ansi.cyan(projectName)}`,
      `Carpeta:      ${ansi.dim(path.resolve(cwd, '.'))}`,
      `Proveedor:    ${providerLabel(providerChoice)}${model.name ? ` (${model.name})` : ''}`,
      meta.postInstall?.length
        ? `Post-install: ${meta.postInstall.join(' && ')}`
        : null,
    ].filter(Boolean).join('\n');
    clack.note(summary, 'Resumen');

    const confirm = await clack.confirm({
      message: '¿Aplicar el template ahora?',
      initialValue: true,
    });
    if (clack.isCancel(confirm) || !confirm) return cancelled();

    // Apply!
    const applySpinner = clack.spinner();
    applySpinner.start('Aplicando template');
    let result;
    try {
      result = await applyTemplateToProject({
        projectName,
        parentDir: cwd,
        repo: entry.repo,
        ref: entry.ref,
        cloneDir: cloneResult.cloneDir,
        metadata: meta,
        variables,
      });
      applySpinner.stop('Template aplicado');
    } catch (err) {
      applySpinner.stop(ansi.red('Falló'));
      clack.log.error(err.message ?? String(err));
      return 'cancelled';
    }

    // Persist the chosen model into the new project's config.
    try {
      const { readConfig, writeConfig } = await import('../core/config.js');
      const cfg = await readConfig(result.projectRoot);
      cfg.model = { provider: model.provider, name: model.name ?? null };
      await writeConfig(result.projectRoot, cfg);
    } catch (err) {
      result.warnings.push(`No pude guardar el provider en el config: ${err.message}`);
    }

    // Summary + warnings.
    const lines = [
      `${ansi.green('✓')} ${result.filesWritten} archivo(s) creado(s).`,
    ];
    if (result.filesSkipped.length) {
      lines.push(`${ansi.yellow('!')} ${result.filesSkipped.length} omitido(s) (ya existían).`);
    }
    if (result.postInstall) {
      if (result.postInstall.ok) {
        lines.push(`${ansi.green('✓')} post-install OK (${result.postInstall.completed} comandos).`);
      } else {
        lines.push(`${ansi.red('✗')} post-install falló en: ${result.postInstall.failedAt}`);
      }
    }
    for (const w of result.warnings) lines.push(`${ansi.yellow('⚠')} ${w}`);
    lines.push('', `Proyecto: ${ansi.dim(result.projectRoot)}`);
    clack.note(lines.join('\n'), 'Listo');

    // Auto-launch Claude Code.
    const { launchForProject } = await import('../commands/launch.js');
    try {
      await launchForProject({ projectRoot: result.projectRoot });
    } catch (err) {
      clack.log.error(
        `No pude abrir Claude Code automáticamente: ${err.message}\n` +
          `Abrilo a mano:\n  cd "${result.projectRoot}"\n  claude`,
      );
    }

    return 'done';
  } finally {
    // Always cleanup the temp clone, regardless of success/failure.
    await cloneResult.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Helpers (clones of the wizard-new pickers — kept here so this file
// is self-contained; the duplication is small.)
// ---------------------------------------------------------------------------

async function pickOllamaCloudModel() {
  const options = [
    ...CLOUD_MODELS.map((m) => ({ value: m.name, label: m.label, hint: m.hint })),
    { value: '__other__', label: 'Otro...', hint: 'Escribir el nombre de cualquier modelo cloud' },
  ];
  const choice = await clack.select({
    message: 'Elegí un modelo cloud',
    options,
    initialValue: 'kimi-k2.6:cloud',
  });
  if (clack.isCancel(choice)) return null;

  if (choice === '__other__') {
    const custom = await clack.text({
      message: 'Nombre del modelo cloud (debe terminar en :cloud)',
      placeholder: 'mi-modelo:cloud',
      validate: (v) =>
        v?.trim().endsWith(':cloud')
          ? undefined
          : 'Los modelos cloud terminan en ":cloud".',
    });
    if (clack.isCancel(custom)) return null;
    return { provider: 'ollama-cloud', name: custom.trim() };
  }
  return { provider: 'ollama-cloud', name: choice };
}

async function pickOllamaLocalModel() {
  const ollama = await detectOllama();
  if (!ollama.installed) {
    clack.log.warn('Ollama no está instalado. El proyecto se va a crear pero vas a tener que instalar Ollama antes de abrirlo.');
  }
  const spinner = clack.spinner();
  spinner.start('Buscando modelos Ollama locales');
  const local = ollama.installed ? await listOllamaModels() : [];
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
  options.push({ value: '__other__', label: 'Otro...', hint: 'Escribir el nombre de cualquier modelo local' });

  const choice = await clack.select({ message: 'Elegí un modelo local', options });
  if (clack.isCancel(choice)) return null;

  let modelName;
  if (choice === '__other__') {
    const custom = await clack.text({
      message: 'Nombre del modelo local',
      placeholder: 'qwen3.5:9b',
      validate: (v) => (v?.trim() ? undefined : 'El nombre es obligatorio'),
    });
    if (clack.isCancel(custom)) return null;
    modelName = custom.trim();
  } else {
    modelName = choice;
  }

  if (ollama.installed && !detectedNames.has(modelName)) {
    const pullConfirm = await clack.confirm({
      message: `¿Descargar ${ansi.cyan(modelName)} ahora? (puede tardar varios minutos)`,
      initialValue: true,
    });
    if (clack.isCancel(pullConfirm)) return null;
    if (pullConfirm) {
      clack.log.info(`Descargando ${modelName}...`);
      const r = await pullOllamaModel(modelName);
      if (!r.ok) clack.log.warn(`Falló la descarga: ${r.message}.`);
      else clack.log.success(`${modelName} listo.`);
    }
  }
  return { provider: 'ollama-local', name: modelName };
}

function providerLabel(p) {
  if (p === 'ollama-cloud') return 'Ollama (cloud)';
  if (p === 'ollama-local') return 'Ollama (local)';
  if (p === 'claude') return 'Claude API';
  return p;
}

function cancelled() {
  clack.cancel('Cancelado.');
  return 'cancelled';
}
