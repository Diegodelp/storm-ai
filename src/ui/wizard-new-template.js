/**
 * Wizard interactivo para `storm new --template`.
 *
 * Flujo:
 *   1. Lista de templates desde el registry (con spinner por la HTTP fetch).
 *   2. Usuario elige uno.
 *   3. Spinner: clonar repo y leer storm-template.json.
 *   4. Preguntar el nombre del proyecto.
 *   5. Preguntar variables del template (las definidas en storm-template.json).
 *   6. Preguntar agent → provider → modelo (igual que el wizard normal).
 *   7. Confirmar.
 *   8. applyTemplateToProject() y guardar agent/provider/modelo en el
 *      proyecto (generando el scaffolding del agent si el template traía
 *      el de otro).
 *   9. Mostrar resumen y abrir el agent.
 *
 * Si el registry está vacío o falla la fetch, devuelve null para que el
 * wizard principal caiga al flujo "desde cero".
 */

import * as clack from '@clack/prompts';
import path from 'node:path';

import { listTemplates } from '../commands/templates.js';
import { fetchTemplate, applyTemplateToProject } from '../commands/new-from-template.js';
import { updateProjectSettings } from '../commands/project.js';
import { getDefaultAgent, getDefaultProvider, getDefaultLaunchCommand } from '../core/global-config.js';
import { agentLabel } from '../core/agents.js';
import { pickLaunchSettings, providerLabel } from './pick-launch.js';
import { detectGit } from '../core/requirements.js';
import * as ansi from './ansi.js';

/**
 * @param {{cwd: string, templateId?: string|null, name?: string|null}} input
 *   templateId: saltea el selector (`storm new --template <id>`).
 *   name: valor inicial del nombre del proyecto.
 * @returns {Promise<'cancelled'|'fallback'|'done'>}
 *   'fallback' = no había templates, el caller debe correr el wizard normal.
 */
export async function runNewFromTemplateWizard({ cwd, templateId = null, name = null }) {
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

  // Pick a template (unless it came from --template).
  if (templateId && !registry.some((t) => t.id === templateId)) {
    clack.log.error(
      `No existe el template "${templateId}". Disponibles: ${registry.map((t) => t.id).join(', ')}.`,
    );
    return 'cancelled';
  }
  const pickedId = templateId ?? await clack.select({
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
      initialValue: name || meta.name,
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

    // Agent → provider → modelo (defaults: config global).
    const defProvider = await getDefaultProvider();
    const launchPick = await pickLaunchSettings({
      agent: await getDefaultAgent(),
      launchCommand: await getDefaultLaunchCommand(),
      provider: defProvider?.provider ?? 'ollama-cloud',
      model: defProvider?.model ?? null,
    });
    if (!launchPick) return cancelled();
    const { model } = launchPick;

    // Confirmation.
    const summary = [
      `Template:     ${ansi.cyan(meta.label)}`,
      `Nombre:       ${ansi.cyan(projectName)}`,
      `Carpeta:      ${ansi.dim(path.resolve(cwd, '.'))}`,
      `CLI:          ${agentLabel(launchPick.agent)}`,
      `Proveedor:    ${providerLabel(model.provider)}${model.name ? ` (${model.name})` : ''}`,
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

    // Persist agent + provider + model into the new project's config.
    // If the template shipped another agent's scaffolding, this also
    // writes the files for the chosen one.
    try {
      const r = await updateProjectSettings(result.projectRoot, {
        agent: launchPick.agent,
        provider: model.provider,
        model: model.name,
        launchCommand: launchPick.launchCommand,
      });
      result.warnings.push(...r.notes);
    } catch (err) {
      result.warnings.push(`No pude guardar agent/provider en el config: ${err.message}`);
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

    // Auto-launch the chosen agent.
    const { launchForProject } = await import('../commands/launch.js');
    try {
      await launchForProject({ projectRoot: result.projectRoot });
    } catch (err) {
      clack.log.error(
        `No pude abrir ${agentLabel(launchPick.agent)} automáticamente: ${err.message}\n` +
          `Abrilo después con:  storm open "${result.projectRoot}"`,
      );
    }

    return 'done';
  } finally {
    // Always cleanup the temp clone, regardless of success/failure.
    await cloneResult.cleanup();
  }
}

function cancelled() {
  clack.cancel('Cancelado.');
  return 'cancelled';
}
