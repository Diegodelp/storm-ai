/**
 * Selector interactivo de proyectos.
 *
 * Escanea las carpetas por defecto, deja al usuario elegir, muestra con
 * qué CLI/provider/modelo se va a abrir y permite abrirlo o cambiar esa
 * configuración (que es del proyecto, no global).
 */

import * as clack from '@clack/prompts';

import { discover } from '../commands/open.js';
import { launchForProject } from '../commands/launch.js';
import { validateProjectSettings } from '../commands/project.js';
import { readConfig } from '../core/config.js';
import { getAgent } from '../core/agents.js';
import { runProjectSettingsWizard } from './wizard-project.js';
import * as ansi from './ansi.js';

export async function runOpenWizard(_input = {}, {
  discoverProjects = discover,
  launchProject = launchForProject,
  loadConfig = readConfig,
  editSettings = runProjectSettingsWizard,
  ui = clack,
} = {}) {
  ui.intro(ansi.bold('Seleccionar proyecto'));
  ui.log.info(ansi.dim('Tip: presioná Esc en cualquier momento para volver al menú.'));

  const spinner = ui.spinner();
  spinner.start('Buscando proyectos storm');
  let found;
  try {
    found = await discoverProjects({});
  } catch (err) {
    spinner.stop('Falló la búsqueda de proyectos');
    throw err;
  }
  spinner.stop(`Encontrados: ${found.length}`);

  if (found.length === 0) {
    ui.log.warn(
      'No se encontraron proyectos en las carpetas habituales (Desktop, Documents, Projects, code, dev).',
    );
    ui.log.info('Creá uno con "Crear proyecto" o corré: storm new <nombre>');
    return 'empty';
  }

  const choice = await ui.select({
    message: 'Elegí un proyecto',
    options: found.map((p) => ({
      value: p.root,
      label: p.name,
      hint: p.root,
    })),
  });
  if (ui.isCancel(choice)) {
    ui.cancel('Cancelado.');
    return 'cancelled';
  }

  const picked = found.find((p) => p.root === choice);
  if (!picked) throw new Error('No se encontró el proyecto seleccionado. Volvé a buscarlo.');

  const fail = (err) => new Error(
    `No pude abrir el proyecto "${picked.name}".\n` +
      `${err?.message ?? String(err)}\n\n` +
      `Para reintentar:\n  cd "${picked.root}"\n  storm launch\n` +
      'Para cambiar agent/provider/modelo:  storm project  (o "Cambiar..." en este menú)',
    { cause: err },
  );

  while (true) {
    let config;
    try {
      config = await loadConfig(picked.root);
    } catch (err) {
      throw fail(err);
    }
    const agent = getAgent(config.agent)?.label ?? config.agent;
    const launcher = config.launch?.customCommand ? 'comando personalizado' : agent;
    const problem = validateProjectSettings({
      provider: config.model.provider,
      model: config.model.name ?? null,
      agent: config.agent,
      launchCommand: config.launch?.customCommand ?? null,
    });
    ui.note(
      `${ansi.bold(picked.name)}\n${ansi.dim(picked.root)}\n` +
        `CLI: ${launcher}\nProvider: ${config.model.provider}\n` +
        `Modelo: ${config.model.name ?? 'automático'}` +
        (problem ? `\n\n${ansi.yellow('⚠ ' + problem)}` : ''),
      'Seleccionado',
    );

    const action = await ui.select({
      message: '¿Qué hacemos?',
      options: [
        { value: 'open', label: `Abrir con ${launcher}` },
        { value: 'settings', label: 'Cambiar agent / provider / modelo de este proyecto' },
        { value: 'back', label: '← Volver' },
      ],
    });
    if (ui.isCancel(action) || action === 'back') return 'cancelled';

    if (action === 'settings') {
      await editSettings({ projectRoot: picked.root });
      continue;
    }

    ui.log.info(`Abriendo ${launcher}...`);
    try {
      await launchProject({ projectRoot: picked.root });
    } catch (err) {
      throw fail(err);
    }
    ui.log.info(`${launcher} finalizó. Proyecto: ${picked.name}.`);
    return 'done';
  }
}
