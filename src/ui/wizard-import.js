/**
 * Interactive wizard for `storm import`.
 *
 * Flow:
 *   1. Ask depth (shallow / deep).
 *   2. Resolve provider (use global default; if missing, ask once and save).
 *   3. Spinner while we scan + call the LLM + parse.
 *   4. Editable preview of the analysis.
 *   5. Conflict prompts for any pre-existing storm files.
 *   6. Apply.
 */

import * as clack from '@clack/prompts';
import path from 'node:path';

import {
  analyzeForImport,
  detectConflicts,
  writeImport,
} from '../commands/import.js';
import {
  getDefaultProvider,
  setDefaultProvider,
} from '../core/global-config.js';
import {
  detectOllama,
  CLOUD_MODELS,
  LOCAL_RECOMMENDED,
} from '../core/providers.js';
import { STACKS, DATABASES, getStack, getDatabase } from '../core/stacks.js';
import * as ansi from './ansi.js';

/**
 * @param {{cwd: string, providedPath?: string}} input
 */
export async function runImportWizard(input) {
  clack.intro(ansi.bold('Importar proyecto'));

  const projectRoot = path.resolve(input.cwd, input.providedPath || '.');

  // 1. Profundidad
  const mode = await clack.select({
    message: '¿Qué tan profundo querés analizar?',
    options: [
      {
        value: 'shallow',
        label: 'Rápido (~3s)',
        hint: 'Solo metadata: package.json, README, listado de carpetas',
      },
      {
        value: 'deep',
        label: 'Profundo (~30s)',
        hint: 'Lo anterior + muestras de código fuente. Mejor calidad.',
      },
    ],
    initialValue: 'shallow',
  });
  if (clack.isCancel(mode)) return cancel();

  // 2. Provider
  let provider = await getDefaultProvider();
  if (!provider) {
    provider = await askProvider();
    if (!provider) return cancel();
    await setDefaultProvider(provider);
    clack.log.info(
      `Guardé ${ansi.cyan(provider.provider)} como tu provider por defecto en ` +
        ansi.dim('~/.storm-ai/config.json'),
    );
  } else {
    clack.log.info(
      `Usando provider ${ansi.cyan(provider.provider)}` +
        (provider.model ? ` (${provider.model})` : '') +
        '. ' +
        ansi.dim('Para cambiarlo: --provider <flag>'),
    );
  }

  // 3. Análisis
  const spinner = clack.spinner();
  spinner.start(`Analizando proyecto con ${provider.model || provider.provider}`);
  let analysis;
  try {
    const r = await analyzeForImport({
      cwd: projectRoot,
      mode,
      provider: provider.provider,
      model: provider.model,
    });
    analysis = r.analysis;
    spinner.stop('Análisis completo');
  } catch (err) {
    spinner.stop(ansi.red('Falló el análisis'));
    clack.log.error(err.message ?? String(err));
    if (err?.raw && process.env.STORM_DEBUG) {
      clack.log.info('Respuesta cruda del LLM (debug):');
      console.error(String(err.raw).slice(0, 1500));
    }
    return;
  }

  // 4. Preview editable
  const stackPreset = getStack(analysis.stackId);
  const dbPreset = getDatabase(analysis.databaseId);

  clack.note(
    [
      `${ansi.bold('Sugerencias del análisis')}\n`,
      `Nombre:       ${analysis.name || ansi.dim('(vacío)')}`,
      `Descripción:  ${analysis.description || ansi.dim('(vacío)')}`,
      `Stack:        ${stackPreset?.label ?? analysis.stackId}` +
        (analysis.stackReasoning ? `\n              ${ansi.dim(analysis.stackReasoning)}` : ''),
      `Base datos:   ${dbPreset?.label ?? analysis.databaseId}` +
        (analysis.databaseReasoning ? `\n              ${ansi.dim(analysis.databaseReasoning)}` : ''),
      `Branches:     ${analysis.branches.length} sugerida(s)`,
      `Skills:       ${analysis.skills.length} sugerida(s)`,
      `Agents:       ${analysis.agents.length} sugerido(s)`,
    ].join('\n'),
    'Análisis del LLM',
  );

  // Editable fields.
  const name = await clack.text({
    message: 'Nombre del proyecto',
    initialValue: analysis.name || path.basename(projectRoot),
    validate: (v) => (v?.trim() ? undefined : 'El nombre es obligatorio'),
  });
  if (clack.isCancel(name)) return cancel();

  const description = await clack.text({
    message: 'Descripción',
    initialValue: analysis.description,
  });
  if (clack.isCancel(description)) return cancel();

  const stackId = await clack.select({
    message: 'Stack',
    options: STACKS.map((s) => ({ value: s.id, label: s.label, hint: s.hint })),
    initialValue: analysis.stackId,
  });
  if (clack.isCancel(stackId)) return cancel();

  const databaseId = await clack.select({
    message: 'Base de datos',
    options: DATABASES.map((d) => ({ value: d.id, label: d.label, hint: d.hint })),
    initialValue: analysis.databaseId,
  });
  if (clack.isCancel(databaseId)) return cancel();

  // Branches: multi-select. Defaults all to selected (LLM proposed them).
  let branches = [];
  if (analysis.branches.length > 0) {
    const picked = await clack.multiselect({
      message: 'Branches a registrar',
      options: analysis.branches.map((b) => ({
        value: b.path,
        label: b.path,
        hint: b.description || undefined,
      })),
      initialValues: analysis.branches.map((b) => b.path),
      required: false,
    });
    if (clack.isCancel(picked)) return cancel();
    const set = new Set(picked);
    branches = analysis.branches.filter((b) => set.has(b.path));
  }

  // Skills: multi-select, DEFAULT UNCHECKED (per spec).
  let skills = [];
  if (analysis.skills.length > 0) {
    const picked = await clack.multiselect({
      message: 'Skills custom a crear (desmarcadas por default)',
      options: analysis.skills.map((s) => ({
        value: s.name,
        label: s.name,
        hint: s.description || undefined,
      })),
      initialValues: [], // unchecked
      required: false,
    });
    if (clack.isCancel(picked)) return cancel();
    const set = new Set(picked);
    skills = analysis.skills.filter((s) => set.has(s.name));
  }

  // Agents: idem.
  let agents = [];
  if (analysis.agents.length > 0) {
    const picked = await clack.multiselect({
      message: 'Agents a crear (desmarcados por default)',
      options: analysis.agents.map((a) => ({
        value: a.slash,
        label: a.name,
        hint: a.description || `/${a.slash}`,
      })),
      initialValues: [],
      required: false,
    });
    if (clack.isCancel(picked)) return cancel();
    const set = new Set(picked);
    agents = analysis.agents.filter((a) => set.has(a.slash));
  }

  // 5. Conflictos: para cada archivo storm pre-existente, preguntar si pisar.
  const conflicts = await detectConflicts(projectRoot);
  const overrides = { overwriteClaudeMd: true, overwriteConfig: true, overwriteTasks: true };

  if (conflicts.config) {
    const ok = await clack.confirm({
      message: `Ya existe ${ansi.cyan('project.config.json')}. ¿Pisar?`,
      initialValue: false,
    });
    if (clack.isCancel(ok)) return cancel();
    overrides.overwriteConfig = ok;
  }
  if (conflicts.claudeMd) {
    const ok = await clack.confirm({
      message: `Ya existe ${ansi.cyan('CLAUDE.md')}. ¿Pisar?`,
      initialValue: false,
    });
    if (clack.isCancel(ok)) return cancel();
    overrides.overwriteClaudeMd = ok;
  }
  if (conflicts.tasks) {
    const ok = await clack.confirm({
      message: `Ya existe ${ansi.cyan('TASKS.md')}. ¿Pisar?`,
      initialValue: false,
    });
    if (clack.isCancel(ok)) return cancel();
    overrides.overwriteTasks = ok;
  }

  // 6. Aplicar
  const confirmAll = await clack.confirm({
    message: '¿Aplicar el scaffolding ahora?',
    initialValue: true,
  });
  if (clack.isCancel(confirmAll) || !confirmAll) return cancel();

  const applySpinner = clack.spinner();
  applySpinner.start('Escribiendo archivos');
  let result;
  try {
    result = await writeImport({
      projectRoot,
      name,
      description: description || '',
      stackId,
      databaseId,
      model: provider, // store the same provider for this project
      branches,
      skills,
      agents,
      ...overrides,
    });
    applySpinner.stop('Listo');
  } catch (err) {
    applySpinner.stop(ansi.red('Falló'));
    clack.log.error(err.message ?? String(err));
    return;
  }

  // Resumen final.
  const summary = [
    `${ansi.green('✓')} ${result.createdFiles.length} archivo(s) creado(s).`,
  ];
  if (result.skippedFiles.length) {
    summary.push(`${ansi.yellow('!')} ${result.skippedFiles.length} archivo(s) preservado(s) (no se pisaron).`);
  }
  for (const w of result.warnings) {
    summary.push(`${ansi.yellow('⚠')} ${w}`);
  }
  summary.push('', `Proyecto: ${ansi.dim(result.projectRoot)}`);
  clack.note(summary.join('\n'), 'Import completo');
}

// ---------------------------------------------------------------------------

async function askProvider() {
  const providerChoice = await clack.select({
    message: 'Primer uso. ¿Qué proveedor de IA querés usar?',
    options: [
      { value: 'ollama-cloud', label: 'Ollama (cloud)', hint: 'Gratis, calidad Claude. Recomendado.' },
      { value: 'ollama-local', label: 'Ollama (local)', hint: 'Corre en tu máquina.' },
      { value: 'claude',       label: 'Claude API',     hint: 'Requiere ANTHROPIC_API_KEY.' },
    ],
    initialValue: 'ollama-cloud',
  });
  if (clack.isCancel(providerChoice)) return null;

  if (providerChoice === 'claude') {
    return { provider: 'claude', model: null };
  }
  if (providerChoice === 'ollama-cloud') {
    const m = await clack.select({
      message: 'Modelo cloud',
      options: CLOUD_MODELS.map((x) => ({ value: x.name, label: x.label, hint: x.hint })),
      initialValue: 'kimi-k2.6:cloud',
    });
    if (clack.isCancel(m)) return null;
    return { provider: 'ollama-cloud', model: m };
  }
  // ollama-local
  const status = await detectOllama();
  if (!status.installed) {
    clack.log.warn('Ollama no está instalado en tu máquina. Instalalo y volvé a probar.');
    return null;
  }
  const m = await clack.select({
    message: 'Modelo local',
    options: LOCAL_RECOMMENDED.map((x) => ({ value: x.name, label: x.label, hint: x.hint })),
  });
  if (clack.isCancel(m)) return null;
  return { provider: 'ollama-local', model: m };
}

function cancel() {
  clack.cancel('Cancelado.');
}
