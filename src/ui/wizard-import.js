/**
 * Interactive wizard for `storm import`.
 *
 * Flow:
 *   1. Ask depth (shallow / deep).
 *   2. Resolve the ANALYSIS provider (global default, or pick another one
 *      for this run; if there's no default, ask once and save it).
 *   3. Spinner while we scan + call the LLM + parse.
 *   4. Editable preview of the analysis.
 *   5. Agent → provider → model the project will be LAUNCHED with.
 *   6. Conflict prompts for any pre-existing storm files.
 *   7. Apply.
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
  getDefaultAgent,
  getDefaultLaunchCommand,
} from '../core/global-config.js';
import { agentLabel, getInstructionsFile } from '../core/agents.js';
import { pickLaunchSettings, pickProvider, pickModel, providerLabel } from './pick-launch.js';
import { STACKS, DATABASES, getStack, getDatabase } from '../core/stacks.js';
import * as ansi from './ansi.js';

/**
 * @param {{cwd: string, providedPath?: string}} input
 */
export async function runImportWizard(input) {
  clack.intro(ansi.bold('Importar proyecto'));
  clack.log.info(ansi.dim('Tip: presioná Esc en cualquier momento para volver al menú.'));

  const projectRoot = path.resolve(input.cwd, input.providedPath || '.');

  // 1. Profundidad
  const mode = await clack.select({
    message: '¿Qué tan profundo querés analizar? (Esc para volver al menú)',
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
      { value: '__back__', label: '← Volver al menú principal' },
    ],
  });
  if (clack.isCancel(mode) || mode === '__back__') return cancel();

  // 2. Provider para el ANÁLISIS (no es necesariamente con el que se
  // va a abrir el proyecto; eso se elige en el paso 5).
  let provider = await getDefaultProvider();
  if (!provider) {
    clack.log.info('Primer uso: elegí con qué IA analizar proyectos.');
    provider = await askProvider();
    if (!provider) return cancel();
    await setDefaultProvider(provider);
    clack.log.info(
      `Guardé ${ansi.cyan(provider.provider)} como tu provider por defecto en ` +
        ansi.dim('~/.storm-ai/config.json'),
    );
  } else {
    const current = providerLabel(provider.provider) + (provider.model ? ` (${provider.model})` : '');
    const which = await clack.select({
      message: 'Provider para analizar el proyecto',
      options: [
        { value: 'default', label: `Usar ${current}`, hint: 'default de storm config' },
        { value: 'other', label: 'Elegir otro para este análisis' },
      ],
    });
    if (clack.isCancel(which)) return cancel();
    if (which === 'other') {
      provider = await askProvider(provider);
      if (!provider) return cancel();
    }
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

  // 5. Con qué se va a ABRIR el proyecto. Arranca desde el provider de
  // análisis (si puede lanzar el agent elegido).
  clack.log.info('Ahora elegí con qué vas a trabajar en este proyecto.');
  const launchPick = await pickLaunchSettings({
    agent: await getDefaultAgent(),
    launchCommand: await getDefaultLaunchCommand(),
    provider: provider.provider,
    model: provider.model,
  });
  if (!launchPick) return cancel();

  // 6. Conflictos: para cada archivo storm pre-existente, preguntar si pisar.
  const conflicts = await detectConflicts(projectRoot);
  const instructionsFile = getInstructionsFile(launchPick.agent);
  const instructionsExists = instructionsFile === 'CLAUDE.md' ? conflicts.claudeMd : conflicts.agentsMd;
  const overrides = { overwriteClaudeMd: true, overwriteConfig: true, overwriteTasks: true };

  if (conflicts.config) {
    const ok = await clack.confirm({
      message: `Ya existe ${ansi.cyan('project.config.json')}. ¿Pisar?`,
      initialValue: false,
    });
    if (clack.isCancel(ok)) return cancel();
    overrides.overwriteConfig = ok;
  }
  if (instructionsExists) {
    const ok = await clack.confirm({
      message: `Ya existe ${ansi.cyan(instructionsFile)}. ¿Pisar?`,
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

  // 7. Aplicar
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
      model: launchPick.model,
      agent: launchPick.agent,
      launch: launchPick.launchCommand ? { customCommand: launchPick.launchCommand } : {},
      // Same provider as the analysis classifies every function into sections.
      analysis: { provider: provider.provider, model: provider.model },
      onFunctionProgress: (done, total) => applySpinner.message(`Clasificando funciones con IA: ${done}/${total}`),
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
  if (result.functions) {
    summary.push(
      `${ansi.green('✓')} ${result.functions.total} función(es) con #ID en ` +
        `${result.functions.sections} sección(es) → ${ansi.dim('.context-compact/sections/')}`,
    );
  }
  summary.push(
    '',
    `Se abre con:  ${agentLabel(launchPick.agent)} · ${providerLabel(launchPick.model.provider)}` +
      (launchPick.model.name ? ` (${launchPick.model.name})` : ''),
    `Proyecto: ${ansi.dim(result.projectRoot)}`,
  );
  clack.note(summary.join('\n'), 'Import completo');
}

// ---------------------------------------------------------------------------

/**
 * Pick the provider (and model) to ANALYZE with. Any provider works here,
 * including the via-* ones.
 * @param {{provider: string, model: string|null}} [current]
 * @returns {Promise<{provider: string, model: string|null}|null>}
 */
async function askProvider(current) {
  const p = await pickProvider({
    message: '¿Con qué proveedor de IA analizar?',
    initialValue: current?.provider ?? 'ollama-cloud',
  });
  if (!p) return null;
  const m = await pickModel(p, {
    initialValue: p === current?.provider ? current.model : null,
    offerPull: true,
  });
  if (!m) return null;
  return { provider: p, model: m.name };
}

function cancel() {
  clack.cancel('Cancelado.');
}
